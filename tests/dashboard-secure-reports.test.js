const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function render(file, expectedRole) {
  const app = { innerHTML: '' };
  let navigation, active;
  const store = {
    ready: async () => {},
    session: () => ({ role: expectedRole }),
    touch() {},
    patientOverview: () => ({}),
  };
  const ui = {
    $app: app,
    S: store,
    esc: (value) => String(value),
    fmt: String,
    badge: String,
    toast() {},
    logTable: () => '',
    reportSummary: () => '',
    guard: (role) => role === expectedRole,
    shell(nav, _title, selected, html) {
      navigation = nav;
      active = selected;
      return html;
    },
  };
  const window = { UI: ui, addEventListener() {} };
  const context = {
    window,
    document: { addEventListener() {} },
    location: { hash: '#/secure-ai' },
    clearTimeout() {},
    setTimeout() { return 1; },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { app, navigation, active };
}

test('doctor dashboard contains an embedded role-bound AI report review section', async () => {
  const result = await render('public/doctor/app.js', 'doctor');
  assert.equal(result.active, 'secure-ai');
  assert.ok(result.navigation.some(([route, label]) => route === 'secure-ai' && label === 'AI Report Review'));
  assert.match(result.app.innerHTML, /src="\/secure-reports\/\?embed=doctor"/);
  assert.match(result.app.innerHTML, /Synthetic data only/);
});

test('patient dashboard contains an embedded role-bound approved-summary section', async () => {
  const result = await render('public/patient/app.js', 'patient');
  assert.equal(result.active, 'secure-ai');
  assert.ok(result.navigation.some(([route, label]) => route === 'secure-ai' && label === 'AI Summaries'));
  assert.match(result.app.innerHTML, /src="\/secure-reports\/\?embed=patient"/);
  assert.match(result.app.innerHTML, /Only clinician-approved summaries are available/);
});
