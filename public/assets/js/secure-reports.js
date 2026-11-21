(function () {
  'use strict';
  const BASE = 'https://asia-south1-care-vault-project.cloudfunctions.net/';
  const $ = (id) => document.getElementById(id);
  const el = { login: $('login'), workspace: $('workspace'), message: $('message'), who: $('who'), upload: $('upload'),
    status: $('status'), result: $('result'), retry: $('retry'), loadOriginal: $('loadOriginal'), original: $('originalPdf'),
    consentCard: $('consentCard'), aiConsent: $('aiConsent'), summaryCard: $('summaryCard'), generate: $('generate'),
    aiStatus: $('aiStatus'), body: $('summaryBody'), review: $('reviewControls'), confirmed: $('sourceConfirmed'),
    approve: $('approve'), reject: $('reject'), rejectAction: $('rejectAction'), comment: $('comment'),
    pageCard: $('pageCard'), page: $('page'), pageText: $('pageText'), title: $('summaryTitle') };
  let token = '', expiresAt = 0, role = '', draft = null, pollTimer = 0, originalUrl = '', epoch = 0, watchTimer = 0;
  const embedRole = new URLSearchParams(window.location.search).get('embed');
  const BRIDGE_KEY = 'carevault.secure-report-session.v1', DASHBOARD_KEY = 'carevault.session.v4';

  const notice = (text, bad) => { el.message.textContent = text; el.message.className = 'alert' + (bad ? ' danger' : ''); };
  const reportId = () => el.status.elements.reportId.value.trim();

  function clearDraft() {
    draft = null; el.body.replaceChildren(); el.confirmed.checked = false; el.approve.disabled = true; el.reject.disabled = true;
  }
  function clearOriginal() {
    el.original.hidden = true; el.original.removeAttribute('src');
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    originalUrl = '';
  }
  function signOut(text) {
    epoch++; token = ''; expiresAt = 0; role = ''; clearTimeout(pollTimer); clearInterval(watchTimer);
    clearDraft(); clearOriginal(); el.pageText.textContent = ''; el.result.textContent = ''; el.aiStatus.textContent = '';
    el.workspace.hidden = true; el.login.hidden = !!embedRole; el.login.reset(); el.upload.reset(); el.status.reset();
    notice(text || 'Signed out.');
  }

  async function call(name, data) {
    if (!token || Date.now() >= expiresAt) { signOut('Session expired. Sign in again.'); throw new Error('Session expired.'); }
    const mine = epoch;
    const response = await fetch(BASE + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ data }),
    });
    const payload = await response.json().catch(() => ({}));
    if (mine !== epoch) throw new Error('Session changed.');
    if (!response.ok || payload.error) throw new Error((payload.error && payload.error.message) || 'Request failed.');
    return payload.result;
  }

  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (className) n.className = className;
    return n;
  }

  function renderSummary(value) {
    el.body.replaceChildren();
    el.body.appendChild(node('p', 'Engine: ' + value.summary.model + ' ' + value.summary.modelVersion + ' · version ' + value.summary.version, 'mut'));
    const list = node('ol');
    value.summary.statements.forEach((statement, index) => {
      const item = node('li');
      item.appendChild(node('p', statement.text));
      const check = value.verification && value.verification.statements[index];
      if (check) {
        check.sources.forEach((source) => {
          const button = node('button', 'Page ' + source.page + ', line ' + (source.line + 1) + (source.source ? ' (' + source.source.toUpperCase() + ')' : ''), 'sm');
          button.type = 'button';
          button.addEventListener('click', () => showPage(source.page, source.line).catch((e) => notice(e.message, true)));
          item.appendChild(button);
        });
        const flags = check.issues.map((issue) => issue.code + (issue.claim ? ' (' + issue.claim + ')' : ''));
        if (flags.length) item.appendChild(node('p', 'Review flags: ' + flags.join(', '), 'mut'));
      }
      list.appendChild(item);
    });
    el.body.appendChild(list);
    el.body.appendChild(node('p', 'Limitations: ' + value.summary.limitations, 'mut'));
  }

  async function showPage(number, highlight) {
    const value = await call('getSecureReportPage', { reportId: reportId(), page: Number(number) });
    el.page.elements.number.value = String(number);
    el.pageText.textContent = value.page.lines.map((line, i) =>
      (i === highlight ? '> ' : '  ') + (i + 1) + ' [' + line.source + '] ' + line.text).join('\n') || 'No text extracted.';
  }

  async function loadSummary() {
    clearDraft();
    const mine = epoch, id = reportId();
    const value = await call('getSecureReportSummary', { reportId: id });
    if (mine !== epoch || id !== reportId()) return;
    draft = { reportId: id, version: value.summary.version, digest: value.digest };
    renderSummary(value);
    if (role === 'doctor') {
      el.approve.disabled = false; el.reject.disabled = false;
      notice('Compare every statement with the original report before approving.');
    } else notice('Clinician-approved summary loaded.');
  }

  async function poll() {
    clearTimeout(pollTimer);
    const value = await call('getSecureReportStatus', { reportId: reportId() });
    el.result.textContent = 'Status: ' + value.status + (value.pageCount ? ' · pages: ' + value.pageCount : '') +
      (value.unreadablePages.length ? ' · unreadable pages: ' + value.unreadablePages.join(', ') : '') +
      (value.error ? ' · ' + value.error : '') + (value.aiStatus !== 'not-started' ? ' · AI: ' + value.aiStatus : '');
    el.retry.hidden = value.status !== 'failed';
    el.loadOriginal.hidden = false;
    if (['queued', 'processing'].includes(value.status)) pollTimer = setTimeout(() => poll().catch((e) => notice(e.message, true)), 3000);
  }

  async function activate(identity) {
    role = identity.role;
    const staff = role === 'doctor' || role === 'lab';
    el.who.textContent = 'Signed in as ' + role;
    el.upload.hidden = !staff; el.status.hidden = !staff; el.pageCard.hidden = !staff; el.loadOriginal.hidden = !staff;
    el.summaryCard.hidden = role === 'lab';
    el.generate.hidden = role !== 'doctor'; el.review.hidden = role !== 'doctor';
    el.consentCard.hidden = role !== 'patient';
    el.title.textContent = role === 'doctor' ? 'Clinician summary review' : 'Approved summary';
    if (role === 'patient') {
      el.status.hidden = false;
      el.status.querySelectorAll('#retry, #loadOriginal, #checkStatus').forEach((n) => { n.hidden = true; });
      el.aiConsent.checked = (await call('getSecureReportAiConsent', {})).aiProcessingConsent === true;
    }
    el.login.hidden = true; el.workspace.hidden = false;
    notice('Signed in. Use synthetic data only.');
  }

  el.login.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = el.login.querySelector('button'); button.disabled = true;
    try {
      const apiKey = window.CAREVAULT_REMOTE && window.CAREVAULT_REMOTE.apiKey;
      if (!apiKey) throw new Error('Firebase API key is not configured.');
      const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: el.login.elements.email.value.trim(), password: el.login.elements.password.value, returnSecureToken: true }),
      });
      const payload = await response.json();
      if (response.ok && !payload.idToken && payload.mfaPendingCredential) throw new Error('This account uses two-step verification. Sign in on the main login page first, then open this page.');
      if (!response.ok || !payload.idToken) throw new Error('Sign-in failed. Check your email and password.');
      token = payload.idToken; expiresAt = Date.now() + Number(payload.expiresIn) * 1000;
      await activate(await call('getSecureReportIdentity', {}));
    } catch (error) { signOut(error.message); notice(error.message, true); } finally { button.disabled = false; }
  });

  el.upload.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = el.upload.elements.file.files[0], button = el.upload.querySelector('button');
    if (!file || file.size > 10 * 1024 * 1024) { notice('Choose a PDF of at most 10 MiB.', true); return; }
    button.disabled = true; notice('Uploading…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const value = await call('uploadSecureReport', {
        patientId: el.upload.elements.patientId.value.trim(), title: el.upload.elements.title.value.trim(), pdf: btoa(binary),
      });
      el.status.elements.reportId.value = value.reportId; clearDraft(); clearOriginal();
      notice('Uploaded. Report ID: ' + value.reportId); el.upload.reset(); await poll();
    } catch (error) { notice(error.message, true); } finally { button.disabled = false; }
  });

  el.status.addEventListener('submit', (event) => {
    event.preventDefault(); clearDraft(); clearOriginal();
    poll().catch((error) => notice(error.message, true));
  });
  el.status.elements.reportId.addEventListener('input', () => { clearDraft(); clearOriginal(); el.pageText.textContent = ''; });

  el.retry.addEventListener('click', async () => {
    try { await call('retrySecureReport', { reportId: reportId() }); notice('Retry queued.'); await poll(); }
    catch (error) { notice(error.message, true); }
  });

  el.loadOriginal.addEventListener('click', async () => {
    clearOriginal();
    try {
      const value = await call('getSecureReportOriginal', { reportId: reportId() });
      const binary = atob(value.pdf), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      originalUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      el.original.src = originalUrl; el.original.hidden = false;
    } catch (error) { notice(error.message, true); }
  });

  el.page.addEventListener('submit', (event) => {
    event.preventDefault();
    showPage(el.page.elements.number.value).catch((error) => notice(error.message, true));
  });

  el.generate.addEventListener('click', async () => {
    el.generate.disabled = true; clearDraft(); el.aiStatus.textContent = 'Generating…';
    try {
      const value = await call('requestSecureReportSummary', { reportId: reportId() });
      el.aiStatus.textContent = 'AI summary: ' + value.status + (value.error ? '. ' + value.error : '');
      if (value.status === 'complete') await loadSummary();
    } catch (error) { el.aiStatus.textContent = ''; notice(error.message, true); } finally { el.generate.disabled = false; }
  });

  $('loadSummary').addEventListener('click', () => loadSummary().catch((error) => notice(error.message, true)));

  async function review(action) {
    const current = draft;
    if (!current || current.reportId !== reportId()) { clearDraft(); notice('Report changed. Load the summary again.', true); return; }
    if (action === 'approve' && !el.confirmed.checked) { notice('Confirm that you compared every statement with the original report.', true); return; }
    el.approve.disabled = true; el.reject.disabled = true;
    try {
      await call('reviewSecureReportSummary', { ...current, action, sourceReviewConfirmed: el.confirmed.checked, comment: el.comment.value });
      clearDraft(); el.comment.value = ''; notice(action === 'approve' ? 'Summary approved.' : 'Summary rejected.');
    } catch (error) { clearDraft(); notice(error.message + ' Load the summary again.', true); }
  }
  el.approve.addEventListener('click', () => review('approve'));
  el.reject.addEventListener('click', () => review(el.rejectAction.value));

  $('saveConsent').addEventListener('click', async () => {
    try {
      const value = await call('setSecureReportAiConsent', { aiProcessingConsent: el.aiConsent.checked });
      el.aiConsent.checked = value.aiProcessingConsent;
      if (!value.aiProcessingConsent) clearDraft();
      notice(value.aiProcessingConsent ? 'AI processing consent saved.' : 'AI processing consent withdrawn.');
    } catch (error) { notice(error.message, true); }
  });

  $('logout').addEventListener('click', () => signOut('Signed out.'));

  // Inside a dashboard the page reuses the session linked at dashboard login; it never shows a second sign-in.
  function dashboardLink() {
    const read = (key) => { try { return JSON.parse(sessionStorage.getItem(key)); } catch (e) { return null; } };
    const dashboard = read(DASHBOARD_KEY), linked = read(BRIDGE_KEY);
    if (!['doctor', 'lab', 'patient'].includes(embedRole)) return { error: 'This page was opened with an unsupported dashboard role.' };
    if (!dashboard || Date.now() >= dashboard.exp) return { error: 'Your dashboard session has ended. Sign in again from the CareVault login page.' };
    if (dashboard.role !== embedRole) return { error: 'This section does not match your signed-in dashboard role.' };
    if (!linked || typeof linked.idToken !== 'string' || !linked.idToken ||
        String(linked.email || '').toLowerCase() !== String(dashboard.email || '').toLowerCase()) {
      return { error: 'Your dashboard login is not linked to secure reports. Sign out and sign in again; if this continues, ask an administrator to enable your account.' };
    }
    if (!Number.isFinite(linked.exp) || Date.now() >= linked.exp) {
      return { error: 'Your secure-report session expired. Sign out and sign in again from the CareVault login page.' };
    }
    return { token: linked.idToken, exp: linked.exp };
  }

  async function startEmbedded() {
    $('pageTitle').hidden = true; $('pageIntro').hidden = true; el.login.hidden = true;
    const link = dashboardLink();
    if (link.error) { notice(link.error, true); return; }
    token = link.token; expiresAt = link.exp;
    try {
      const identity = await call('getSecureReportIdentity', {});
      if (identity.role !== embedRole) throw new Error('mismatch');
      await activate(identity);
      el.who.hidden = true; $('logout').hidden = true;
      watchTimer = setInterval(() => {
        const state = dashboardLink();
        if (state.error) signOut(state.error);
      }, 5000);
    } catch (error) {
      token = ''; expiresAt = 0;
      notice(error.message === 'Session expired.' ? 'Your secure-report session expired. Sign out and sign in again.'
        : 'Your account is not enabled for secure report summaries. Ask an administrator to enable it.', true);
    }
  }
  if (embedRole) startEmbedded();

})();
