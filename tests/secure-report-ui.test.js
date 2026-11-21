const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness(fetch, { search = '', storage = {} } = {}) {
  const html = fs.readFileSync('public/secure-reports/index.html', 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const startsHidden = (id) => new RegExp('<[^>]*\\sid="' + id + '"[^>]*\\shidden[\\s>]').test(html);
  const make = () => ({
    listeners: {}, children: [], textContent: '', hidden: false, disabled: false, checked: false, value: '', className: '',
    addEventListener(type, handler) { this.listeners[type] = handler; },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    removeAttribute(name) { delete this[name]; },
    querySelector() { return { disabled: false }; }, querySelectorAll() { return []; }, reset() {},
  });
  const elements = Object.fromEntries(ids.map((id) => [id, Object.assign(make(), { hidden: startsHidden(id) })]));
  const field = (value = '') => ({ value, files: [], addEventListener() {} });
  elements.pageTitle.hidden = false; elements.pageIntro.hidden = false;
  elements.login.elements = { email: field('doctor@example.test'), password: field('synthetic') };
  elements.upload.elements = { patientId: field(), title: field(), file: field() };
  elements.status.elements = { reportId: field('r1') };
  elements.page.elements = { number: field('1') };
  elements.rejectAction.value = 'reject';
  const context = {
    document: { getElementById: (id) => elements[id], createElement: make },
    window: { CAREVAULT_REMOTE: { apiKey: 'test' }, location: { search } }, URLSearchParams,
    sessionStorage: { getItem: (key) => (key in storage ? storage[key] : null), removeItem: (key) => { delete storage[key]; }, setItem: (key, value) => { storage[key] = value; } },
    setInterval: () => 1, clearInterval() {}, fetch, Date, Number, JSON, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    setTimeout: () => 1, clearTimeout() {}, atob: (v) => Buffer.from(v, 'base64').toString('binary'), btoa: (v) => Buffer.from(v, 'binary').toString('base64'),
    String, Uint8Array, Blob,
  };
  vm.runInNewContext(fs.readFileSync('public/assets/js/secure-reports.js', 'utf8'), context);
  return elements;
}

const ok = (result) => ({ ok: true, json: async () => ({ result }) });
const signIn = { ok: true, json: async () => ({ idToken: 't', expiresIn: '3600' }) };
const draft = {
  summary: { version: 'v1', model: 'carevault-extractive', modelVersion: '1.0.0', limitations: 'Unverified',
    statements: [{ text: '<img src=x onerror=alert(1)>', category: 'lab' }] },
  digest: 'd1', verification: { blocking: false, statements: [{ sources: [{ page: 1, line: 0, source: 'pdf' }], issues: [{ code: 'ocr-source' }] }] },
};

function api(role, calls = []) {
  return async (url, options) => {
    if (url.startsWith('https://identitytoolkit')) return signIn;
    const name = url.split('/').pop(), data = JSON.parse(options.body).data;
    calls.push({ name, data });
    if (name === 'getSecureReportIdentity') return ok({ role });
    if (name === 'getSecureReportAiConsent') return ok({ aiProcessingConsent: true });
    if (name === 'getSecureReportSummary') return ok(draft);
    return ok({ status: 'approved' });
  };
}

test('doctor sees staff tools, escaped statements with citations, and must confirm before approving', async () => {
  const calls = [], e = harness(api('doctor', calls));
  await e.login.listeners.submit({ preventDefault() {} });
  assert.equal(e.workspace.hidden, false);
  assert.equal(e.upload.hidden, false);
  assert.equal(e.generate.hidden, false);
  assert.equal(e.consentCard.hidden, true);
  await e.loadSummary.listeners.click();
  const list = e.summaryBody.children[1];
  assert.equal(list.children[0].children[0].textContent, '<img src=x onerror=alert(1)>', 'statement text is set as text, never HTML');
  assert.match(list.children[0].children[2].textContent, /ocr-source/);
  assert.equal(e.approve.disabled, false);
  await e.approve.listeners.click();
  assert.equal(calls.some((c) => c.name === 'reviewSecureReportSummary'), false, 'approval needs the confirmation box');
  e.sourceConfirmed.checked = true;
  await e.approve.listeners.click();
  const review = calls.find((c) => c.name === 'reviewSecureReportSummary');
  assert.deepEqual([review.data.action, review.data.digest, review.data.sourceReviewConfirmed], ['approve', 'd1', true]);
  assert.equal(e.summaryBody.children.length, 0);
});

test('patient sees consent controls but no staff tools or review controls', async () => {
  const e = harness(api('patient'));
  await e.login.listeners.submit({ preventDefault() {} });
  assert.equal(e.upload.hidden, true);
  assert.equal(e.generate.hidden, true);
  assert.equal(e.reviewControls.hidden, true);
  assert.equal(e.pageCard.hidden, true);
  assert.equal(e.consentCard.hidden, false);
  assert.equal(e.aiConsent.checked, true);
});

test('signing out clears the displayed summary and ignores an in-flight response', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const base = api('doctor');
  const e = harness(async (url, options) => url.endsWith('getSecureReportSummary') ? pending : base(url, options));
  await e.login.listeners.submit({ preventDefault() {} });
  const loading = e.loadSummary.listeners.click();
  e.logout.listeners.click();
  finish(ok(draft));
  await loading.catch(() => {});
  assert.equal(e.summaryBody.children.length, 0);
  assert.equal(e.workspace.hidden, true);
});

test('a sign-in for an unprovisioned account fails closed', async () => {
  const e = harness(async (url) => url.startsWith('https://identitytoolkit') ? signIn
    : { ok: false, json: async () => ({ error: { message: 'Report access denied.' } }) });
  await e.login.listeners.submit({ preventDefault() {} });
  assert.equal(e.workspace.hidden, true);
  assert.equal(e.login.hidden, false);
  assert.match(e.message.textContent, /access denied/i);
});

const future = () => Date.now() + 3600_000;
const dashboardSession = (role, email = 'doc@example.test') => JSON.stringify({ role, email, exp: future() });
const linked = (email = 'doc@example.test') => JSON.stringify({ idToken: 'linked-token', email, exp: future() });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('embedded in the doctor dashboard it uses the linked session and shows no sign-in', async () => {
  const seen = [];
  const e = harness(async (url, options) => {
    seen.push({ url, auth: options.headers && options.headers.Authorization });
    return api('doctor')(url, options);
  }, { search: '?embed=doctor', storage: {
    'carevault.session.v4': dashboardSession('doctor'), 'carevault.secure-report-session.v1': linked() } });
  await settle();
  assert.equal(e.login.hidden, true);
  assert.equal(e.workspace.hidden, false);
  assert.equal(e.pageTitle.hidden, true);
  assert.equal(e.upload.hidden, false);
  assert.ok(seen.length > 0 && seen.every((call) => call.auth === 'Bearer linked-token' && !call.url.includes('identitytoolkit')));
});

test('embedded in the patient dashboard it shows consent controls and no staff tools', async () => {
  const e = harness(api('patient'), { search: '?embed=patient', storage: {
    'carevault.session.v4': dashboardSession('patient', 'pat@example.test'), 'carevault.secure-report-session.v1': linked('pat@example.test') } });
  await settle();
  assert.equal(e.workspace.hidden, false);
  assert.equal(e.consentCard.hidden, false);
  assert.equal(e.upload.hidden, true);
  assert.equal(e.reviewControls.hidden, true);
});

test('embedded page refuses a missing, expired, mismatched or wrong-role link and never shows a login form', async () => {
  const cases = [
    ['no link', { 'carevault.session.v4': dashboardSession('doctor') }, /not linked/],
    ['other user\'s link', { 'carevault.session.v4': dashboardSession('doctor'), 'carevault.secure-report-session.v1': linked('someone.else@example.test') }, /not linked/],
    ['expired link', { 'carevault.session.v4': dashboardSession('doctor'), 'carevault.secure-report-session.v1': JSON.stringify({ idToken: 't', email: 'doc@example.test', exp: Date.now() - 1 }) }, /expired/],
    ['no dashboard session', { 'carevault.secure-report-session.v1': linked() }, /session has ended/],
    ['patient session in doctor frame', { 'carevault.session.v4': dashboardSession('patient'), 'carevault.secure-report-session.v1': linked() }, /does not match/],
  ];
  for (const [name, storage, message] of cases) {
    let called = false;
    const e = harness(async () => { called = true; return ok({}); }, { search: '?embed=doctor', storage });
    await settle();
    assert.equal(e.workspace.hidden, true, name);
    assert.equal(e.login.hidden, true, name);
    assert.equal(called, false, name + ' must not call the backend');
    assert.match(e.message.textContent, message, name);
  }
});

test('an account that is not enabled for secure reports gets a clear message', async () => {
  const e = harness(async () => ({ ok: false, json: async () => ({ error: { message: 'Report access denied.' } }) }), {
    search: '?embed=doctor', storage: { 'carevault.session.v4': dashboardSession('doctor'), 'carevault.secure-report-session.v1': linked() } });
  await settle();
  assert.equal(e.workspace.hidden, true);
  assert.match(e.message.textContent, /not enabled for secure report summaries/);
});
