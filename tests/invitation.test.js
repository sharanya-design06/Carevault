const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

function functionHarness(documents, sendMail) {
  const logs = [];
  const modules = {
    'firebase-functions/v2/https': { onRequest: (options, handler) => handler },
    'firebase-functions/params': { defineSecret: (name) => ({ value: () => name }) },
    'firebase-functions/logger': { error: (...args) => logs.push(args) },
    'firebase-admin': {
      initializeApp() {},
      firestore: () => ({ doc: (path) => ({ get: async () => {
        const value = documents[path.split('/').pop()];
        return { exists: value !== undefined, get: () => value };
      } }) }),
    },
    nodemailer: { createTransport: () => ({ sendMail }) },
  };
  const context = { require: (name) => modules[name], exports: {}, Date, JSON };
  vm.runInNewContext(fs.readFileSync('functions/index.js', 'utf8'), context);
  return {
    logs,
    async request(body) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
      await context.exports.sendInvite({ method: 'POST', body }, res);
      return res;
    },
  };
}

test('function emails the registered address with the password setup link', async () => {
  const token = '0123456789abcdef0123456789abcdef';
  let message;
  const h = functionHarness({ users: JSON.stringify([{ email: 'user@example.test', invite: { token, expiresAt: '2099-01-01T00:00:00Z' } }]) }, async (mail) => {
    message = mail;
    return { accepted: [mail.to] };
  });
  const res = await h.request({ kind: 'invite', token });
  assert.equal(res.statusCode, 200);
  assert.equal(message.to, 'user@example.test');
  assert.match(message.text, new RegExp('/#/setup-password\\?token=' + token));
});

test('function reports expired, invalid and undeliverable invitations', async () => {
  const token = '0123456789abcdef0123456789abcdef';
  for (const expiresAt of ['2000-01-01', 'invalid']) {
    const h = functionHarness({ users: JSON.stringify([{ email: 'user@example.test', invite: { token, expiresAt } }]) }, async () => { throw new Error('must not send'); });
    assert.equal((await h.request({ kind: 'invite', token })).statusCode, 404);
  }
  const h = functionHarness({ users: JSON.stringify([{ email: 'user@example.test', invite: { token, expiresAt: '2099-01-01' } }]) }, async () => { throw new Error('SMTP failed'); });
  assert.equal((await h.request({ kind: 'invite', token })).statusCode, 503);
  assert.equal(h.logs.length, 1);
  const rejected = functionHarness({ users: JSON.stringify([{ email: 'user@example.test', invite: { token, expiresAt: '2099-01-01' } }]) }, async () => ({ accepted: [] }));
  assert.equal((await rejected.request({ kind: 'invite', token })).statusCode, 503);
  const badData = functionHarness({ hospitals: 'invalid JSON' }, async () => ({ accepted: [] }));
  assert.equal((await badData.request({ kind: 'invite', token })).statusCode, 503);
});

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

async function storeHarness() {
  const localStorage = storage(), sessionStorage = storage(), sent = [];
  let failure = false, pushFailure = false;
  const remote = {
    enabled: true,
    pull: async () => ({}),
    push: async (db) => {
      if (pushFailure) throw new Error('Storage unavailable');
      return JSON.parse(JSON.stringify(db));
    },
    merge: (local) => local,
    sendMail: async (kind, token) => {
      sent.push({ kind, token });
      if (failure) throw new Error('SMTP unavailable');
    },
  };
  const context = {
    window: { Remote: remote }, localStorage, sessionStorage, crypto: webcrypto, TextEncoder,
    location: { origin: 'https://example.test' }, document: { addEventListener() {} },
    setInterval() {}, console: { warn() {} }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/store.js', 'utf8'), context);
  const S = context.window.Store;
  await S.ready();
  await new Promise((resolve) => setImmediate(resolve));
  return {
    S, sent,
    session(role, id, hospitalId) {
      sessionStorage.setItem('carevault.session.v4', JSON.stringify({ role, id, hospitalId, email: 'actor@example.test', exp: Date.now() + 60000 }));
    },
    failMail() { failure = true; },
    failPush() { pushFailure = true; },
  };
}

test('invitation delivery works for authorized roles and reports SMTP failures', async () => {
  const h = await storeHarness();
  h.session('sysadmin', 'adm_1');
  const admin = h.S.addSystemAdmin({ name: 'New Admin', email: 'new@example.test' });
  assert.equal(admin.ok, true);
  assert.equal((await h.S.sendInvitation(admin.admin.invite.token)).ok, true);
  assert.equal(h.sent.filter((x) => x.token === admin.admin.invite.token).length, 1);

  h.session('hospitaladmin', 'usr_1', 'hos_1');
  const staff = h.S.addStaff({ name: 'New Nurse', email: 'nurse@example.test', role: 'Nurse', department: 'Care', phone: '' });
  assert.equal(staff.ok, true);
  h.failMail();
  const failed = await h.S.sendInvitation(staff.user.invite.token);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Email delivery failed/);
  h.session('pcc', 'usr_8', 'hos_2');
  assert.equal((await h.S.sendInvitation(staff.user.invite.token)).ok, false);
});

test('a shared-storage failure prevents sending an unusable invitation', async () => {
  const h = await storeHarness();
  h.session('sysadmin', 'adm_1');
  h.failPush();
  const result = h.S.addSystemAdmin({ name: 'New Admin', email: 'new@example.test' });
  const delivery = await h.S.sendInvitation(result.admin.invite.token);
  assert.equal(delivery.ok, false);
  assert.match(delivery.error, /could not be saved to shared storage/);
  assert.equal(h.sent.filter((x) => x.token === result.admin.invite.token).length, 0);
});

test('creation forms wait for email delivery and display a failure without redirecting', async () => {
  const cases = [
    { file: 'public/system-admin/app.js', hash: '#/hospitals/new', form: 'addHospital', method: 'addHospital', key: 'hospital' },
    { file: 'public/system-admin/app.js', hash: '#/admins', form: 'addSystemAdmin', method: 'addSystemAdmin', key: 'admin' },
    { file: 'public/hospital-admin/app.js', hash: '#/staff/new', form: 'addStaff', method: 'addStaff', key: 'user' },
    { file: 'public/pcc/app.js', hash: '#/staff/new/nurse', form: 'addStaff', method: 'pccAddStaff', key: 'user' },
    { file: 'public/pcc/app.js', hash: '#/patients/new', form: 'patient', method: 'registerPatient', key: 'patient' },
  ];
  for (const c of cases) {
    const listeners = {}, app = { innerHTML: '' }, button = { disabled: false };
    const account = { id: 'new', name: 'New', email: 'new@example.test', role: 'Nurse', hrid: 'HRID', invite: { token: 'test-token', expiresAt: '2099-01-01' } };
    let finish;
    const delivery = new Promise((resolve) => { finish = resolve; });
    const S = {
      ready: async () => {}, touch() {}, session: () => ({ id: 'adm_1' }), systemAdmins: () => [],
      myHospital: () => ({ name: 'Hospital' }), STAFF_ROLES: ['Nurse'], PCC_ROLES: ['Nurse'],
      inviteLink: () => 'setup-link', sendInvitation: () => delivery,
      [c.method]: () => ({ ok: true, [c.key]: account }),
    };
    const UI = {
      $app: app, S, esc: (x) => String(x), fmt: (x) => x, badge: (x) => x,
      shell: (nav, title, active, html) => html, guard: () => true,
      invitationStatus: (error) => error || 'email sent',
    };
    const location = { hash: c.hash, replace() { throw new Error('Unexpected redirect'); } };
    const context = {
      window: { UI, Remote: null, addEventListener() {} }, document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
      location, FormData: class { constructor(form) { return Object.entries(form.values); } },
    };
    vm.runInNewContext(fs.readFileSync(c.file, 'utf8'), context);
    await Promise.resolve();
    const form = { dataset: { form: c.form }, values: { role: 'Nurse' }, closest() { return this; }, querySelector() { return button; } };
    let prevented = false;
    const pending = listeners.submit({ target: form, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, c.file);
    assert.equal(button.disabled, true, c.file);
    assert.doesNotMatch(app.innerHTML, /SMTP unavailable/, c.file);
    finish({ ok: false, error: 'SMTP unavailable' });
    await pending;
    assert.match(app.innerHTML, /SMTP unavailable/, c.file);
    assert.match(app.innerHTML, /setup-link/, c.file);
  }
});
