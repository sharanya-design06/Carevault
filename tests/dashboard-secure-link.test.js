const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const KEY = 'carevault.secure-report-session.v1';

async function login({ demo, firebase, storage = {} }) {
  let onSubmit; const requests = [];
  const form = { dataset: { form: 'login' }, querySelector: () => ({ disabled: false }) };
  const location = { hash: '', href: '/', replace() {} };
  const context = {
    window: {
      UI: { $app: { innerHTML: '' }, esc: String, ROLE_HOME: { doctor: '/doctor/' },
        S: { ready: async () => {}, session: () => (demo.ok ? { email: demo.email } : null), login: async () => demo } },
      FirebaseSession: { enabled: false }, CAREVAULT_REMOTE: { apiKey: 'key' }, addEventListener() {},
    },
    document: { addEventListener: (type, handler) => { if (type === 'submit') onSubmit = handler; } },
    location, URLSearchParams, String, Number, JSON, Date, Object,
    FormData: function () { return [['email', 'Dr@Example.test'], ['password', 'secret-pass']][Symbol.iterator](); },
    sessionStorage: { getItem: (k) => storage[k] || null, setItem: (k, v) => { storage[k] = v; }, removeItem: (k) => { delete storage[k]; } },
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return firebase(); },
  };
  context.window.UI.S.session = () => ({ email: demo.email });
  vm.runInNewContext(fs.readFileSync('public/assets/js/auth.js', 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  storage.__redirectedTo = null;
  await onSubmit({ target: { closest: () => form }, preventDefault() {} });
  return { storage, requests, redirected: location.href };
}

const good = () => ({ ok: true, json: async () => ({ idToken: 'id-token', expiresIn: '3600', email: 'Dr@Example.test' }) });

test('a successful dashboard login also stores a linked Firebase session, then continues to the dashboard', async () => {
  const result = await login({ demo: { ok: true, role: 'doctor', email: 'dr@example.test' }, firebase: good });
  const link = JSON.parse(result.storage[KEY]);
  assert.equal(link.idToken, 'id-token');
  assert.equal(link.email, 'dr@example.test');
  assert.ok(link.exp > Date.now());
  assert.equal(result.requests[0].body.email, 'dr@example.test', 'uses the dashboard account email, not what was typed');
  assert.equal(result.requests[0].body.password, 'secret-pass');
  assert.equal(result.redirected, '/doctor/');
});

test('login still succeeds when there is no matching Firebase account, and clears any older link', async () => {
  const result = await login({
    demo: { ok: true, role: 'doctor', email: 'dr@example.test' },
    firebase: () => ({ ok: false, json: async () => ({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }) }),
    storage: { [KEY]: JSON.stringify({ idToken: 'someone-elses-token' }) },
  });
  assert.equal(result.storage[KEY], undefined);
  assert.equal(result.redirected, '/doctor/');
});

test('a network failure in the link never blocks the dashboard login', async () => {
  const result = await login({ demo: { ok: true, role: 'doctor', email: 'dr@example.test' }, firebase: () => { throw new Error('offline'); } });
  assert.equal(result.storage[KEY], undefined);
  assert.equal(result.redirected, '/doctor/');
});

test('a failed dashboard login sends no Firebase request', async () => {
  const result = await login({ demo: { ok: false, error: 'Invalid credentials' }, firebase: good });
  assert.equal(result.requests.length, 0);
  assert.equal(result.storage[KEY], undefined);
});
