/**
 * mock-generator.js
 *
 * Generates mock JSON that matches a TypeScript type. The key capability is
 * resolving NAMED type references (e.g. `user: User`, `items: Order[]`)
 * recursively against the project's collected type definitions, so nested
 * objects and arrays-of-objects come out with their real shape instead of a
 * `{ _type: ... }` placeholder.
 */

const MAX_DEPTH = 12;

const TS_PRIMITIVES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'void', 'null', 'undefined',
  'never', 'object', 'Date', 'symbol', 'bigint'
]);

// Per-generation map of fieldName -> { str, num }: the values the app's own code
// compares the field against (so a mock for `responseCode` becomes the "00" the
// code checks, not a generic guess). Set at the start of each generation.
let activeHints = {};

// Split `str` on any separator char in `seps`, ignoring separators nested in
// (), {}, [], <> or string/template literals. `=>` does not unbalance `>`.
function splitTopLevel(str, seps) {
  const parts = [];
  let depth = 0, cur = '', inStr = null, prev = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inStr) { cur += ch; if (ch === inStr) inStr = null; prev = ch; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; cur += ch; prev = ch; continue; }
    if (ch === '(' || ch === '{' || ch === '[' || ch === '<') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === '>' && prev !== '=') depth--;
    if (depth === 0 && seps.includes(ch)) { if (cur.trim()) parts.push(cur.trim()); cur = ''; prev = ch; continue; }
    cur += ch; prev = ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function stripComments(s) {
  return String(s == null ? '' : s).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Inner text of the first balanced `{ ... }` in `text`, or null.
function extractBraceBody(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(start + 1, i); }
  }
  return null;
}

function singular(key) {
  if (!key) return key;
  if (/ies$/i.test(key)) return key.replace(/ies$/i, 'y');
  if (/s$/i.test(key) && !/ss$/i.test(key)) return key.slice(0, -1);
  return key;
}

// Field names whose "happy path" value is the negative one (false / empty).
const NEGATIVE_FIELD_RE = /(error|fail|invalid|block|expire|disable|deny|reject|lock|cancel|empty|missing|unauthoriz|forbidden|notfound|wrong|duplicate|conflict|timeout|inactive|loading|pending|hidden|disabled|busy|warning|alert|problem)/;

// Happy-path boolean: true unless the field name reads as a negative condition.
function happyBoolean(key) {
  return !NEGATIVE_FIELD_RE.test((key || '').toLowerCase());
}

// A mock value for a primitive type or an unresolvable name. Key-aware so the
// output looks realistic (emails, tokens, dates, ...).
function mockPrimitive(type, key) {
  const raw = String(type || '').trim();
  const t = raw.toLowerCase();
  const k = (key || '').toLowerCase();

  if (raw.startsWith("'") || raw.startsWith('"') || raw.startsWith('`')) return raw.replace(/['"`]/g, '');

  // Prefer the value the app's code actually checks this field against.
  const hint = key ? activeHints[key] : null;
  if (hint) {
    if ((t === 'number' || t === 'bigint') && hint.num !== undefined) {
      const n = Number(hint.num); if (!Number.isNaN(n)) return n;
    } else if (t === 'boolean' && (hint.str === 'true' || hint.str === 'false')) {
      return hint.str === 'true';
    } else if ((t === 'string' || t === '') && hint.str !== undefined) {
      return hint.str;
    }
  }

  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && !isNaN(Number(raw))) return Number(raw); // numeric literal type
  if (t === 'boolean') return happyBoolean(key);
  if (t === 'date') return new Date().toISOString();
  if (t === 'null' || t === 'void' || t === 'undefined' || t === 'never') return null;
  if (t === 'any' || t === 'unknown' || t === 'object') return {};

  if (t === 'number' || t === 'bigint') {
    if (/(amount|price|balance|total|fee|cost|sum)/.test(k)) return 1500.50;
    if (k.includes('percent') || k.includes('rate')) return 7.5;
    if (/(count|qty|quantity|age|num|index|size|length)/.test(k)) return 1;
    return 123;
  }

  // string (and any unresolved name): key-aware sample
  // Happy path: error/failure message fields are empty.
  if (/(error|fail|reject|deny|warning|problem)/.test(k) && /(message|msg|desc|reason|detail|text|info)/.test(k)) return '';
  if (k.includes('token')) return 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
  if (k.includes('email')) return 'user@example.com';
  if (k.includes('phone') || k.includes('tel') || k.includes('mobile')) return '0812345678';
  if (k.includes('uuid') || k === 'id' || k.endsWith('id')) return 'ID-9999-XYZ';
  if (k.includes('name')) return 'John Doe';
  if (k.includes('date') || k.includes('time')) return new Date().toISOString();
  if (k.includes('url') || k.includes('link') || k.includes('image') || k.includes('avatar') || k.includes('photo')) return 'https://mock.link/xyz';
  if (k.includes('ip')) return '192.168.1.1';
  if (k.includes('status')) return 'SUCCESS';
  if (k.includes('lang')) return 'TH';
  if (k.includes('device')) return 'IOS';
  if (k.includes('code')) return '0000';
  if (k.includes('desc') || k.includes('message') || k.includes('msg') || k.includes('title')) return 'Lorem ipsum';
  return 'Mock String';
}

// Build a mock object from the inner text of a `{ ... }` body.
function mockObjectBody(body, typeDefs, depth, path) {
  const obj = {};
  for (const member of splitTopLevel(stripComments(body), [';', ',', '\n'])) {
    const m = member.trim();
    if (!m) continue;

    // Index signature: [key: string]: Value
    const idx = /^\[[^\]]*\]\s*:\s*([\s\S]+)$/.exec(m);
    if (idx) { obj.key = mockForType(idx[1].trim(), typeDefs, 'key', depth + 1, path); continue; }

    // Method signature: foo(args): X  -> skip
    if (/^[\w$]+\s*\(/.test(m)) continue;

    const fm = /^(['"]?[\w$]+['"]?)\s*\??\s*:\s*([\s\S]+)$/.exec(m);
    if (!fm) continue;
    const key = fm[1].replace(/['"]/g, '');
    obj[key] = mockForType(fm[2].trim(), typeDefs, key, depth + 1, path);
  }
  return obj;
}

// Core resolver: produce a mock value for any type annotation string.
function mockForType(annotation, typeDefs, key, depth, path) {
  if (depth > MAX_DEPTH) return null;
  let t = stripComments(annotation).trim();
  if (!t) return '';

  // Union -> use the first meaningful member (representative for literal unions)
  const union = splitTopLevel(t, ['|']).filter(p => p && p !== 'undefined' && p !== 'null');
  if (union.length > 1) return mockForType(union[0], typeDefs, key, depth, path);
  if (union.length === 1) t = union[0];

  t = t.replace(/^readonly\s+/, '').trim();

  // Array: T[]  /  Array<T>
  const arr = /^([\s\S]+)\[\]$/.exec(t);
  if (arr) return [mockForType(arr[1].trim(), typeDefs, singular(key), depth + 1, path)];
  const genArr = /^(?:Array|ReadonlyArray)\s*<([\s\S]*)>$/.exec(t);
  if (genArr) return [mockForType(genArr[1].trim(), typeDefs, singular(key), depth + 1, path)];

  // Promise<T> (defensive — should already be unwrapped upstream)
  const prom = /^Promise\s*<([\s\S]*)>$/.exec(t);
  if (prom) return mockForType(prom[1].trim(), typeDefs, key, depth + 1, path);

  // Utility generics
  const util = /^(Record|Partial|Required|Readonly|Pick|Omit)\s*<([\s\S]*)>$/.exec(t);
  if (util) {
    const args = splitTopLevel(util[2], [',']);
    if (util[1] === 'Record' && args.length >= 2) {
      return { key: mockForType(args[1].trim(), typeDefs, key, depth + 1, path) };
    }
    // Partial/Required/Readonly/Pick/Omit<T, ...> -> mock T
    return mockForType(args[0].trim(), typeDefs, key, depth + 1, path);
  }

  // Inline object literal
  if (t.startsWith('{')) {
    const body = extractBraceBody(t);
    return mockObjectBody(body || '', typeDefs, depth, path);
  }

  // Named type reference -> expand from the type-definition map
  const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(t);
  if (nameMatch) {
    const name = nameMatch[1];
    if (!TS_PRIMITIVES.has(name) && typeDefs && typeDefs[name]) {
      if (path.includes(name)) return {}; // circular reference — stop here
      const decl = stripComments(typeDefs[name]);
      const newPath = path.concat(name);
      const body = extractBraceBody(decl);

      if (body !== null) {
        // interface/type with an object body. Merge any `extends` bases first.
        const header = decl.slice(0, decl.indexOf('{'));
        const merged = {};
        const ext = /\bextends\s+([\w$.,<>\s]+)/.exec(header);
        if (ext) {
          for (const baseExpr of splitTopLevel(ext[1], [','])) {
            const base = mockForType(baseExpr.trim(), typeDefs, key, depth + 1, newPath);
            if (base && typeof base === 'object' && !Array.isArray(base)) Object.assign(merged, base);
          }
        }
        return Object.assign(merged, mockObjectBody(body, typeDefs, depth + 1, newPath));
      }

      // Alias: `type X = <something>`
      const alias = /=\s*([\s\S]+?);?\s*$/.exec(decl);
      if (alias) return mockForType(alias[1].trim(), typeDefs, key, depth + 1, newPath);
      return {};
    }
  }

  // Primitive, literal, or unknown name
  return mockPrimitive(t, key);
}

/**
 * Primary API: generate a mock value for a named type, resolving references
 * against `typeDefs` (the map produced by the parser).
 * @param {string} typeName
 * @param {Object<string,string>} typeDefs  name -> raw declaration text
 * @param {Object<string,{str?:string,num?:string}>} [fieldHints]  field -> value the code checks
 */
function generateMockFromType(typeName, typeDefs, fieldHints) {
  if (!typeName) return {};
  activeHints = fieldHints || {};
  try {
    const value = mockForType(typeName, typeDefs || {}, '', 0, []);
    return value == null ? {} : value;
  } finally {
    activeHints = {};
  }
}

/**
 * Back-compat API: generate a mock from a single inline declaration's text
 * (no external type map). Named references inside it become string samples.
 */
function generateMockFromTypeDecl(typeDecl) {
  if (!typeDecl) return {};
  activeHints = {};
  const body = extractBraceBody(stripComments(typeDecl));
  if (body === null) return {};
  try {
    return mockObjectBody(body, {}, 0, []);
  } catch (e) {
    return { _error: 'Failed to generate mock', _rawDecl: typeDecl };
  }
}

module.exports = { generateMockFromType, generateMockFromTypeDecl };
