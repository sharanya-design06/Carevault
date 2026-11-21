// Patient dashboard backed by Firebase sign-in and server-authorized callables (active when firebaseLogin is enabled).
(function () {
  const FS = window.FirebaseSession;
  if (!FS || !FS.enabled) return;
  const { $app, esc, toast, guard } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['profile', 'My Profile'], ['records', 'My Records'], ['notifications', 'Access Notifications'], ['sharing', 'Sharing']];
  const shell = (active, html) => window.UI.shell(NAV, 'Patient Portal', active, html);
  const message = (e) => (e && e.message === 'Signed out' ? null : (e && e.message) || 'Request failed.');
  const when = (ms) => new Date(ms).toLocaleString();
  const label = (v) => String(v || '').replace(/_/g, ' ').toLowerCase();
  const VITALS = [['temp', 'Temp (°C)'], ['pulse', 'Pulse'], ['bpSys', 'Systolic'], ['bpDia', 'Diastolic'], ['spo2', 'SpO₂']];

  function recordLine(r) {
    const d = r.data || {};
    if (r.type === 'vitals') return VITALS.filter(([k]) => d[k] !== undefined).map(([k, l]) => `${esc(l)}: ${esc(d[k])}`).join(' · ');
    if (r.type === 'diagnosis') return `<b>${esc(d.condition)}</b>${d.notes ? ' — ' + esc(d.notes) : ''}`;
    return `<b>${esc(d.drug)}</b> ${esc(d.dose)}, ${esc(d.frequency)}, ${esc(d.days)} day(s) — ${esc(r.status)}`;
  }
  const recordTable = (rows) => rows.length
    ? `<table><tbody>${rows.map((r) => `<tr><td>${esc(when(r.createdAt))}</td><td>${esc(label(r.type))}</td><td>${recordLine(r)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No records yet.</p>';
  const noteList = (rows) => rows.length
    ? `<table><tbody>${rows.map((n) => `<tr><td>${esc(when(n.createdAt))}</td><td>Hospital <b>${esc(n.viewingHospitalId)}</b> viewed your record</td><td>Reason: ${esc(n.reason)}</td></tr>`).join('')}</tbody></table>` : '<p class="mut">No other hospital has viewed your record.</p>';

  async function render() {
    if (!guard('patient')) return;
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!parts.length) { location.replace('#/dashboard'); return; }
    try {
      const me = await FS.call('getDashboardPatient', { hrid: FS.session().hrid });
      let html;
      if (parts[0] === 'dashboard') {
        const [records, notes] = await Promise.all([FS.call('listClinicalRecords', { hrid: me.hrid }), FS.call('getPatientNotifications')]);
        html = shell('dashboard', `<h1>Welcome, ${esc(me.name)}</h1><div class="grid"><div class="stat"><b>${records.length}</b><span>Records</span></div>
          <div class="stat"><b>${notes.length}</b><span>Access notifications</span></div></div>
          <div class="card"><h2>Latest records</h2>${recordTable(records.slice(0, 5))}</div>`);
      } else if (parts[0] === 'profile') {
        const row = (l, v) => `<dt>${l}</dt><dd>${esc(v) || '—'}</dd>`;
        html = shell('profile', `<h1>My Profile</h1><div class="card"><dl class="kv">${row('Health Record ID', me.hrid)}${row('Name', me.name)}${row('Date of birth', me.dob)}${row('Gender', me.gender)}${row('Phone', me.phone)}${row('Address', me.address)}${row('Emergency contact', [me.emergencyName, me.emergencyPhone].filter(Boolean).join(' · '))}</dl>
          <p class="mut">To correct these details, contact your hospital's Patient Care Coordinator.</p></div>`);
      } else if (parts[0] === 'records') html = shell('records', `<h1>My Records</h1><div class="card">${recordTable(await FS.call('listClinicalRecords', { hrid: me.hrid }))}</div>`);
      else if (parts[0] === 'notifications') html = shell('notifications', `<h1>Access Notifications</h1><div class="card">${noteList(await FS.call('getPatientNotifications'))}<p class="mut">Another hospital must record a reason before viewing your record. Each view is listed here.</p></div>`);
      else if (parts[0] === 'sharing') {
        const { share } = await FS.call('getMySharing');
        html = shell('sharing', `<h1>Sharing</h1><form class="card" data-form="sharing"><label><input type="checkbox" name="share" ${share ? 'checked' : ''}> Allow care teams at other hospitals who are assigned to me to view my record</label>
          <p class="mut">Off by default. Your choice is saved, but hospitals can currently reach your record only with a recorded reason, and you are notified each time.</p><p><button class="primary" type="submit">Save</button></p></form>`);
      } else html = shell('', '<h1>Page not found</h1>');
      $app.innerHTML = html;
    } catch (e) {
      const text = message(e);
      if (text === null) { location.replace('/'); return; }
      $app.innerHTML = shell('', `<h1>Unavailable</h1><div class="err" role="alert">${esc(text)}</div>`);
    }
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form="sharing"]');
    if (!form) return;
    e.preventDefault();
    try {
      await FS.call('setPatientSharing', { share: form.elements.share.checked });
      toast('Sharing preference saved');
    } catch (error) { toast(message(error) || 'Signed out'); }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action="logout"]');
    if (b) { FS.logout(); location.href = '/'; }
  });

  window.addEventListener('hashchange', render);
  render();
})();
