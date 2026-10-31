(function () {
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const S = window.Store;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const badge = (s) => `<span class="badge ${esc(s)}">${esc(s)}</span>`;
  const hname = (id) => { const h = id && S.hospital(id); return h ? esc(h.name) : '—'; };

  let toastT;
  function toast(msg) {
    $toast.textContent = msg; $toast.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => $toast.classList.remove('show'), 2800);
  }

  function shell(nav, title, active, html) {
    const s = S.session();
    return `<div class="layout">
      <nav class="side" aria-label="Main"><div class="brand">CareVault</div>
        ${nav.map(([r, l]) => `<a href="#/${r}" class="${r === active ? 'active' : ''}">${l}</a>`).join('')}
      </nav>
      <div class="main">
        <header class="top"><span class="mut">${esc(title)}</span>
          <span>${esc(s.name)} <span class="mut">(${esc(s.email)})</span> <button class="sm" data-action="logout">Sign out</button></span></header>
        <main class="content">${html}</main>
      </div></div>`;
  }

  function logTable(rows, compact) {
    if (!rows.length) return '<p class="mut">No matching events.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Time</th>${compact ? '' : '<th>Hospital</th>'}<th>Category</th><th>Event</th><th>Actor</th><th>Outcome</th>${compact ? '' : '<th>IP</th>'}</tr></thead><tbody>
      ${rows.map((l) => `<tr><td>${fmt(l.ts)}</td>${compact ? '' : `<td>${hname(l.hospitalId)}</td>`}<td>${esc(l.category)}</td><td>${esc(l.action)}</td><td>${esc(l.actor)}</td><td>${badge(l.outcome)}</td>${compact ? '' : `<td>${esc(l.ip)}</td>`}</tr>`).join('')}
      </tbody></table></div>`;
  }

  function csv(rows) {
    const q = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
    return ['Time,Hospital,Category,Event,Actor,Outcome,IP'].concat(rows.map((l) => [l.ts, (S.hospital(l.hospitalId) || {}).name, l.category, l.action, l.actor, l.outcome, l.ip].map(q).join(','))).join('\n');
  }

  const ROLE_HOME = { sysadmin: '/system-admin/', hospitaladmin: '/hospital-admin/', pcc: '/pcc/', doctor: '/doctor/', lab: '/lab/', pharmacist: '/pharmacist/', nurse: '/nurse/', patient: '/patient/' };

  // Redirect to the common login page unless a session with the expected role exists.
  function guard(role) {
    const s = S.session();
    if (!s || s.role !== role) { location.replace(s ? ROLE_HOME[s.role] : '/'); return false; }
    return true;
  }

  // Re-render a view after input while keeping focus and caret in the changed control.
  function refocus(html, sel) {
    const pos = (document.activeElement || {}).selectionStart;
    $app.innerHTML = html;
    const n = document.querySelector(sel);
    if (n) { n.focus(); if (n.type === 'search' && pos != null) n.setSelectionRange(pos, pos); }
  }

  window.UI = { ROLE_HOME, $app, S, esc, fmt, badge, hname, toast, shell, logTable, csv, guard, refocus };
})();
