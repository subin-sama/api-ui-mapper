const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

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

// Helper to extract UI node tree from JSX/TSX
function extractJSXTree(code, calls = []) {
  try {
    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: [
        'jsx',
        ['typescript', { isTSX: true, allExtensions: true }],
        'classProperties',
        'decorators-legacy'
      ]
    });

    const apiNames = calls.map(c => c.funcName);
    const functionApiMap = {};
    const functionNavMap = {};

    // Pass 1: Map local functions to the APIs they call
    if (apiNames.length > 0) {
      traverse(ast, {
        CallExpression(path) {
          let calleeName = null;
          if (path.node.callee.type === 'Identifier') {
            calleeName = path.node.callee.name;
          } else if (path.node.callee.type === 'MemberExpression') {
            calleeName = path.node.callee.property.name;
          }
          
          if (calleeName && NAV_FUNCS.has(calleeName)) {
            if (path.node.arguments.length > 0 && path.node.arguments[0].type === 'StringLiteral') {
              const targetScreen = path.node.arguments[0].value;
              const funcName = getEnclosingFuncName(path.getFunctionParent());
              if (funcName) {
                if (!functionNavMap[funcName]) functionNavMap[funcName] = new Set();
                functionNavMap[funcName].add(targetScreen);
              }
            }
          }

          if (calleeName && apiNames.includes(calleeName)) {
            const funcName = getEnclosingFuncName(path.getFunctionParent());
            if (funcName) {
              if (!functionApiMap[funcName]) functionApiMap[funcName] = new Set();
              functionApiMap[funcName].add(calleeName);
            }
          }
        }
      });
    }

    let uiTrees = [];

    traverse(ast, {
      ReturnStatement(path) {
        if (path.node.argument && (path.node.argument.type === 'JSXElement' || path.node.argument.type === 'JSXFragment')) {
          const tree = buildNode(path.node.argument, functionApiMap, apiNames, functionNavMap);
          if (tree) uiTrees.push(tree);
        }
      },
      ArrowFunctionExpression(path) {
        if (path.node.body && (path.node.body.type === 'JSXElement' || path.node.body.type === 'JSXFragment')) {
          const tree = buildNode(path.node.body, functionApiMap, apiNames, functionNavMap);
          if (tree) uiTrees.push(tree);
        }
      }
    });

    if (uiTrees.length === 0) return [];

    const countNodes = (node) => {
      if (!node) return 0;
      let count = 1;
      if (node.children) {
        for (const child of node.children) {
          count += countNodes(child);
        }
      }
      return count;
    };

    uiTrees.sort((a, b) => countNodes(b) - countNodes(a));
    return [uiTrees[0]];
  } catch (e) {
    return [];
  }
}

function findCallsInExpr(node, functionApiMap, apiNames, apiCalls, navCalls, functionNavMap) {
  if (!node) return;
  if (node.type === 'CallExpression') {
    let cName = null;
    if (node.callee.type === 'Identifier') cName = node.callee.name;
    else if (node.callee.type === 'MemberExpression') cName = node.callee.property.name;
    
    if (cName) {
      if (apiNames.includes(cName)) apiCalls.add(cName);
      if (functionApiMap[cName]) functionApiMap[cName].forEach(api => apiCalls.add(api));
      if (NAV_FUNCS.has(cName)) {
        if (node.arguments.length > 0 && node.arguments[0].type === 'StringLiteral') {
          if (navCalls) navCalls.add(node.arguments[0].value);
        }
      }
      if (functionNavMap && functionNavMap[cName]) {
        functionNavMap[cName].forEach(nav => { if (navCalls) navCalls.add(nav); });
      }
    }
    node.arguments.forEach(arg => findCallsInExpr(arg, functionApiMap, apiNames, apiCalls, navCalls, functionNavMap));
  } else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    findCallsInExpr(node.body, functionApiMap, apiNames, apiCalls, navCalls, functionNavMap);
  } else if (node.type === 'BlockStatement') {
    node.body.forEach(stmt => findCallsInExpr(stmt, functionApiMap, apiNames, apiCalls, navCalls, functionNavMap));
  } else if (node.type === 'ExpressionStatement') {
    findCallsInExpr(node.expression, functionApiMap, apiNames, apiCalls, navCalls, functionNavMap);
  }
}

function buildNode(jsxNode, functionApiMap, apiNames, functionNavMap) {
  if (jsxNode.type === 'JSXElement') {
    const nameNode = jsxNode.openingElement.name;
    let tagName = 'Unknown';
    if (nameNode.type === 'JSXIdentifier') tagName = nameNode.name;
    else if (nameNode.type === 'JSXMemberExpression') {
      tagName = nameNode.object.name + '.' + nameNode.property.name;
    }

    const apiCalls = new Set();
    const navCalls = new Set();
    const layoutProps = {};

    // Check props for event handlers (onPress, etc.) and layout attributes
    const attributes = jsxNode.openingElement.attributes || [];
    for (const attr of attributes) {
      if (attr.type !== 'JSXAttribute') continue;
      const attrName = attr.name.name;

      // Extract layout properties
      if (LAYOUT_PROPS.includes(attrName) && attr.value) {
        if (attr.value.type === 'StringLiteral') {
          layoutProps[attrName] = attr.value.value;
        } else if (attr.value.type === 'JSXExpressionContainer' &&
                   (attr.value.expression.type === 'NumericLiteral' || attr.value.expression.type === 'StringLiteral')) {
          layoutProps[attrName] = attr.value.expression.value;
        }
      }

      // API / navigation extraction from event-handler props (onPress, onClick, ...)
      if (attr.value && attr.value.type === 'JSXExpressionContainer') {
        const expr = attr.value.expression;
        if (expr.type === 'Identifier') {
          if (functionApiMap[expr.name]) functionApiMap[expr.name].forEach(api => apiCalls.add(api));
          if (apiNames.includes(expr.name)) apiCalls.add(expr.name);
          if (functionNavMap && functionNavMap[expr.name]) functionNavMap[expr.name].forEach(nav => navCalls.add(nav));
        } else {
          findCallsInExpr(expr, functionApiMap, apiNames, apiCalls, navCalls, functionNavMap);
        }
      }
    }

    const node = { tagName, children: [], apiCalls: Array.from(apiCalls), navCalls: Array.from(navCalls), layoutProps };

    // Process children
    for (const child of jsxNode.children) {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        const childNode = buildNode(child, functionApiMap, apiNames, functionNavMap);
        if (childNode) node.children.push(childNode);
      } else if (child.type === 'JSXText') {
        const text = child.value.trim();
        if (text) {
          node.children.push({ tagName: 'TEXT_LITERAL', text });
        }
      }
    }
    return node;
  } else if (jsxNode.type === 'JSXFragment') {
    const node = { tagName: 'Fragment', children: [] };
    for (const child of jsxNode.children) {
      if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        const childNode = buildNode(child, functionApiMap, apiNames, functionNavMap);
        if (childNode) node.children.push(childNode);
      }
    }
    return node;
  }
  return null;
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
          resFields: getTypeFieldsInline(resType, typeDefinitions)
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
        const uiTree = extractJSXTree(content, calls);
        
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

  return {
    apiFunctions,
    screensMapping,
    apiRegistry,
    projectName,
    srcDir
  };
}

module.exports = {
  runParser
};
