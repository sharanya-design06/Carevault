(function () {
  const { $app, S, esc, ROLE_HOME } = window.UI;
  let flashErr = '', flashSent = false, flashDone = false;

  function loginView(err) {
    return `<div class="auth-page">
      <header class="auth-header"><a class="auth-brand" href="/"><span class="auth-mark">+</span><span>Care Vault</span></a><a class="auth-home" href="/">Home</a></header>
      <main class="auth-layout">
        <section class="auth-intro" aria-labelledby="auth-title">
          <p class="eyebrow">DATA WITH A HUMAN PULSE</p>
          <h1 id="auth-title">Healthcare<br>Data<br><span>Warehouse.</span></h1>
          <p class="auth-copy">A secure, intelligent home for patient records, clinical insights, and the people who make better care possible.</p>
          <div class="auth-features"><span><i>&#10003;</i>Unified records</span><span><i>&#10003;</i>AI-assisted insights</span><span><i>&#10003;</i>Privacy by design</span></div>
        </section>
        <form class="login-panel" data-form="login" autocomplete="on">
          <p class="eyebrow">WELCOME BACK</p>
          <h2>Log in to Care Vault</h2>
          <p class="auth-copy">Enter your credentials to access your secure workspace.</p>
          <label for="email">Username or Email ID</label><input id="email" name="email" type="text" placeholder="Enter your username or email" required autocomplete="username">
          <label for="password">Password</label><input id="password" name="password" type="password" placeholder="Enter your password" required autocomplete="current-password">
          ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
          <div class="login-options"><span></span><a href="#/forgot-password">Forgot password?</a></div>
          <button class="primary login-submit" type="submit">Log In <span aria-hidden="true">&#8594;</span></button>
          <details class="demo-access"><summary>Demo account access</summary>
            <p class="mut">Sign in with your username or email.</p>
            <p class="mut">System Admin: sysadmin@carevault.com / Admin@123<br>Hospital Admin: admin@stmary.example / Hospital@123<br>PCC: pcc@stmary.example / Hospital@123<br>Doctor: jwu@stmary.example / Hospital@123<br>Lab Technician: lab@stmary.example / Hospital@123<br>Pharmacist: pharm@stmary.example / Hospital@123<br>Nurse: npatel@stmary.example / Hospital@123<br>Patient: anna.rivera@example.com / Hospital@123<br>Usernames: sysadmin, smgh.admin, pcc, jwu, lab, pharm, npatel, anna.rivera</p>
          </details>
        </form>
      </main>
    </div>`;
  }

  function forgotView(msg, sent) {
    if (sent) return `<div class="login"><h1>Check your email</h1><p>If the username and email match a registered account, a secure reset link valid for 30 minutes has been sent. It can be used once.</p>
      <p class="mut">Demo only: no real email is sent. <a href="#/outbox">Open the demo mailbox</a>.</p><a class="btn" href="#/">Back to sign in</a></div>`;
    return `<form class="login" data-form="forgot"><h1>Forgot password</h1>
      <label for="fu">Username</label><input id="fu" name="username" required autocomplete="username">
      <label for="fe">Registered email</label><input id="fe" name="email" type="email" required autocomplete="email">
      ${msg ? `<div class="err" role="alert">${esc(msg)}</div>` : ''}
      <p><button class="primary" type="submit">Send reset link</button> <a href="#/">Cancel</a></p></form>`;
  }

  function resetView(token, msg, done) {
    if (done) return `<div class="login"><h1>Password updated</h1><p>You can now sign in with your new password.</p><a class="btn primary" href="#/">Go to sign in</a></div>`;
    return `<form class="login" data-form="reset"><h1>Choose a new password</h1><input type="hidden" name="token" value="${esc(token)}">
      <label for="r1">New password</label><input id="r1" name="p1" type="password" required autocomplete="new-password">
      <label for="r2">Confirm password</label><input id="r2" name="p2" type="password" required autocomplete="new-password">
      ${msg ? `<div class="err" role="alert">${esc(msg)}</div>` : ''}
      <p><button class="primary" type="submit">Reset password</button></p></form>`;
  }

  function outboxView() {
    const m = S.mailbox();
    return `<div class="login"><h1>Demo mailbox</h1><p class="mut">Stands in for email delivery in this demo. Production sends these links by email only.</p>
      ${m.length ? m.map((x) => `<div class="card"><b>${esc(x.subject)}</b><div class="mut">To ${esc(x.to)}</div><a href="${esc(x.link)}">Open reset link</a></div>`).join('') : '<p>No pending messages.</p>'}
      <a class="btn" href="#/">Back to sign in</a></div>`;
  }

  function setupView(token, msg, done) {
    if (done) return `<div class="login"><h1>Password set</h1><p>Your account is now active.</p><a class="btn primary" href="/">Go to sign in</a></div>`;
    return `<form class="login" data-form="setup">
      <h1>Set your password</h1><input type="hidden" name="token" value="${esc(token)}">
      <label for="p1">New password</label><input id="p1" name="p1" type="password" required autocomplete="new-password">
      <label for="p2">Confirm password</label><input id="p2" name="p2" type="password" required autocomplete="new-password">
      ${msg ? `<div class="err" role="alert">${esc(msg)}</div>` : ''}
      <p><button class="primary" type="submit">Activate account</button></p></form>`;
  }

  const home = (role) => ROLE_HOME[role];

  async function render() {
    await S.ready();
    const hash = location.hash.replace(/^#\/?/, '');
    const [path, query] = hash.split('?');
    if (path === 'setup-password') { $app.innerHTML = setupView(new URLSearchParams(query || '').get('token') || '', flashErr); flashErr = ''; return; }
    if (path === 'forgot-password') { $app.innerHTML = forgotView(flashErr, flashSent); flashErr = ''; flashSent = false; return; }
    if (path === 'reset-password') { $app.innerHTML = resetView(new URLSearchParams(query || '').get('token') || '', flashErr, flashDone); flashErr = ''; flashDone = false; return; }
    if (path === 'outbox') { $app.innerHTML = outboxView(); return; }
    const s = S.session();
    if (s) { location.replace(home(s.role)); return; }
    $app.innerHTML = loginView(flashErr); flashErr = '';
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'login') {
      const r = await S.login(d.email, d.password);
      if (r.ok) location.href = home(r.role); else { flashErr = r.error; render(); }
    } else if (form.dataset.form === 'forgot') {
      await S.requestReset(d.username, d.email);
      flashSent = true; render();
    } else if (form.dataset.form === 'reset') {
      if (d.p1 !== d.p2) { flashErr = 'Passwords do not match.'; render(); return; }
      const r = await S.completeReset(d.token, d.p1);
      if (r.ok) flashDone = true; else flashErr = r.error;
      render();
    } else if (form.dataset.form === 'setup') {
      if (d.p1 !== d.p2) { flashErr = 'Passwords do not match.'; render(); return; }
      const r = await S.completeSetup(d.token, d.p1);
      if (r.ok) $app.innerHTML = setupView('', '', true); else { flashErr = r.error; render(); }
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
