/**
 * Tests for the playground's editor-to-JSON extraction.
 *
 * Pulls the `editorJsonText` function source out of lib/playground.html and
 * exercises it directly (the file is a browser HTML page, so we extract the
 * pure function rather than load the DOM).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'playground.html'), 'utf8');
const m = html.match(/function editorJsonText\(text\)\s*\{[\s\S]*?\n    \}/);
if (!m) { console.error('editorJsonText() not found in playground.html'); process.exit(1); }
const editorJsonText = eval('(' + m[0].replace('function editorJsonText', 'function') + ')');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failures.push(name); console.log(`  ✗ ${name}`); console.log(`      ${e.message}`); }
}

console.log('playground editorJsonText');

test('strips the // Type header and the /* decl */ block', () => {
  const txt = '// Type: Foo\n/*\nmessage: string;\n*/\n{ "ok": true }';
  assert.strictEqual(editorJsonText(txt), '{ "ok": true }');
});

test('preserves // inside URL string values (regression: save returned a string)', () => {
  const txt = '// Type: Res\n/*\ndecl\n*/\n' + JSON.stringify({ url: 'https://mock.link/xyz' }, null, 2);
  const parsed = JSON.parse(editorJsonText(txt)); // must be valid JSON
  assert.strictEqual(parsed.url, 'https://mock.link/xyz');
});

test('a generated mock with nested URLs parses to an object, not a string', () => {
  const body = JSON.stringify({ message: 'x', data: { WebViewURL: 'https://a.b//c?d=1' } }, null, 2);
  const txt = '// Type: GetLinkIncreaseLimitRes\n/*\ndata: { WebViewURL: string }\n*/\n' + body;
  const parsed = JSON.parse(editorJsonText(txt));
  assert.strictEqual(typeof parsed, 'object');
  assert.strictEqual(parsed.data.WebViewURL, 'https://a.b//c?d=1');
});

test('handles content with no comment header', () => {
  assert.strictEqual(editorJsonText('{ "a": 1 }'), '{ "a": 1 }');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
