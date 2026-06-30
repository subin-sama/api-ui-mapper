const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const { generateMockFromType } = require('./mock-generator');

// Resolve the name of the function that encloses a node, covering named
// declarations, arrows assigned to vars/object-props/class-props, and
// class/object method shorthand (where getFunctionParent() returns the
// method node itself, so we must read its key rather than its parent).
function getEnclosingFuncName(parentFunc) {
  if (!parentFunc) return null;
  const node = parentFunc.node;

  // `handleSubmit() {}` (ClassMethod) or `{ handleLogin() {} }` (ObjectMethod)
  if ((node.type === 'ClassMethod' || node.type === 'ObjectMethod') && node.key) {
    return node.key.type === 'Identifier' ? node.key.name : null;
  }

  // `function handleSubmit() {}` / named function expression
  if (node.id && node.id.type === 'Identifier') return node.id.name;

  const parent = parentFunc.parent;
  if (!parent) return null;

  // `const handleSubmit = () => {}`
  if (parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier') {
    return parent.id.name;
  }
  // `{ handleSubmit: () => {} }`
  if (parent.type === 'ObjectProperty' && parent.key.type === 'Identifier') {
    return parent.key.name;
  }
  // `handleSubmit = () => {}` as a class field
  if ((parent.type === 'ClassProperty' || parent.type === 'PropertyDefinition' ||
       parent.type === 'ClassPrivateProperty') && parent.key && parent.key.type === 'Identifier') {
    return parent.key.name;
  }
  return null;
}

const NAV_FUNCS = new Set(['navigate', 'push', 'replace', 'reset']);

const LAYOUT_PROPS = [
  'flex', 'flexDirection', 'justifyContent', 'alignItems', 'padH', 'padV', 'pad',
  'marginT', 'marginB', 'marginL', 'marginR', 'margin', 'bg', 'layoutH', 'layoutV', 'textAlign'
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BABEL_PARSE_OPTS = {
  sourceType: 'module',
  plugins: ['jsx', ['typescript', { isTSX: true, allExtensions: true }], 'classProperties', 'decorators-legacy']
};

// Component names that the wireframe already renders as a leaf element — don't
// expand into their internals (avoids nesting a button inside a button, etc.).
const LEAF_LIKE_RE = /(button|btn|touchable|pressable|input|textfield|searchbar|image|avatar|icon|logo|thumbnail|text|label|title|checkbox|switch|radio|badge|chip)/i;

// Map local import name -> { source, imported } from an AST's import declarations.
function importMapOf(ast) {
  const map = {};
  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue;
    const source = node.source.value;
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') {
        if (!map[spec.local.name]) map[spec.local.name] = { source, imported: 'default' };
      } else if (spec.type === 'ImportSpecifier') {
        if (!map[spec.local.name]) map[spec.local.name] = { source, imported: spec.imported.name || spec.imported.value };
      }
    }
  }
  return map;
}

// Extract layout hints from styled-components (e.g. styled.View`flex-direction: row`)
// so a row container like a pin pad renders as a row, not a stack.
function styledLayoutMap(code) {
  const map = {};
  const re = /(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*styled[\s\S]*?`([\s\S]*?)`/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const css = m[2];
    const hints = {};
    if (/flex-direction\s*:\s*row/i.test(css)) hints.flexDirection = 'row';
    else if (/flex-direction\s*:\s*column/i.test(css)) hints.flexDirection = 'column';
    if (/justify-content\s*:\s*center/i.test(css)) hints.justifyContent = 'center';
    if (/align-items\s*:\s*center/i.test(css)) hints.alignItems = 'center';
    if (Object.keys(hints).length) map[m[1]] = hints;
  }
  return map;
}

// Map enclosing-function names to the APIs / navigations they call.
function buildFuncMaps(ast, apiSet) {
  const functionApiMap = {}, functionNavMap = {};
  traverse(ast, {
    CallExpression(path) {
      let callee = null;
      if (path.node.callee.type === 'Identifier') callee = path.node.callee.name;
      else if (path.node.callee.type === 'MemberExpression') callee = path.node.callee.property.name;
      if (!callee) return;
      if (NAV_FUNCS.has(callee) && path.node.arguments.length > 0 && path.node.arguments[0].type === 'StringLiteral') {
        const fn = getEnclosingFuncName(path.getFunctionParent());
        if (fn) (functionNavMap[fn] = functionNavMap[fn] || new Set()).add(path.node.arguments[0].value);
      }
      if (apiSet.has(callee)) {
        const fn = getEnclosingFuncName(path.getFunctionParent());
        if (fn) (functionApiMap[fn] = functionApiMap[fn] || new Set()).add(callee);
      }
    }
  });
  return { functionApiMap, functionNavMap };
}

// Collect every JSX-returning expression in a file (largest one is the screen).
function collectJSXReturns(ast) {
  const trees = [];
  traverse(ast, {
    ReturnStatement(path) { const a = path.node.argument; if (a && (a.type === 'JSXElement' || a.type === 'JSXFragment')) trees.push(a); },
    ArrowFunctionExpression(path) { const b = path.node.body; if (b && (b.type === 'JSXElement' || b.type === 'JSXFragment')) trees.push(b); }
  });
  return trees;
}

// The JSX returned by the largest own-return of a function node (skips nested fns).
function findReturnedJSX(fnNode) {
  if (!fnNode) return null;
  if (fnNode.type === 'ArrowFunctionExpression' && fnNode.body &&
      (fnNode.body.type === 'JSXElement' || fnNode.body.type === 'JSXFragment')) return fnNode.body;
  const candidates = [];
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n.type) return;
    if (n !== fnNode && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')) return;
    if (n.type === 'ReturnStatement' && n.argument && (n.argument.type === 'JSXElement' || n.argument.type === 'JSXFragment')) candidates.push(n.argument);
    for (const k in n) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range' || k === 'leadingComments' || k === 'trailingComments' || k === 'comments' || k === 'extra') continue;
      const v = n[k]; if (v && typeof v === 'object') walk(v);
    }
  }
  walk(fnNode.body);
  if (!candidates.length) return null;
  const size = (j) => { let c = 1; if (j.children) j.children.forEach(ch => { if (ch.type === 'JSXElement' || ch.type === 'JSXFragment') c += size(ch); }); return c; };
  candidates.sort((a, b) => size(b) - size(a));
  return candidates[0];
}

// Find the JSX of a specific exported component (default or named).
function findComponentJSX(ast, importedName) {
  let targetName = null, inlineFn = null;
  if (importedName === 'default') {
    traverse(ast, { ExportDefaultDeclaration(p) {
      const d = p.node.declaration;
      if (d.type === 'Identifier') targetName = d.name;
      else if (d.type === 'FunctionDeclaration' || d.type === 'ArrowFunctionExpression' || d.type === 'FunctionExpression') inlineFn = d;
      p.stop();
    }});
  } else {
    targetName = importedName;
  }
  if (inlineFn) return findReturnedJSX(inlineFn);
  if (!targetName) return null;
  let fn = null;
  traverse(ast, {
    FunctionDeclaration(p) { if (p.node.id && p.node.id.name === targetName) { fn = p.node; p.stop(); } },
    VariableDeclarator(p) {
      if (p.node.id && p.node.id.name === targetName && p.node.init &&
          (p.node.init.type === 'ArrowFunctionExpression' || p.node.init.type === 'FunctionExpression')) { fn = p.node.init; p.stop(); }
    }
  });
  return fn ? findReturnedJSX(fn) : null;
}

function findCallsInExpr(node, ctx, apiCalls, navCalls) {
  if (!node) return;
  if (node.type === 'CallExpression') {
    let cName = null;
    if (node.callee.type === 'Identifier') cName = node.callee.name;
    else if (node.callee.type === 'MemberExpression') cName = node.callee.property.name;
    if (cName) {
      if (ctx.apiSet.has(cName)) apiCalls.add(cName);
      if (ctx.functionApiMap[cName]) ctx.functionApiMap[cName].forEach(a => apiCalls.add(a));
      if (NAV_FUNCS.has(cName) && node.arguments.length > 0 && node.arguments[0].type === 'StringLiteral') {
        if (navCalls) navCalls.add(node.arguments[0].value);
      }
      if (ctx.functionNavMap[cName]) ctx.functionNavMap[cName].forEach(nv => { if (navCalls) navCalls.add(nv); });
    }
    node.arguments.forEach(a => findCallsInExpr(a, ctx, apiCalls, navCalls));
  } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    findCallsInExpr(node.body, ctx, apiCalls, navCalls);
  } else if (node.type === 'BlockStatement') {
    node.body.forEach(s => findCallsInExpr(s, ctx, apiCalls, navCalls));
  } else if (node.type === 'ExpressionStatement') {
    findCallsInExpr(node.expression, ctx, apiCalls, navCalls);
  }
}

// Build a UI node from a JSX node. ctx carries the api/nav maps and a
// resolveComp(tagName) that inlines a local custom component's wireframe.
function buildNode(jsxNode, ctx) {
  if (jsxNode.type === 'JSXElement') {
    const nameNode = jsxNode.openingElement.name;
    let tagName = 'Unknown';
    if (nameNode.type === 'JSXIdentifier') tagName = nameNode.name;
    else if (nameNode.type === 'JSXMemberExpression') tagName = nameNode.object.name + '.' + nameNode.property.name;

    const apiCalls = new Set(), navCalls = new Set(), layoutProps = {};
    const attributes = jsxNode.openingElement.attributes || [];
    for (const attr of attributes) {
      if (attr.type !== 'JSXAttribute') continue;
      const attrName = attr.name.name;
      if (LAYOUT_PROPS.includes(attrName) && attr.value) {
        if (attr.value.type === 'StringLiteral') layoutProps[attrName] = attr.value.value;
        else if (attr.value.type === 'JSXExpressionContainer' &&
                 (attr.value.expression.type === 'NumericLiteral' || attr.value.expression.type === 'StringLiteral')) {
          layoutProps[attrName] = attr.value.expression.value;
        }
      }
      if (attr.value && attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression;
        if (expr.type === 'Identifier') {
          if (ctx.functionApiMap[expr.name]) ctx.functionApiMap[expr.name].forEach(a => apiCalls.add(a));
          if (ctx.apiSet.has(expr.name)) apiCalls.add(expr.name);
          if (ctx.functionNavMap[expr.name]) ctx.functionNavMap[expr.name].forEach(n => navCalls.add(n));
        } else {
          findCallsInExpr(expr, ctx, apiCalls, navCalls);
        }
      }
    }

    // Apply styled-component layout hints (e.g. a row container) as defaults.
    if (ctx.styledMap && ctx.styledMap[tagName]) {
      const h = ctx.styledMap[tagName];
      for (const k in h) if (layoutProps[k] === undefined) layoutProps[k] = h[k];
    }

    const node = { tagName, children: [], apiCalls: Array.from(apiCalls), navCalls: Array.from(navCalls), layoutProps };

    // Inline a local custom component's own wireframe (unless it already reads
    // as a leaf element like a Button/Text).
    if (ctx.resolveComp && /^[A-Z][A-Za-z0-9_]*$/.test(tagName) && !LEAF_LIKE_RE.test(tagName)) {
      const inlined = ctx.resolveComp(tagName);
      if (inlined && inlined.length) { node.expanded = true; inlined.forEach(c => node.children.push(c)); }
    }

    for (const child of jsxNode.children) {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        const c = buildNode(child, ctx); if (c) node.children.push(c);
      } else if (child.type === 'JSXText') {
        const t = child.value.trim(); if (t) node.children.push({ tagName: 'TEXT_LITERAL', text: t });
      }
    }
    return node;
  } else if (jsxNode.type === 'JSXFragment') {
    const node = { tagName: 'Fragment', children: [] };
    for (const child of jsxNode.children) {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') { const c = buildNode(child, ctx); if (c) node.children.push(c); }
      else if (child.type === 'JSXText') { const t = child.value.trim(); if (t) node.children.push({ tagName: 'TEXT_LITERAL', text: t }); }
    }
    return node;
  }
  return null;
}

// Builds screen UI trees, inlining local custom components recursively. A single
// instance is shared across a run so each component file is parsed/expanded once.
function createComponentExpander(srcDir, apiNamesArr) {
  const apiSet = new Set(apiNamesArr);
  const astCache = {};   // file -> ast | null
  const compCache = {};  // `${file}::${imported}` -> tree array
  const PENDING = '__PENDING__';
  const MAX_DEPTH = 4;

  function astOf(file) {
    if (file in astCache) return astCache[file];
    let entry = { ast: null, styledMap: {} };
    try {
      const code = fs.readFileSync(file, 'utf8');
      entry = { ast: parser.parse(code, BABEL_PARSE_OPTS), styledMap: styledLayoutMap(code) };
    } catch (e) { /* keep null */ }
    astCache[file] = entry;
    return entry;
  }

  function makeResolver(file, importMap, depth) {
    return (tagName) => {
      const entry = importMap[tagName];
      if (!entry) return null;
      const childFile = resolveImportPath(file, entry.source, srcDir);
      if (!childFile) return null;
      return expand(childFile, entry.imported, depth + 1);
    };
  }

  function expand(file, importedName, depth) {
    const key = file + '::' + importedName;
    if (compCache[key] === PENDING) return [];   // cycle
    if (compCache[key] !== undefined) return compCache[key];
    if (depth > MAX_DEPTH) return [];
    compCache[key] = PENDING;
    let result = [];
    const { ast, styledMap } = astOf(file);
    if (ast) {
      try {
        const jsx = findComponentJSX(ast, importedName);
        if (jsx) {
          const importMap = importMapOf(ast);
          const { functionApiMap, functionNavMap } = buildFuncMaps(ast, apiSet);
          const ctx = { apiSet, functionApiMap, functionNavMap, styledMap, resolveComp: makeResolver(file, importMap, depth) };
          const node = buildNode(jsx, ctx);
          if (node) result = [node];
        }
      } catch (e) { result = []; }
    }
    compCache[key] = result;
    return result;
  }

  function expandScreen(code, filePath) {
    try {
      const ast = parser.parse(code, BABEL_PARSE_OPTS);
      const importMap = importMapOf(ast);
      const { functionApiMap, functionNavMap } = buildFuncMaps(ast, apiSet);
      const ctx = { apiSet, functionApiMap, functionNavMap, styledMap: styledLayoutMap(code), resolveComp: makeResolver(filePath, importMap, 0) };
      const trees = [];
      collectJSXReturns(ast).forEach(jsx => { const t = buildNode(jsx, ctx); if (t) trees.push(t); });
      if (!trees.length) return [];
      const count = (n) => { let c = 1; if (n.children) n.children.forEach(ch => c += count(ch)); return c; };
      trees.sort((a, b) => count(b) - count(a));
      return [trees[0]];
    } catch (e) { return []; }
  }

  return { expandScreen };
}
// Helper to recursively list files
function getFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const name = path.join(dir, file);
    if (fs.statSync(name).isDirectory()) {
      getFiles(name, fileList);
    } else {
      if (name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.js') || name.endsWith('.jsx')) {
        fileList.push(name);
      }
    }
  }
  return fileList;
}

// Tokens that read as "success" — preferred when a field is compared against
// several values, so the mock represents the happy path.
const SUCCESS_TOKENS = new Set([
  '00', '000', '0000', '0', '200', '201', 'success', 'ok', 'true',
  'completed', 'complete', 'approved', 'done', 'pass', 'passed', 'yes', 'y', 'active', 'valid'
]);

// Scan the codebase for the values fields are compared against (e.g.
// `res.responseCode === '00'`) so mocks use what the app actually checks rather
// than a generic guess. Returns fieldName -> { str, num } (success-biased).
function collectFieldHints(srcDir) {
  const str = {}, num = {};
  const bump = (bag, field, value) => {
    if (!field || value === '' || value == null) return;
    (bag[field] = bag[field] || {});
    bag[field][value] = (bag[field][value] || 0) + 1;
  };
  const strRe = /\.([A-Za-z_$][\w$]*)\s*[!=]==?\s*(['"])([^'"]*)\2/g;                 // .field === 'val'
  const strRevRe = /(['"])([^'"]*)\1\s*[!=]==?\s*[\w.$[\]]*?\.([A-Za-z_$][\w$]*)\b/g;  // 'val' === x.field
  const numRe = /\.([A-Za-z_$][\w$]*)\s*[!=]==?\s*(-?\d+(?:\.\d+)?)\b/g;               // .field === 200
  getFiles(srcDir).forEach(f => {
    let code; try { code = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
    let m;
    strRe.lastIndex = strRevRe.lastIndex = numRe.lastIndex = 0;
    while ((m = strRe.exec(code)) !== null) bump(str, m[1], m[3]);
    while ((m = strRevRe.exec(code)) !== null) bump(str, m[3], m[2]);
    while ((m = numRe.exec(code)) !== null) bump(num, m[1], m[2]);
  });
  const pick = (bag) => {
    const out = {};
    for (const field in bag) {
      const entries = Object.entries(bag[field]);
      const succ = entries.filter(([v]) => SUCCESS_TOKENS.has(String(v).toLowerCase()));
      const pool = succ.length ? succ : entries;
      pool.sort((a, b) => b[1] - a[1]);
      out[field] = pool[0][0];
    }
    return out;
  };
  const bestStr = pick(str), bestNum = pick(num);
  const hints = {};
  new Set([...Object.keys(bestStr), ...Object.keys(bestNum)]).forEach(f => {
    hints[f] = { str: bestStr[f], num: bestNum[f] };
  });
  return hints;
}

// Helper to extract nested brace blocks
function extractBraceBlock(text, startIndex) {
  let braceCount = 0;
  let started = false;
  for (let i = startIndex; i < text.length; i++) {
    if (text[i] === '{') {
      braceCount++;
      started = true;
    } else if (text[i] === '}') {
      braceCount--;
    }
    if (started && braceCount === 0) {
      return text.substring(startIndex, i + 1);
    }
  }
  return null;
}

// Scan a balanced (...) starting at the '(' at openIndex.
function extractParenBlock(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { content: text.substring(openIndex + 1, i), endIndex: i };
    }
  }
  return null;
}

// Split a string on a separator char, ignoring separators nested inside
// (), {}, [], <> or string/template literals. Treats `=>` so the arrow's
// `>` does not unbalance angle-bracket depth.
function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0, cur = '', inStr = null, prev = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      cur += ch;
      if (ch === inStr) inStr = null;
      prev = ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; prev = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[' || ch === '<') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === '>' && prev !== '=') depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; prev = ch; continue; }
    cur += ch;
    prev = ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function indexOfTopLevel(str, target) {
  let depth = 0, inStr = null, prev = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) { if (ch === inStr) inStr = null; prev = ch; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; prev = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[' || ch === '<') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === '>' && prev !== '=') depth--;
    else if (ch === target && depth === 0) return i;
    prev = ch;
  }
  return -1;
}

const TS_PRIMITIVES = new Set([
  'string', 'number', 'boolean', 'any', 'void', 'null', 'undefined',
  'unknown', 'never', 'object', 'Promise', 'Date', 'symbol', 'bigint'
]);

// Reduce a type annotation (e.g. `Promise<User[]>`, `Foo | null`, `Bar[]`,
// `Array<Baz>`) to the base named type, or '' if it is a primitive/inline object.
function reduceToNamedType(ann) {
  if (!ann) return '';
  let t = ann.trim();
  // Unwrap Promise<...> (outermost)
  const promise = /^Promise\s*<([\s\S]*)>\s*$/.exec(t);
  if (promise) t = promise[1].trim();
  // Unwrap Array<...>
  const arr = /^Array\s*<([\s\S]*)>\s*$/.exec(t);
  if (arr) t = arr[1].trim();
  // Take first member of a union
  t = splitTopLevel(t, '|')[0].trim();
  // Strip trailing [] (possibly repeated)
  t = t.replace(/(\s*\[\s*\])+$/, '').trim();
  if (t.startsWith('{') || t.startsWith('(')) return ''; // inline object / function type
  const m = /^([A-Za-z_$][\w$]*)/.exec(t);
  if (!m) return '';
  return TS_PRIMITIVES.has(m[1]) ? '' : m[1];
}

// Pick the request DTO type: the first parameter whose annotation reduces to a
// named (non-primitive) type. Falls back to '' when all params are primitives
// or inline objects, which is more useful than reporting a stray primitive.
function extractReqType(params) {
  if (!params) return '';
  for (const part of splitTopLevel(params, ',')) {
    const colon = indexOfTopLevel(part, ':');
    if (colon === -1) continue;
    let ann = part.slice(colon + 1).trim();
    const eq = indexOfTopLevel(ann, '='); // strip default value
    if (eq !== -1) ann = ann.slice(0, eq).trim();
    const named = reduceToNamedType(ann);
    if (named) return named;
  }
  return '';
}

// Parse a function signature out of a body slice using paren-balanced scanning
// (robust to arrays/unions/inline objects/nested generics in the return type).
function parseSignature(funcBody) {
  const arrowHead = /(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/.exec(funcBody);
  const funcHead = /(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/.exec(funcBody);
  let openIdx = -1, isArrow = false;
  if (arrowHead) { openIdx = arrowHead.index + arrowHead[0].length - 1; isArrow = true; }
  else if (funcHead) { openIdx = funcHead.index + funcHead[0].length - 1; isArrow = false; }
  if (openIdx === -1) return { params: '', retType: '' };

  const paren = extractParenBlock(funcBody, openIdx);
  if (!paren) return { params: '', retType: '' };
  const params = paren.content.trim();

  let retType = '';
  const rest = funcBody.slice(paren.endIndex + 1);
  const stop = isArrow ? rest.indexOf('=>') : rest.indexOf('{');
  let between = (stop === -1 ? rest : rest.slice(0, stop)).trim();
  if (between.startsWith(':')) retType = between.slice(1).trim();
  return { params, retType };
}

function cleanRawUrl(rawUrl) {
  let url = rawUrl.trim();
  const isStringLiteral = (url.startsWith('`') || url.startsWith("'") || url.startsWith('"'));

  // A bare identifier/member expression (e.g. `request.get(endpoint)`) is a
  // runtime variable, not a literal URL — don't fabricate `/endpoint`.
  if (!isStringLiteral && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(url)) {
    return { endpoint: '(dynamic)', baseUrl: '' };
  }

  if ((url.startsWith('`') && url.endsWith('`')) ||
      (url.startsWith("'") && url.endsWith("'")) ||
      (url.startsWith('"') && url.endsWith('"'))) {
    url = url.slice(1, -1);
  }

  let baseUrl = '';
  const match = url.match(/\$\{?(Config\.[A-Z0-9_]+)\}?/);
  if (match) {
    baseUrl = match[1];
  }
  
  url = url.replace(/\$\{?Config\.[A-Z0-9_]+\}?/g, '');
  url = url.replace(/^\}/, '');
  if (url.includes('?')) {
    url = url.split('?')[0];
  }
  url = url.replace(/\$\{[^}]+\}/g, ':param');
  url = url.replace(/['"`]/g, '').trim();
  if (url.length > 0 && !url.startsWith('/') && !url.startsWith('http')) {
    url = '/' + url;
  }
  return { endpoint: url || '/', baseUrl };
}

function resolveTypeDependencies(typeName, typeDefinitions, resolved = {}) {
  if (!typeName || resolved[typeName]) return resolved;
  
  const decl = typeDefinitions[typeName];
  if (!decl) return resolved;
  
  resolved[typeName] = decl;
  
  const words = decl.match(/\b[A-Za-z0-9_]+\b/g) || [];
  const tsKeywords = new Set([
    'export', 'type', 'interface', 'class', 'string', 'number', 'boolean', 
    'any', 'void', 'null', 'undefined', 'extends', 'Promise', 'Record', 
    'never', 'array', 'Array', 'Date', 'object', 'Object', 'true', 'false',
    'implements', 'readonly', 'keyof', 'typeof', 'as', 'const', 'unknown'
  ]);
  
  for (const word of words) {
    if (word !== typeName && !tsKeywords.has(word) && typeDefinitions[word]) {
      resolveTypeDependencies(word, typeDefinitions, resolved);
    }
  }
  
  return resolved;
}

function getTypeFieldsInline(typeName, typeDefinitions) {
  if (!typeName || !typeDefinitions[typeName]) return '';
  const decl = typeDefinitions[typeName];
  const lines = decl.split('\n');
  if (lines.length <= 2) return '';
  
  const fields = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('//') && !line.startsWith('/*')) {
      fields.push(line.replace(/[;,]$/, ''));
    }
  }
  const inline = `{ ${fields.join(', ')} }`;
  if (inline.length > 80) {
    return `{ ${fields.slice(0, 3).join(', ')}, ... }`;
  }
  return inline;
}

function getCombinedTypeDecl(typeName, typeDefinitions) {
  if (!typeName || !typeDefinitions[typeName]) return '';
  const resolved = resolveTypeDependencies(typeName, typeDefinitions);
  return Object.entries(resolved).map(([name, decl]) => {
    const lines = decl.split('\n');
    if (lines.length > 2) {
      const firstLine = lines[0].trim();
      const lastLine = lines[lines.length - 1].trim();
      if ((firstLine.includes('type ') || firstLine.includes('interface ') || firstLine.includes('class ')) && 
          (firstLine.endsWith('{') || firstLine.endsWith('=')) && lastLine === '}') {
        return lines.slice(1, -1).map(l => l.replace(/^\s\s/, '')).join('\n');
      }
    }
    return decl;
  }).join('\n\n');
}

// Path Resolver for ES Imports and aliases
function tryExtensions(basePath) {
  const extensions = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }
  for (const ext of extensions) {
    const fullPath = basePath + ext;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }
  }
  return null;
}

function resolveImportPath(sourceFile, importStr, srcDir) {
  if (!importStr.startsWith('.') && !importStr.startsWith('/') && 
      !importStr.startsWith('src/') && !importStr.startsWith('@/')) {
    // Might be absolute alias, e.g. import { ... } from 'api/auth'
    const basePath = path.join(srcDir, importStr);
    return tryExtensions(basePath);
  }

  let basePath = '';
  if (importStr.startsWith('src/')) {
    basePath = path.join(path.dirname(srcDir), importStr);
  } else if (importStr.startsWith('@/')) {
    basePath = path.join(srcDir, importStr.slice(2));
  } else if (importStr.startsWith('.')) {
    basePath = path.resolve(path.dirname(sourceFile), importStr);
  } else {
    basePath = path.join(srcDir, importStr);
  }

  return tryExtensions(basePath);
}

// Get all files imported/required in a file
function getImportedFiles(filePath, srcDir) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const imports = [];
    
    // RegExp for ES imports
    const importRegex = /import\s+(?:[\w\s{},*]*\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const resolved = resolveImportPath(filePath, match[1], srcDir);
      if (resolved) imports.push(resolved);
    }
    
    // RegExp for CommonJS requires
    const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      const resolved = resolveImportPath(filePath, match[1], srcDir);
      if (resolved) imports.push(resolved);
    }
    
    return Array.from(new Set(imports));
  } catch (e) {
    return [];
  }
}

// Build a map: navigation route name -> the leaf screen file it ultimately
// shows. React Navigation registers routes as `<X.Screen name="Route"
// component={Comp} />` inside navigator files. A route's component may be a
// leaf screen or a nested navigator ("stack"); for stacks we follow
// `initialRouteName` (or the first registered route) down to a leaf screen.
function buildRouteRegistry(srcDir) {
  const files = getFiles(srcDir);
  const navInfo = {}; // absFile -> { routes:[{name,comp}], initialRoute, importMap }
  const screenTagRe = /<[A-Za-z_][\w]*\.Screen\b[^>]*>/g;

  files.forEach(file => {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
    if (content.indexOf('.Screen') === -1) return;

    const routes = [];
    let m;
    screenTagRe.lastIndex = 0;
    while ((m = screenTagRe.exec(content)) !== null) {
      const tag = m[0];
      const nameM = /\bname=["']([^"']+)["']/.exec(tag);
      const compM = /\bcomponent=\{(\w+)\}/.exec(tag);
      if (nameM && compM) routes.push({ name: nameM[1], comp: compM[1] });
    }
    if (routes.length === 0) return;

    // initialRouteName as "X", 'X', {'X'} or {"X"} (the root often uses the JSX form)
    const initM = /\binitialRouteName\s*=\s*(?:\{\s*)?["']([^"']+)["']/.exec(content);
    const importMap = {};
    const importRe = /import\s+([A-Za-z0-9_]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g;
    let im;
    while ((im = importRe.exec(content)) !== null) {
      const resolved = resolveImportPath(file, im[2], srcDir);
      if (resolved) importMap[im[1]] = resolved;
    }
    navInfo[file] = {
      routes,
      initialRoute: initM ? initM[1] : null,
      importMap,
      hasContainer: content.indexOf('NavigationContainer') !== -1
    };
  });

  // route name -> the registered component's file (first registration wins)
  const routeToFile = {};
  Object.values(navInfo).forEach(info => {
    info.routes.forEach(r => {
      if (!(r.name in routeToFile)) routeToFile[r.name] = info.importMap[r.comp] || null;
    });
  });

  // Follow a (possibly stack) file down to its leaf screen file.
  function resolveLeaf(file, guard) {
    if (!file) return null;
    if (!navInfo[file]) return file; // not a navigator -> it's a leaf screen
    if (guard.has(file)) return null; // circular stack nesting
    guard.add(file);
    const info = navInfo[file];
    let entry = info.initialRoute && info.routes.find(r => r.name === info.initialRoute);
    if (!entry) entry = info.routes[0];
    if (!entry) return null;
    return resolveLeaf(info.importMap[entry.comp] || null, guard);
  }

  const resolved = {}; // routeName -> relative screen file (or null)
  Object.keys(routeToFile).forEach(route => {
    const leaf = resolveLeaf(routeToFile[route], new Set());
    resolved[route] = leaf ? path.relative(srcDir, leaf) : null;
  });

  // Root navigator: the one that mounts <NavigationContainer> (strongest
  // signal). Fallback: a navigator not nested inside any other navigator,
  // preferring an App*/Root* name. Its initial route resolves to the app's
  // first screen — the flow root.
  const navFiles = Object.keys(navInfo);
  const nested = new Set();
  navFiles.forEach(f => {
    navInfo[f].routes.forEach(r => {
      const cf = navInfo[f].importMap[r.comp];
      if (cf && navInfo[cf]) nested.add(cf);
    });
  });
  let rootNavFile = navFiles.find(f => navInfo[f].hasContainer);
  if (!rootNavFile) {
    const roots = navFiles.filter(f => !nested.has(f));
    rootNavFile = roots.find(f => /app|root/i.test(path.basename(f))) || roots[0] || null;
  }
  const rootLeaf = rootNavFile ? resolveLeaf(rootNavFile, new Set()) : null;
  const root = rootLeaf ? path.relative(srcDir, rootLeaf) : null;

  return { resolved, root };
}

// Extract the navigation route names a file navigates to.
function extractNavRoutes(content) {
  const routes = new Set();
  let m;
  const navDotRe = /navigation\s*[?.]?\s*\.\s*(?:navigate|push|replace|reset)\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = navDotRe.exec(content)) !== null) routes.add(m[1]);
  const bareRe = /(?:^|[^.\w])navigate\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = bareRe.exec(content)) !== null) routes.add(m[1]);
  // dispatch(CommonActions.reset({ routes: [{ name: 'HomeStack' }] })) and
  // navigate('Stack', { screen: 'X' }) — capture route objects' name/screen
  // when they follow the Stack/Screen naming convention.
  const objRouteRe = /\b(?:name|screen)\s*:\s*['"]([A-Za-z0-9_]*(?:Stack|Screen))['"]/g;
  while ((m = objRouteRe.exec(content)) !== null) routes.add(m[1]);
  return Array.from(routes);
}

function runParser(options) {
  const {
    srcDir,
    apiDirs,
    screensDir,
    typesDir,
    projectName = 'API Mapper'
  } = options;

  const typeDefinitions = {};

  // 1. Scan Types
  if (typesDir && fs.existsSync(typesDir)) {
    const typesFiles = getFiles(typesDir);
    typesFiles.forEach(file => {
      const content = fs.readFileSync(file, 'utf8');
      const typeRegex = /(?:export\s+)?(interface|type|class)\s+(\w+)/g;
      let match;
      while ((match = typeRegex.exec(content)) !== null) {
        const typeName = match[2];
        const declStart = match.index;
        const nextSemicolon = content.indexOf(';', declStart);
        const nextOpenBrace = content.indexOf('{', declStart);
        
        if (nextOpenBrace !== -1 && (nextSemicolon === -1 || nextOpenBrace < nextSemicolon)) {
          const block = extractBraceBlock(content, nextOpenBrace);
          if (block) {
            const fullDecl = content.substring(declStart, nextOpenBrace) + block;
            typeDefinitions[typeName] = fullDecl.trim();
          }
        } else if (nextSemicolon !== -1) {
          const fullDecl = content.substring(declStart, nextSemicolon + 1);
          typeDefinitions[typeName] = fullDecl.trim();
        }
      }
    });
  }

  // 1.5 Build Reachability Dependency Tree
  const activeFiles = new Set();
  const entryCandidates = [
    path.join(srcDir, 'App.tsx'),
    path.join(srcDir, 'App.ts'),
    path.join(srcDir, 'App.jsx'),
    path.join(srcDir, 'App.js'),
    path.join(srcDir, 'index.tsx'),
    path.join(srcDir, 'index.ts'),
    path.join(srcDir, 'index.jsx'),
    path.join(srcDir, 'index.js'),
    path.join(path.dirname(srcDir), 'index.js'),
    path.join(path.dirname(srcDir), 'App.js'),
    path.join(path.dirname(srcDir), 'App.tsx')
  ];
  
  const entries = entryCandidates.filter(f => fs.existsSync(f));

  if (entries.length > 0) {
    const queue = [...entries];
    while (queue.length > 0) {
      const current = queue.shift();
      if (activeFiles.has(current)) continue;
      activeFiles.add(current);
      
      const imports = getImportedFiles(current, srcDir);
      imports.forEach(imp => {
        if (!activeFiles.has(imp)) {
          queue.push(imp);
        }
      });
    }
  }

  const apiFunctions = {};

  // Values the app's code checks fields against, used to make realistic mocks.
  const fieldHints = collectFieldHints(srcDir);

  // 2. Scan API Directories
  apiDirs.forEach(dir => {
    if (!fs.existsSync(dir)) return;
    const files = getFiles(dir);
    files.forEach(file => {
      const relPath = path.relative(srcDir, file);
      const content = fs.readFileSync(file, 'utf8');
      
      const exportsInFile = [];
      let match;
      
      const exportRegex = /export\s+(?:const|function)\s+(\w+)\s*=/g;
      while ((match = exportRegex.exec(content)) !== null) {
        exportsInFile.push({
          name: match[1],
          index: match.index
        });
      }
      
      const exportFuncRegex = /export\s+function\s+(\w+)\s*\(/g;
      while ((match = exportFuncRegex.exec(content)) !== null) {
        if (!exportsInFile.some(e => e.name === match[1])) {
          exportsInFile.push({
            name: match[1],
            index: match.index
          });
        }
      }
      
      exportsInFile.sort((a, b) => a.index - b.index);
      
      exportsInFile.forEach((exp, idx) => {
        const start = exp.index;
        const end = (idx + 1 < exportsInFile.length) ? exportsInFile[idx + 1].index : content.length;
        const funcBody = content.substring(start, end);
        
        let method = 'POST';
        let endpoint = '';
        let baseUrl = '';
        
        const reqMatch = /request\.(post|get|put|patch|delete|remove)\(\s*(\`[\s\S]*?\`|'[\s\S]*?'|"[\s\S]*?"|[^,)]+)/i.exec(funcBody);
        const axiosDirectMatch = /axios\.(post|get|put|patch|delete)\(\s*(\`[\s\S]*?\`|'[\s\S]*?'|"[\s\S]*?"|[^,)]+)/i.exec(funcBody);
        const urlPropertyMatch = /url:\s*(\`[\s\S]*?\`|'[\s\S]*?'|"[\s\S]*?"|[^,\n\}]+)/i.exec(funcBody);
        
        if (reqMatch) {
          method = reqMatch[1].toUpperCase();
          if (method === 'REMOVE') method = 'DELETE';
          const cleaned = cleanRawUrl(reqMatch[2]);
          endpoint = cleaned.endpoint;
          baseUrl = cleaned.baseUrl;
        } else if (axiosDirectMatch) {
          method = axiosDirectMatch[1].toUpperCase();
          const cleaned = cleanRawUrl(axiosDirectMatch[2]);
          endpoint = cleaned.endpoint;
          baseUrl = cleaned.baseUrl;
        } else if (urlPropertyMatch) {
          const methodMatch = /method:\s*['"](\w+)['"]/i.exec(funcBody);
          if (methodMatch) {
            method = methodMatch[1].toUpperCase();
          }
          const cleaned = cleanRawUrl(urlPropertyMatch[1]);
          endpoint = cleaned.endpoint;
          baseUrl = cleaned.baseUrl;
        } else {
          endpoint = '(config/local action)';
          method = 'LOCAL';
        }
        
        let reqType = '';
        let resType = '';
        
        const { params, retType } = parseSignature(funcBody);

        if (params) {
          reqType = extractReqType(params);
        }

        if (retType) {
          resType = reduceToNamedType(retType);
        }
        
        apiFunctions[exp.name] = {
          file: relPath,
          method,
          endpoint,
          baseUrl,
          reqType,
          reqTypeDecl: getCombinedTypeDecl(reqType, typeDefinitions),
          resType,
          resTypeDecl: getCombinedTypeDecl(resType, typeDefinitions),
          params: params ? params.trim().replace(/\s+/g, ' ') : '',
          retType: retType ? retType.trim().replace(/\s+/g, ' ') : '',
          reqFields: getTypeFieldsInline(reqType, typeDefinitions),
          resFields: getTypeFieldsInline(resType, typeDefinitions),
          // Pre-built mocks that match the real type shape (nested types resolved).
          mockReqJson: reqType ? generateMockFromType(reqType, typeDefinitions, fieldHints) : null,
          mockResJson: resType ? generateMockFromType(resType, typeDefinitions, fieldHints) : null
        };
      });
    });
  });

  // 3. Scan all files in srcDir (except API folders themselves)
  const scannedFiles = getFiles(srcDir).filter(file => {
    const rel = path.relative(srcDir, file);
    return !apiDirs.some(apiDir => {
      const relApiDir = path.relative(srcDir, apiDir);
      return rel === relApiDir || rel.startsWith(relApiDir + path.sep);
    });
  });

  const screensMapping = [];
  const apiRegistry = {};

  // Expander follows local component imports and inlines their wireframe; one
  // instance per run so each component file is parsed/expanded once.
  const expander = createComponentExpander(srcDir, Object.keys(apiFunctions));

  Object.entries(apiFunctions).forEach(([funcName, meta]) => {
    apiRegistry[funcName] = {
      funcName,
      ...meta,
      screens: [],
      others: []
    };
  });

  scannedFiles.forEach(file => {
    const relPath = path.relative(srcDir, file);
    const content = fs.readFileSync(file, 'utf8');
    
    const fileImports = [];
    let match;
    
    const relScreensDir = path.relative(srcDir, screensDir);
    const isScreen = relPath === relScreensDir || relPath.startsWith(relScreensDir + path.sep);
    
    // Pattern 1: Named imports
    const namedImportRegex = /import\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]*?api[^'"]*)['"]/g;
    while ((match = namedImportRegex.exec(content)) !== null) {
      const rawFuncs = match[1];
      const funcs = rawFuncs.split(',').map(f => f.trim()).filter(Boolean);
      funcs.forEach(f => {
        const parts = f.split(/\s+as\s+/);
        const importedName = parts[0].trim();
        const localName = parts[parts.length - 1].trim();
        fileImports.push({
          localName,
          apiFuncName: importedName,
          type: 'named'
        });
      });
    }
    
    // Pattern 2: Namespace imports
    const namespaceImportRegex = /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]*?api[^'"]*)['"]/g;
    while ((match = namespaceImportRegex.exec(content)) !== null) {
      const localName = match[1];
      fileImports.push({
        localName,
        type: 'namespace'
      });
    }
    
    // Pattern 3: Default imports
    const defaultImportRegex = /import\s+([A-Za-z0-9_]+)(?:\s*,\s*\{[^}]+\})?\s+from\s+['"]([^'"]*?api[^'"]*)['"]/g;
    while ((match = defaultImportRegex.exec(content)) !== null) {
      const localName = match[1];
      if (localName !== 'type' && localName !== 'interface') {
        fileImports.push({
          localName,
          type: 'default'
        });
      }
    }
    
    if (isScreen || fileImports.length > 0) {
      const calls = [];
      
      Object.keys(apiFunctions).forEach(apiFuncName => {
        const apiMeta = apiFunctions[apiFuncName];
        let hasUsage = false;
        
        for (const imp of fileImports) {
          if (imp.type === 'named' && imp.apiFuncName === apiFuncName) {
            // Count whole-word occurrences so `login` is not matched inside
            // `userLogin`/`loginScreen`; >1 means used beyond the import itself.
            const wordRe = new RegExp('\\b' + escapeRegExp(imp.localName) + '\\b', 'g');
            const occurrences = (content.match(wordRe) || []).length;
            if (occurrences > 1) {
              hasUsage = true;
              break;
            }
          } else if (imp.type === 'namespace' || imp.type === 'default') {
            const pattern = new RegExp(`\\b${imp.localName}\\.${apiFuncName}\\b`);
            if (pattern.test(content)) {
              hasUsage = true;
              break;
            }
          }
        }
        
        if (hasUsage) {
          calls.push({
            funcName: apiFuncName,
            apiFile: apiMeta.file,
            method: apiMeta.method,
            endpoint: apiMeta.endpoint,
            baseUrl: apiMeta.baseUrl || '',
            reqType: apiMeta.reqType || '',
            reqTypeDecl: apiMeta.reqTypeDecl || '',
            resType: apiMeta.resType || '',
            resTypeDecl: apiMeta.resTypeDecl || '',
            params: apiMeta.params || '',
            retType: apiMeta.retType || '',
            reqFields: apiMeta.reqFields || '',
            resFields: apiMeta.resFields || ''
          });
          
          if (!apiRegistry[apiFuncName]) {
            apiRegistry[apiFuncName] = {
              funcName: apiFuncName,
              file: apiMeta.file,
              method: apiMeta.method,
              endpoint: apiMeta.endpoint,
              baseUrl: apiMeta.baseUrl || '',
              reqType: apiMeta.reqType || '',
              reqTypeDecl: apiMeta.reqTypeDecl || '',
              resType: apiMeta.resType || '',
              resTypeDecl: apiMeta.resTypeDecl || '',
              params: apiMeta.params || '',
              retType: apiMeta.retType || '',
              reqFields: apiMeta.reqFields || '',
              resFields: apiMeta.resFields || '',
              screens: [],
              others: []
            };
          }
          
          if (isScreen) {
            if (!apiRegistry[apiFuncName].screens.includes(relPath)) {
              apiRegistry[apiFuncName].screens.push(relPath);
            }
          } else {
            if (!apiRegistry[apiFuncName].others.includes(relPath)) {
              apiRegistry[apiFuncName].others.push(relPath);
            }
          }
        }
      });
      
      if (isScreen) {
        const absScreenPath = path.resolve(srcDir, relPath);
        const isActiveFlow = entries.length === 0 || activeFiles.has(absScreenPath);
        const uiTree = expander.expandScreen(content, file);
        
        let allNavs = new Set();
        const collectNavs = (node) => {
          if (!node) return;
          if (node.navCalls) node.navCalls.forEach(nav => allNavs.add(nav));
          if (node.children) node.children.forEach(collectNavs);
        };
        if (uiTree && uiTree.length > 0) collectNavs(uiTree[0]);

        screensMapping.push({
          screen: relPath,
          isActiveFlow,
          calls,
          navs: Array.from(allNavs),
          navRoutes: extractNavRoutes(content), // raw route names this screen navigates to
          uiTree
        });
      }
    }
  });

  // Calculate API reachability in active flow
  Object.values(apiRegistry).forEach(api => {
    const isScreenActive = api.screens.some(s => activeFiles.has(path.resolve(srcDir, s)));
    const isOtherActive = api.others.some(o => activeFiles.has(path.resolve(srcDir, o)));

    // API is active if it's called inside any active screen or active saga/helper file
    api.isActiveFlow = entries.length === 0 || isScreenActive || isOtherActive;
  });

  // Build the navigation flow graph: resolve each screen's navigate() route
  // names to the leaf screen they show, keeping only edges between known screens.
  const { resolved: routeResolution, root: rootScreen } = buildRouteRegistry(srcDir);
  const screenSet = new Set(screensMapping.map(s => s.screen));
  const screenByBase = {};
  screensMapping.forEach(s => {
    const base = path.basename(s.screen).replace(/\.(t|j)sx?$/, '');
    if (!(base in screenByBase)) screenByBase[base] = s.screen;
  });
  const resolveRoute = (route) => {
    if (routeResolution[route] && screenSet.has(routeResolution[route])) return routeResolution[route];
    if (screenByBase[route]) return screenByBase[route]; // fallback: route == screen file basename
    return null;
  };

  const edgeSeen = new Set();
  const navEdges = [];
  screensMapping.forEach(s => {
    (s.navRoutes || []).forEach(route => {
      const to = resolveRoute(route);
      if (to && to !== s.screen) {
        const key = s.screen + '->' + to;
        if (!edgeSeen.has(key)) { edgeSeen.add(key); navEdges.push({ from: s.screen, to, route }); }
      }
    });
    delete s.navRoutes; // keep the output lean — edges capture what we need
  });

  const root = (rootScreen && screenSet.has(rootScreen)) ? rootScreen : null;

  return {
    apiFunctions,
    screensMapping,
    apiRegistry,
    navGraph: { edges: navEdges, root },
    projectName,
    srcDir
  };
}

module.exports = {
  runParser
};
