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

// Types with nested references, arrays-of-objects, extends, and unions —
// the cases where the old decl-text mock generator produced wrong output.
write('types/models.ts', `
export interface User { id: string; name: string; age: number; role: 'admin' | 'user'; }
export interface Address { street: string; city: string; }
export interface Profile {
  user: User;
  address: Address;
  friends: User[];
  nickname?: string;
}
export interface ListRes extends Profile { total: number; }
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
export const profile = (): Promise<Profile> => request.get('/profile');
export const listRes = (): Promise<ListRes> => request.get('/listres');
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

// ---- Navigation flow fixtures: stacks register screens; screens navigate to
// route names that may be leaf screens or nested stacks. ----
write('screens/SplashScreen.tsx', `
import React from 'react';
export default function SplashScreen({ navigation }) {
  React.useEffect(() => { navigation.replace('HomeStack'); }, []);
  return (<View><Text>Splash</Text></View>);
}
`);
write('screens/DashScreen.tsx', `
import React from 'react';
export default function DashScreen({ navigation }) {
  const goSettings = () => navigation.navigate('SettingsStack');
  const goOrphan = () => navigation.navigate('OrphanScreen');
  return (<View><Button onPress={goSettings}>S</Button><Button onPress={goOrphan}>O</Button></View>);
}
`);
write('screens/PrefScreen.tsx', `
import React from 'react';
export default function PrefScreen() { return (<View><Text>Prefs</Text></View>); }
`);
write('screens/OrphanScreen.tsx', `
import React from 'react';
export default function OrphanScreen() { return (<View><Text>Orphan</Text></View>); }
`);

// AppStack registers Splash (leaf) and HomeStack (nested navigator)
write('navigations/AppStack.tsx', `
import SplashScreen from '../screens/SplashScreen';
import HomeStack from './HomeStack';
const Stack = createNativeStackNavigator();
export default function AppStack() {
  return (
    <Stack.Navigator initialRouteName="SplashScreen">
      <Stack.Screen name="SplashScreen" component={SplashScreen} />
      <Stack.Screen name="HomeStack" component={HomeStack} />
    </Stack.Navigator>
  );
}
`);
// HomeStack is a Tab navigator whose entry is DashScreen; also nests SettingsStack
write('navigations/HomeStack.tsx', `
import DashScreen from '../screens/DashScreen';
import SettingsStack from './SettingsStack';
const Tab = createBottomTabNavigator();
export default function HomeStack() {
  return (
    <Tab.Navigator initialRouteName="DashScreen">
      <Tab.Screen name="DashScreen" component={DashScreen} />
      <Tab.Screen name="SettingsStack" component={SettingsStack} />
    </Tab.Navigator>
  );
}
`);
// SettingsStack's first/entry screen is PrefScreen
write('navigations/SettingsStack.tsx', `
import PrefScreen from '../screens/PrefScreen';
const Stack = createNativeStackNavigator();
export default function SettingsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name="PrefScreen" component={PrefScreen} />
    </Stack.Navigator>
  );
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
    ['create', 'dyn', 'find', 'list', 'listRes', 'login', 'logout', 'ping', 'profile']
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

// ---- Mock generation (matches the response type shape) -------------------

test('mockResJson: flat type fields are generated', () => {
  const m = api.login.mockResJson;
  assert.ok(m && typeof m === 'object', 'login should have a mock object');
  assert.strictEqual(typeof m.token, 'string'); // LoginRes { token: string }
});

test('mockResJson: nested named type is expanded, not a placeholder', () => {
  const m = api.profile.mockResJson; // Profile
  assert.ok(m.user && typeof m.user === 'object', 'user should be an object');
  assert.strictEqual(typeof m.user.id, 'string');
  assert.strictEqual(typeof m.user.name, 'string');
  assert.strictEqual(typeof m.user.age, 'number');
  assert.strictEqual(m.user.role, 'admin'); // literal union -> first member
  assert.ok(!('_type' in m.user), 'must not emit a {_type} placeholder');
});

test('mockResJson: array-of-objects resolves element shape', () => {
  const m = api.profile.mockResJson;
  assert.ok(Array.isArray(m.friends), 'friends should be an array');
  assert.strictEqual(typeof m.friends[0].id, 'string', 'element should be a real User');
  assert.ok(!('_type' in m.friends[0]));
});

test('mockResJson: dependency fields do NOT leak to the top level', () => {
  const m = api.profile.mockResJson;
  // `street`/`city` belong to Address (nested), not to Profile itself.
  assert.ok(!('street' in m), 'Address fields must stay nested under address');
  assert.ok(m.address && typeof m.address.street === 'string');
});

test('mockResJson: extends merges base type fields', () => {
  const m = api.listRes.mockResJson; // ListRes extends Profile { total }
  assert.strictEqual(typeof m.total, 'number');
  assert.ok(m.user && typeof m.user === 'object', 'inherited Profile.user present');
});

// ---- Navigation flow graph -----------------------------------------------

const edges = (result.navGraph && result.navGraph.edges) || [];
const hasEdge = (fromSuffix, toSuffix) =>
  edges.some(e => e.from.endsWith(fromSuffix) && e.to.endsWith(toSuffix));

test('navGraph exists with edges', () => {
  assert.ok(result.navGraph, 'navGraph present');
  assert.ok(edges.length > 0, 'should resolve some edges');
});

test('navigate to a stack resolves to the stack entry screen (initialRouteName)', () => {
  // SplashScreen -> navigate('HomeStack'); HomeStack initialRouteName=DashScreen
  assert.ok(hasEdge('SplashScreen.tsx', 'DashScreen.tsx'),
    'Splash should link to HomeStack entry DashScreen, not a HomeStack file');
});

test('nested stack resolves to its first registered screen', () => {
  // DashScreen -> navigate('SettingsStack'); SettingsStack first screen = PrefScreen
  assert.ok(hasEdge('DashScreen.tsx', 'PrefScreen.tsx'),
    'SettingsStack should resolve to PrefScreen');
});

test('unregistered route falls back to matching screen filename', () => {
  // DashScreen -> navigate('OrphanScreen'); not in any navigator
  assert.ok(hasEdge('DashScreen.tsx', 'OrphanScreen.tsx'),
    'route matching a screen filename should still link');
});

test('edges never point a screen at itself, and target real screens', () => {
  const screenSet = new Set(result.screensMapping.map(s => s.screen));
  for (const e of edges) {
    assert.notStrictEqual(e.from, e.to, 'no self-edges');
    assert.ok(screenSet.has(e.to), 'edge target is a known screen: ' + e.to);
  }
});

// ---- Cleanup + report ----------------------------------------------------
try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
