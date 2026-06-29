/**
 * End-to-end tests for lib/parser.js.
 *
 * Builds a small fixture project in a temp dir, runs the parser, and asserts
 * the mapping output. Uses only Node built-ins (no test framework) so it runs
 * with a plain `node test/parser.test.js`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runParser } = require('../lib/parser');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

// ---- Build fixture project ----------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-ui-mapper-test-'));
const src = path.join(root, 'src');
const dirs = ['api', 'screens', 'types'].map(d => path.join(src, d));
dirs.forEach(d => fs.mkdirSync(d, { recursive: true }));

function write(rel, content) {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

write('types/dto.ts', `
export interface LoginReq { email: string; password: string; }
export interface LoginRes { token: string; }
export interface CreateReq { name: string; }
export interface CreateRes { id: string; }
export interface Item { id: string; label: string; }
`);

write('api/auth.ts', `
import request from '../request';
export const login = (data: LoginReq): Promise<LoginRes> => request.post(\`/auth/login\`, data);
export const logout = (): Promise<void> => request.get('/auth/logout');
export const create = (id: string, body: CreateReq): Promise<CreateRes[]> => request.post('/items', body);
export const find = (q: { term: string }): Promise<Item | null> => request.get('/find');
export const ping = (): Promise<{ ok: boolean }> => request.get('/ping');
export const list = (): Promise<Array<Item>> => request.get('/list');
export const dyn = (): Promise<void> => request.get(basePath);
`);

// Functional component (baseline)
write('screens/LoginScreen.tsx', `
import React from 'react';
import { login } from '../api/auth';
export default function LoginScreen({ navigation }) {
  const onSubmit = () => { login({ email: 'a', password: 'b' }); navigation.navigate('Home'); };
  return (<View flex={1}><Button onPress={onSubmit}>Go</Button></View>);
}
`);

// Class component (regression target: class-method API/nav resolution)
write('screens/ClassScreen.tsx', `
import React from 'react';
import { login } from '../api/auth';
export default class ClassScreen extends React.Component {
  handleSubmit() {
    login({ email: 'a', password: 'b' });
    this.props.navigation.navigate('Dashboard');
  }
  render() {
    return (<View><Button onPress={() => this.handleSubmit()}>Submit</Button></View>);
  }
}
`);

// Object-method shorthand (regression target)
write('screens/ObjScreen.tsx', `
import React from 'react';
import { logout } from '../api/auth';
export default function ObjScreen({ navigation }) {
  const handlers = {
    doLogout() { logout(); navigation.navigate('Login'); }
  };
  return (<View><Button onPress={() => handlers.doLogout()}>Out</Button></View>);
}
`);

// Named-import false-positive guard: imports `login` but never calls it;
// only lookalike identifiers appear.
write('screens/NoiseScreen.tsx', `
import React from 'react';
import { login } from '../api/auth';
export default function NoiseScreen() {
  const loginButton = 1;
  const relogin = 2;
  return (<View>{loginButton}{relogin}</View>);
}
`);

const result = runParser({
  srcDir: src,
  apiDirs: [path.join(src, 'api')],
  screensDir: path.join(src, 'screens'),
  typesDir: path.join(src, 'types'),
  projectName: 'FixtureApp'
});

const api = result.apiFunctions;
const screenBy = (suffix) => result.screensMapping.find(s => s.screen.endsWith(suffix));

function allNodeApiCalls(tree) {
  const out = [];
  const walk = (n) => { if (!n) return; (n.apiCalls || []).forEach(a => out.push(a)); (n.children || []).forEach(walk); };
  (tree || []).forEach(walk);
  return out;
}

// ---- Tests ---------------------------------------------------------------
console.log('parser end-to-end');

test('discovers all named API exports', () => {
  assert.deepStrictEqual(
    Object.keys(api).sort(),
    ['create', 'dyn', 'find', 'list', 'login', 'logout', 'ping']
  );
});

test('login: method + endpoint + req/res DTO types', () => {
  assert.strictEqual(api.login.method, 'POST');
  assert.strictEqual(api.login.endpoint, '/auth/login');
  assert.strictEqual(api.login.reqType, 'LoginReq');
  assert.strictEqual(api.login.resType, 'LoginRes');
});

test('reqType picks the DTO param, not a leading primitive', () => {
  // create = (id: string, body: CreateReq) -> should pick CreateReq
  assert.strictEqual(api.create.reqType, 'CreateReq');
});

test('reqType is empty for inline-object params (not the inner field type)', () => {
  // find = (q: { term: string }) -> not `string`
  assert.strictEqual(api.find.reqType, '');
});

test('resType unwraps Promise<T[]>', () => {
  assert.strictEqual(api.create.resType, 'CreateRes');
});

test('resType unwraps Promise<T | null> (union)', () => {
  assert.strictEqual(api.find.resType, 'Item');
});

test('resType unwraps Promise<Array<T>>', () => {
  assert.strictEqual(api.list.resType, 'Item');
});

test('resType is empty for Promise<{ inline }>', () => {
  assert.strictEqual(api.ping.resType, '');
});

test('bare-variable URL is reported as (dynamic), not fabricated', () => {
  assert.strictEqual(api.dyn.endpoint, '(dynamic)');
});

test('functional component: nav + api badge resolved', () => {
  const s = screenBy('LoginScreen.tsx');
  assert.deepStrictEqual(s.navs, ['Home']);
  assert.ok(allNodeApiCalls(s.uiTree).includes('login'), 'button should carry login api badge');
});

test('class component: method-scoped api/nav resolved (regression)', () => {
  const s = screenBy('ClassScreen.tsx');
  assert.deepStrictEqual(s.navs, ['Dashboard']);
  assert.ok(allNodeApiCalls(s.uiTree).includes('login'), 'class method api badge should resolve');
});

test('object-method shorthand: api/nav resolved (regression)', () => {
  const s = screenBy('ObjScreen.tsx');
  assert.deepStrictEqual(s.navs, ['Login']);
  assert.ok(allNodeApiCalls(s.uiTree).includes('logout'), 'object method api badge should resolve');
});

test('named-import usage uses word boundaries (no false positive)', () => {
  const s = screenBy('NoiseScreen.tsx');
  assert.deepStrictEqual(s.calls.map(c => c.funcName), [], 'login imported but never called');
});

// ---- Cleanup + report ----------------------------------------------------
try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
