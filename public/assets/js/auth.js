(function () {
  const { $app, S, esc, ROLE_HOME } = window.UI;
  const FS = window.FirebaseSession;
  let flashErr = '', flashSent = false, flashDone = false, flashInfo = '';
  // 'code' asks for an authenticator code; 'enroll' shows first-time setup (enrollInfo holds the setup key).
  let mfaStage = '', enrollInfo = null;
  let otpIdentifier = '';

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
          ${flashInfo ? `<p class="mut" role="status">${esc(flashInfo)}</p>` : ''}
          ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
          <div class="login-options">${FS.enabled ? '<a href="#/otp">Patient? Sign in with a one-time code</a>' : '<span></span>'}<a href="#/forgot-password">Forgot password?</a></div>
          <button class="primary login-submit" type="submit">Log In <span aria-hidden="true">&#8594;</span></button>
          <p class="mut">${FS.enabled ? 'Synthetic demo data only. Sign in with your provisioned Firebase account.' : 'Synthetic demo data only. Secure AI Reports use a separately authorized Firebase account.'}</p>
        </form>
      </main>
    </div>`;
  }

  function mfaView(err) {
    const note = '<p class="mut"><a href="#/" data-action="cancel-mfa">Cancel and sign in again</a></p>';
    if (mfaStage === 'enroll') {
      return `<form class="login" data-form="mfa-enroll"><h1>Set up two-step verification</h1>
        <p>Staff accounts need an authenticator app (such as Google Authenticator or Microsoft Authenticator).</p>
        <ol><li>In the app, add an account and choose <b>Enter a setup key</b>.</li>
        <li>Enter this key: <code>${esc(enrollInfo ? enrollInfo.secret : '')}</code></li>
        <li>Type the 6-digit code the app shows.</li></ol>
        <label for="mc">6-digit code</label><input id="mc" name="code" inputmode="numeric" pattern="[0-9]{6,8}" maxlength="8" required autocomplete="one-time-code">
        ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
        <p><button class="primary" type="submit">Turn on two-step verification</button></p>${note}</form>`;
    }
    return `<form class="login" data-form="mfa"><h1>Two-step verification</h1>
      <p>Enter the 6-digit code from your authenticator app.</p>
      <label for="mc">6-digit code</label><input id="mc" name="code" inputmode="numeric" pattern="[0-9]{6,8}" maxlength="8" required autocomplete="one-time-code">
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Verify</button></p>${note}</form>`;
  }

  // Patients may sign in with a code emailed to their registered address instead of a password.
  function otpView(err) {
    if (otpIdentifier) {
      return `<form class="login" data-form="otp-verify"><h1>Enter your code</h1>
        <p>If an account matches, a 6-digit code was sent to its registered email. It expires in 5 minutes.</p>
        <label for="oc">6-digit code</label><input id="oc" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">
        ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
        <p><button class="primary" type="submit">Sign in</button> <a href="#/otp" data-action="otp-restart">Use a different account</a></p></form>`;
    }
    return `<form class="login" data-form="otp-request"><h1>Patient sign-in</h1>
      <label for="oi">Registered email or phone number</label><input id="oi" name="identifier" required maxlength="120" autocomplete="username">
      ${err ? `<div class="err" role="alert">${esc(err)}</div>` : ''}
      <p><button class="primary" type="submit">Email me a code</button> <a href="#/">Back to sign in</a></p>
      <p class="mut">Staff accounts sign in with a password and two-step verification instead.</p></form>`;
  }

  function forgotView(msg, sent) {
    if (FS.enabled) {
      if (sent) return `<div class="login"><h1>Check your email</h1><p>If an account exists for that email, Firebase will send a password reset link.</p><a class="btn" href="#/">Back to sign in</a></div>`;
      return `<form class="login" data-form="forgot"><h1>Forgot password</h1>
        <label for="fe">Account email</label><input id="fe" name="email" type="email" required autocomplete="email">
        ${msg ? `<div class="err" role="alert">${esc(msg)}</div>` : ''}
        <p><button class="primary" type="submit">Send reset link</button> <a href="#/">Cancel</a></p></form>`;
    }
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
    if (!FS.enabled) await S.ready();
    const hash = location.hash.replace(/^#\/?/, '');
    const [path, query] = hash.split('?');
    if (FS.enabled && ['setup-password', 'reset-password', 'outbox'].includes(path)) {
      $app.innerHTML = loginView('This demo link is not valid for Firebase accounts. Request a new password reset.'); return;
    }
    if (path === 'setup-password') { $app.innerHTML = setupView(new URLSearchParams(query || '').get('token') || '', flashErr); flashErr = ''; return; }
    if (path === 'forgot-password') { $app.innerHTML = forgotView(flashErr, flashSent); flashErr = ''; flashSent = false; return; }
    if (path === 'reset-password') { $app.innerHTML = resetView(new URLSearchParams(query || '').get('token') || '', flashErr, flashDone); flashErr = ''; flashDone = false; return; }
    if (path === 'outbox') { $app.innerHTML = outboxView(); return; }
    if (FS.enabled && path === 'otp') { $app.innerHTML = otpView(flashErr); flashErr = ''; return; }
    if (FS.enabled && mfaStage) { $app.innerHTML = mfaView(flashErr); flashErr = ''; return; }
    const s = FS.enabled ? FS.session() : S.session();
    if (s) { location.replace(home(s.role)); return; }
    if (!FS.enabled) sessionStorage.removeItem('carevault.secure-report-session.v1');
    $app.innerHTML = loginView(flashErr); flashErr = ''; flashInfo = '';
  }

  const endMfa = () => { mfaStage = ''; enrollInfo = null; FS.cancelMfa(); };

  // Moves the page on after a login or code attempt that may still need a second factor.
  async function afterSignIn(r) {
    if (r.ok) { location.href = home(r.role); return; }
    if (r.mfaRequired) { mfaStage = 'code'; render(); return; }
    if (r.mfaEnrollment) {
      const info = await FS.startMfaEnrollment();
      if (info.ok) { mfaStage = 'enroll'; enrollInfo = info; } else { endMfa(); flashErr = info.error; }
      render(); return;
    }
    if (r.expired) endMfa();
    flashErr = r.error; render();
  }

  // Signs the same credentials into Firebase Auth so the embedded AI summaries need no second sign-in.
  // A session exists only if a Firebase account with this email and password exists; the dashboard login is unaffected.
  const SECURE_KEY = 'carevault.secure-report-session.v1';
  async function linkSecureReports(email, password) {
    sessionStorage.removeItem(SECURE_KEY);
    const apiKey = (window.CAREVAULT_REMOTE || {}).apiKey;
    if (!apiKey || !email) return;
    try {
      const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email), password: String(password), returnSecureToken: true }),
      });
      const auth = await response.json(), seconds = Number(auth.expiresIn);
      if (response.ok && typeof auth.idToken === 'string' && auth.idToken && Number.isFinite(seconds) && seconds > 0) {
        sessionStorage.setItem(SECURE_KEY, JSON.stringify({ idToken: auth.idToken, email: String(auth.email || email).toLowerCase(), exp: Date.now() + seconds * 1000 }));
      }
    } catch (e) { /* secure reports stay unavailable */ }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'login') {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      let r;
      try { r = FS.enabled ? await FS.login(d.email, d.password) : await S.login(d.email, d.password); }
      finally { button.disabled = false; }
      if (FS.enabled) { await afterSignIn(r); return; }
      if (r.ok) {
        if (!(window.FirebaseSession && window.FirebaseSession.enabled)) await linkSecureReports(((S.session() || {}).email) || d.email, d.password);
        location.href = home(r.role);
      } else { flashErr = r.error; render(); }
    } else if (form.dataset.form === 'otp-request') {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      let r;
      try { r = await FS.requestOtp(d.identifier); } finally { button.disabled = false; }
      if (r.ok) otpIdentifier = String(d.identifier).trim(); else flashErr = r.error;
      render();
    } else if (form.dataset.form === 'otp-verify') {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      let r;
      try { r = await FS.verifyOtp(otpIdentifier, d.code); } finally { button.disabled = false; }
      if (r.ok) { otpIdentifier = ''; location.href = home(r.role); return; }
      flashErr = r.error; render();
    } else if (form.dataset.form === 'mfa') {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      let r;
      try { r = await FS.verifyMfa(d.code); } finally { button.disabled = false; }
      if (r.ok) mfaStage = '';
      await afterSignIn(r);
    } else if (form.dataset.form === 'mfa-enroll') {
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      let r;
      try { r = await FS.finishMfaEnrollment(d.code); } finally { button.disabled = false; }
      if (r.ok) { endMfa(); FS.logout(); flashInfo = 'Two-step verification is on. Sign in again to continue.'; render(); }
      else { if (r.expired) endMfa(); flashErr = r.error; render(); }
    } else if (form.dataset.form === 'forgot') {
      if (FS.enabled) {
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        try { await FS.requestPasswordReset(d.email); flashSent = true; }
        catch (error) {
          flashErr = error.message === 'Firebase sign-in is not configured. Contact your administrator.'
            ? error.message : 'Password reset is temporarily unavailable. Please try again later.';
        }
        finally { button.disabled = false; }
      } else {
        await S.requestReset(d.username, d.email);
        flashSent = true;
      }
      render();
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

  document.addEventListener('click', (e) => {
    const link = e.target.closest && e.target.closest('[data-action="cancel-mfa"]');
    if (link) { endMfa(); render(); }
    if (e.target.closest && e.target.closest('[data-action="otp-restart"]')) { otpIdentifier = ''; render(); }
  });
  window.addEventListener('hashchange', render);
  render();
})();
