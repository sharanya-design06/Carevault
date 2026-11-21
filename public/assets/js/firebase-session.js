/*
 * Firebase sign-in for the dashboards, over REST so the strict CSP stays intact (no SDK).
 * The session holds a Firebase ID token; every authorization decision is made by the server callables.
 */
(function () {
  const cfg = window.CAREVAULT_REMOTE || {};
  const SESSION_KEY = 'carevault.firebase-session.v1';
  const FUNCTIONS = 'https://asia-south1-' + cfg.projectId + '.cloudfunctions.net/';
  const ROLE_KEY = { SYSTEM_ADMIN: 'sysadmin', HOSPITAL_ADMIN: 'hospitaladmin', PCC: 'pcc', DOCTOR: 'doctor', LAB: 'lab', PHARMACIST: 'pharmacist', NURSE: 'nurse', PATIENT: 'patient' };
  const enabled = cfg.firebaseLogin === true;
  const configured = !!cfg.apiKey && !!cfg.projectId;
  const FAILED = { ok: false, error: 'Sign-in failed. Check your username/email and password.' };
  let expiryTimer, idleTimer, refreshing = null, revision = 0;
  const endListeners = new Set();
  const REFRESH_LEAD_MS = 5 * 60 * 1000, REFRESH_RETRY_MS = 30 * 1000;
  // Signed-in tabs that see no clicks or keys for this long are signed out on the server as well.
  const IDLE_MS = { patient: 30 * 60 * 1000, staff: 15 * 60 * 1000 };
  const ACTIVE_KEY = 'carevault.last-active.v1', DEVICE_KEY = 'carevault.device.v1';
  let lastTouch = 0;

  function endSession() {
    revision++;
    clearTimeout(expiryTimer);
    clearTimeout(idleTimer);
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(ACTIVE_KEY);
    endListeners.forEach((listener) => listener());
  }

  // A random per-browser id (kept only as a hash on the server) lets the server notice a sign-in from a new device.
  function deviceId() {
    try {
      if (typeof localStorage === 'undefined' || typeof crypto === 'undefined') return undefined;
      let id = localStorage.getItem(DEVICE_KEY);
      if (!/^[a-f0-9]{32}$/.test(id || '')) {
        id = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DEVICE_KEY, id);
      }
      return id;
    } catch (e) { return undefined; }
  }

  const touch = () => {
    const now = Date.now();
    if (now - lastTouch < 5000) return;
    lastTouch = now;
    try { sessionStorage.setItem(ACTIVE_KEY, String(now)); } catch (e) { /* storage unavailable */ }
  };
  const lastActive = () => Number(sessionStorage.getItem(ACTIVE_KEY)) || 0;

  function scheduleIdleCheck() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const session = read();
      if (!session) return;
      const last = lastActive();
      if (last && Date.now() - last > (session.role === 'patient' ? IDLE_MS.patient : IDLE_MS.staff)) { logout(); return; }
      scheduleIdleCheck();
    }, 30000);
  }

  async function callable(name, data, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(FUNCTIONS + name, { method: 'POST', headers, body: JSON.stringify({ data: data || {} }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const error = new Error((body.error && body.error.message) || 'Request failed');
      error.status = body.error && body.error.status;
      throw error;
    }
    return body.result;
  }

  const read = () => {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
      return configured && s && s.projectId === cfg.projectId && typeof s.idToken === 'string' && s.idToken &&
        Number.isFinite(s.exp) && Date.now() < s.exp ? s : null;
    } catch (e) { return null; }
  };

  // Swaps the refresh token for a new ID token shortly before the old one expires. A rejected refresh (revoked or
  // disabled account) ends the session; a network failure just leaves the current token to run out.
  function refreshSession() {
    if (refreshing) return refreshing;
    const session = read();
    if (!session || !session.refreshToken) return Promise.resolve(false);
    const requestRevision = revision;
    refreshing = (async () => {
      try {
        const response = await fetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(cfg.apiKey), {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(session.refreshToken),
        });
        const body = await response.json().catch(() => ({}));
        if (requestRevision !== revision) return false;
        if (!response.ok) { if (response.status === 400 || response.status === 401) endSession(); return false; }
        const seconds = Number(body.expires_in);
        const current = read();
        if (!current || typeof body.id_token !== 'string' || !body.id_token || !Number.isFinite(seconds) || seconds <= 0) return false;
        const next = { ...current, idToken: body.id_token, refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : current.refreshToken, exp: Date.now() + seconds * 1000 };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
        scheduleExpiry(next);
        return true;
      } catch (e) { return false; } finally { refreshing = null; }
    })();
    return refreshing;
  }

  function scheduleExpiry(session, retry = false) {
    clearTimeout(expiryTimer);
    const untilExpiry = session.exp - Date.now();
    const wait = !session.refreshToken ? untilExpiry : untilExpiry > REFRESH_LEAD_MS ? untilExpiry - REFRESH_LEAD_MS : retry ? Math.min(untilExpiry, REFRESH_RETRY_MS) : 0;
    expiryTimer = setTimeout(async () => {
      const current = read();
      if (!current) { endSession(); return; }
      if (current.refreshToken && current.exp - Date.now() <= REFRESH_LEAD_MS + 1000) {
        if (await refreshSession()) return;
        if (read()) scheduleExpiry(read(), true);
        else endSession();
        return;
      }
      scheduleExpiry(current);
    }, Math.min(Math.max(0, wait), 2147483647));
  }

  const identityPost = async (method, body) => {
    const path = method.startsWith('mfa') ? '/v2/accounts/' : '/v1/accounts:';
    const response = await fetch('https://identitytoolkit.googleapis.com' + path + method + '?key=' + encodeURIComponent(cfg.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { ok: response.ok, body: await response.json().catch(() => ({})) };
  };
  const firebaseError = (result) => (result.body.error && result.body.error.message) || '';
  const CODE = /^\d{6,8}$/;
  // The password-step credential and enrolment secret live only in memory, never in sessionStorage.
  let pending = null;

  // Turns a verified Firebase sign-in into a dashboard session, or parks it when a second factor is still missing.
  async function openSession(auth, email, requestRevision, fallbackSeconds) {
    const seconds = auth.expiresIn === undefined ? fallbackSeconds : Number(auth.expiresIn);
    if (typeof auth.idToken !== 'string' || !auth.idToken || !Number.isFinite(seconds) || seconds <= 0) return FAILED;
    const exp = Date.now() + seconds * 1000;
    const identity = await callable('getDashboardIdentity', { deviceId: deviceId() }, auth.idToken);
    const role = identity && Object.prototype.hasOwnProperty.call(ROLE_KEY, identity.role) && ROLE_KEY[identity.role];
    if (!role || typeof identity.uid !== 'string' || !identity.uid || Date.now() >= exp) return FAILED;
    if (requestRevision !== revision) return { ok: false, error: 'Sign-in was cancelled. Please try again.' };
    if (identity.mfaRequired && !identity.mfaVerified) {
      pending = { kind: 'enroll', idToken: auth.idToken, email: auth.email || email, revision: requestRevision };
      return { ok: false, mfaEnrollment: true };
    }
    const session = {
      id: identity.uid, name: auth.displayName || email, email: auth.email || email, role,
      hospitalId: identity.hospitalId || null, hrid: identity.patientId, subType: identity.subType,
      idToken: auth.idToken, exp, projectId: cfg.projectId,
      ...(typeof auth.refreshToken === 'string' && auth.refreshToken ? { refreshToken: auth.refreshToken } : {}),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    lastTouch = 0; touch();
    scheduleExpiry(session);
    scheduleIdleCheck();
    return { ok: true, role };
  }

  async function login(identifier, password) {
    if (!configured) return { ok: false, error: 'Firebase sign-in is not configured. Contact your administrator.' };
    const requestRevision = ++revision;
    pending = null;
    try {
      const { email } = await callable('lookupLoginEmail', { identifier: String(identifier) });
      const result = await identityPost('signInWithPassword', { email, password: String(password), returnSecureToken: true });
      const auth = result.body;
      if (result.ok && !auth.idToken && typeof auth.mfaPendingCredential === 'string' && Array.isArray(auth.mfaInfo)) {
        const factor = auth.mfaInfo.find((info) => info && info.totpInfo && info.mfaEnrollmentId);
        if (!factor) return { ok: false, error: 'Your account uses a verification method this site does not support. Contact your administrator.' };
        pending = { kind: 'signin', credential: auth.mfaPendingCredential, enrollmentId: factor.mfaEnrollmentId, email, revision: requestRevision };
        return { ok: false, mfaRequired: true };
      }
      if (!result.ok) return FAILED;
      return await openSession(auth, email, requestRevision, NaN);
    } catch (e) {
      console.warn('Firebase dashboard sign-in failed:', e.status || e.name);
      return { ok: false, error: 'Sign-in could not be completed. Check your credentials and try again; if the problem continues, contact your administrator.' };
    }
  }

  // Second step of sign-in for accounts that already have an authenticator app enrolled.
  async function verifyMfa(code) {
    const p = pending;
    if (!p || p.kind !== 'signin' || p.revision !== revision) return { ok: false, expired: true, error: 'Sign-in expired. Please start again.' };
    const verificationCode = String(code).trim();
    if (!CODE.test(verificationCode)) return { ok: false, error: 'Enter the 6-digit code from your authenticator app.' };
    try {
      const result = await identityPost('mfaSignIn:finalize', {
        mfaPendingCredential: p.credential, mfaEnrollmentId: p.enrollmentId, totpVerificationInfo: { verificationCode },
      });
      if (!result.ok) {
        if (/PENDING_CREDENTIAL/.test(firebaseError(result))) { pending = null; return { ok: false, expired: true, error: 'Sign-in expired. Please start again.' }; }
        return { ok: false, error: 'That code was not accepted. Check the time on your device and try the next code.' };
      }
      pending = null;
      return await openSession(result.body, p.email, p.revision, 3600);
    } catch (e) {
      console.warn('Firebase MFA sign-in failed:', e.status || e.name);
      return { ok: false, error: 'Verification could not be completed. Please try again.' };
    }
  }

  // Begins authenticator-app enrolment for a staff sign-in that has no second factor yet.
  async function startMfaEnrollment() {
    const p = pending;
    if (!p || p.kind !== 'enroll' || p.revision !== revision) return { ok: false, expired: true, error: 'Sign-in expired. Please start again.' };
    try {
      const result = await identityPost('mfaEnrollment:start', { idToken: p.idToken, totpEnrollmentInfo: {} });
      const info = result.body.totpSessionInfo;
      if (!result.ok || !info || !info.sharedSecretKey || !info.sessionInfo) {
        return { ok: false, error: /UNVERIFIED_EMAIL/.test(firebaseError(result))
          ? 'Your email address must be verified before two-step verification can be set up. Use the link in your invitation email first.'
          : 'Two-step verification could not be started. Please try again later.' };
      }
      p.sessionInfo = info.sessionInfo;
      const issuer = 'Care Vault';
      const uri = 'otpauth://totp/' + encodeURIComponent(issuer + ':' + p.email) + '?secret=' + encodeURIComponent(info.sharedSecretKey) +
        '&issuer=' + encodeURIComponent(issuer) + '&digits=' + (Number(info.verificationCodeLength) || 6) + '&period=' + (Number(info.periodSec) || 30);
      return { ok: true, secret: info.sharedSecretKey, uri };
    } catch (e) {
      return { ok: false, error: 'Two-step verification could not be started. Please try again later.' };
    }
  }

  // Confirms the first code. The user then signs in again, which runs the normal second step.
  async function finishMfaEnrollment(code) {
    const p = pending;
    if (!p || p.kind !== 'enroll' || !p.sessionInfo || p.revision !== revision) return { ok: false, expired: true, error: 'Sign-in expired. Please start again.' };
    const verificationCode = String(code).trim();
    if (!CODE.test(verificationCode)) return { ok: false, error: 'Enter the 6-digit code from your authenticator app.' };
    try {
      const result = await identityPost('mfaEnrollment:finalize', {
        idToken: p.idToken, displayName: 'Authenticator app', totpVerificationInfo: { sessionInfo: p.sessionInfo, verificationCode },
      });
      if (!result.ok) return { ok: false, error: 'That code was not accepted. Check the time on your device and try the next code.' };
      pending = null;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Verification could not be completed. Please try again.' };
    }
  }

  const cancelMfa = () => { pending = null; };

  // Patient sign-in with an emailed one-time code. The server returns a custom token only for a PATIENT account.
  async function requestOtp(identifier) {
    if (!configured) return { ok: false, error: 'Firebase sign-in is not configured. Contact your administrator.' };
    try {
      await callable('requestPatientOtp', { identifier: String(identifier).trim() });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.status === 'RESOURCE_EXHAUSTED' ? 'Too many attempts. Try again in a minute.' : 'A code could not be sent right now. Please try again.' };
    }
  }

  async function verifyOtp(identifier, code) {
    if (!configured) return { ok: false, error: 'Firebase sign-in is not configured. Contact your administrator.' };
    const value = String(code).trim();
    if (!/^\d{6}$/.test(value)) return { ok: false, error: 'Enter the 6-digit code from your email.' };
    const requestRevision = ++revision;
    pending = null;
    try {
      const { token } = await callable('verifyPatientOtp', { identifier: String(identifier).trim(), code: value });
      const result = await identityPost('signInWithCustomToken', { token, returnSecureToken: true });
      if (!result.ok) return { ok: false, error: 'Sign-in could not be completed. Please request a new code.' };
      return await openSession(result.body, String(identifier).trim(), requestRevision, NaN);
    } catch (e) {
      return { ok: false, error: e.status === 'RESOURCE_EXHAUSTED' ? 'Too many attempts. Try again in a minute.' : 'That code was not accepted. Request a new one and try again.' };
    }
  }

  async function requestPasswordReset(email) {
    if (!configured) throw new Error('Firebase sign-in is not configured. Contact your administrator.');
    const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(cfg.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: String(email).trim() }),
    });
    const body = await response.json();
    if (!response.ok && (!body.error || body.error.message !== 'EMAIL_NOT_FOUND')) {
      throw new Error('Password reset is temporarily unavailable. Please try again later.');
    }
  }

  async function call(name, data) {
    let s = read();
    if (s && s.refreshToken && s.exp - Date.now() < 60000) { await refreshSession(); s = read(); }
    if (!s) throw new Error('Signed out');
    const requestRevision = revision;
    try {
      const result = await callable(name, data, s.idToken);
      const current = read();
      if (revision !== requestRevision || !current || current.idToken !== s.idToken) throw new Error('Signed out');
      return result;
    } catch (error) {
      if (revision !== requestRevision) throw new Error('Signed out');
      if (error.status === 'UNAUTHENTICATED') endSession();
      throw error;
    }
  }

  // Signing out also revokes the account's refresh tokens on the server, so a copied token stops working at once.
  function logout() {
    const session = read();
    if (session) {
      try {
        Promise.resolve(fetch(FUNCTIONS + 'revokeMySessions', {
          method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.idToken }, body: '{"data":{}}',
        })).catch(() => {});
      } catch (e) { /* best effort; the local session still ends */ }
    }
    endSession();
  }

  if (enabled) {
    const session = read();
    if (session) {
      const last = lastActive();
      if (last && Date.now() - last > (session.role === 'patient' ? IDLE_MS.patient : IDLE_MS.staff)) logout();
      else { scheduleExpiry(session); scheduleIdleCheck(); }
    }
    ['click', 'keydown', 'pointerdown', 'touchstart'].forEach((type) => window.addEventListener(type, touch, { passive: true }));
    window.addEventListener('storage', (event) => {
      if (event.storageArea === sessionStorage && event.key === SESSION_KEY) {
        revision++;
        clearTimeout(expiryTimer);
        endListeners.forEach((listener) => listener());
      }
    });
  }
  window.FirebaseSession = {
    enabled, login, requestOtp, verifyOtp, verifyMfa, startMfaEnrollment, finishMfaEnrollment, cancelMfa,
    call, session: read, requestPasswordReset, logout,
    onEnd(listener) { endListeners.add(listener); },
  };
})();
