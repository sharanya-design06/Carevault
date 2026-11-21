// Completes a single-use, 5-minute invitation. The token is removed from the address bar immediately and checked by the server.
(function () {
  const cfg = window.CAREVAULT_REMOTE || {};
  const BASE = 'https://asia-south1-' + encodeURIComponent(cfg.projectId || '') + '.cloudfunctions.net/';
  const $ = (id) => document.getElementById(id);
  const token = new URLSearchParams(location.search).get('token');
  history.replaceState(null, '', location.pathname);

  const call = async (name, data) => {
    const response = await fetch(BASE + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const error = new Error(body.error && body.error.message || 'FAILED');
      error.status = body.error && body.error.status;
      throw error;
    }
    return body.result;
  };
  const invalid = () => { $('status').textContent = 'This link is invalid, has expired or was already used. Ask your administrator to send a new one.'; };

  async function start() {
    if (!token || !cfg.projectId) { invalid(); return; }
    try {
      const info = await call('checkDashboardInvite', { token });
      $('email').textContent = info.email;
      $('status').hidden = true;
      $('form').hidden = false;
    } catch (e) { invalid(); }
  }

  $('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = $('err');
    err.hidden = true;
    if ($('pw').value !== $('pw2').value) { err.textContent = 'Passwords do not match.'; err.hidden = false; return; }
    $('form').querySelector('button').disabled = true;
    try {
      await call('completeDashboardInvite', { token, password: $('pw').value });
      $('form').hidden = true;
      $('done').hidden = false;
    } catch (e) {
      err.textContent = e.status === 'INVALID_ARGUMENT' ? e.message : 'This link is invalid, has expired or was already used.';
      err.hidden = false;
      if (e.status === 'INVALID_ARGUMENT') $('form').querySelector('button').disabled = false;
    }
  });

  start();
})();
