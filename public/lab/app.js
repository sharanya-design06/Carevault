(function () {
  const { $app, S, esc, fmt, badge, toast, guard } = window.UI;

  const NAV = [['dashboard', 'Dashboard'], ['search', 'Patient Search'], ['reports', 'Uploaded Reports']];
  const shell = (active, html) => window.UI.shell(NAV, 'Laboratory Workspace', active, html);
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');
  const alertBox = (cls, html) => `<div class="alert ${cls}" role="alert">${html}</div>`;
  let scope = 'mine', timer = null;

  function reportTable(rows) {
    if (!rows.length) return '<p class="mut">No reports.</p>';
    return `<div class="tablewrap"><table><thead><tr><th>Title</th><th>Patient</th><th>Category</th><th>Uploaded</th><th>By</th><th>AI status</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.patientName)}<br><code>${esc(r.hrid)}</code></td><td>${esc(r.category)}</td><td>${esc(fmt(r.uploadedAt))}</td><td>${esc(r.uploadedByName || r.uploadedBy)}</td><td>${badge(r.processingStatus)}</td>
      <td><a class="btn sm" href="#/reports/${esc(r.id)}">Details</a></td></tr>`).join('')}</tbody></table></div>`;
  }

  function dashboardView() {
    const mine = S.labReports('mine'), all = S.labReports('hospital');
    return shell('dashboard', `<h1>Laboratory Dashboard</h1>
      <div class="grid"><div class="stat"><b>${mine.length}</b><span>My uploads</span></div><div class="stat"><b>${all.length}</b><span>Hospital uploads</span></div>
      <div class="stat"><b>${all.filter((r) => r.processingStatus === 'processing').length}</b><span>AI processing</span></div>
      <div class="stat"><b>${all.filter((r) => r.processingStatus === 'failed').length}</b><span>Processing failed</span></div></div>
      ${hridForm()}
      <div class="card"><h2>Recent uploads</h2>${reportTable(all.slice(0, 5))}</div>`);
  }

  function hridForm(err) {
    return `<form data-form="hrid" class="card"><h2>Find patient by HRID</h2>${err ? alertBox('danger', esc(err)) : ''}
      <div class="toolbar"><input name="hrid" placeholder="HDW-YYYYMMDD-XXXXXXXX" required maxlength="24" autocomplete="off" aria-label="HRID"><button class="primary" type="submit">Find patient</button></div></form>`;
  }

  function patientCard(p) {
    return `<div class="card"><h2>${esc(p.name)}</h2><p><code>${esc(p.hrid)}</code> · ${esc(p.gender)} · DOB ${esc(p.dob)}</p>
      <a class="btn primary" href="#/upload/${esc(p.hrid)}">Upload report</a></div>`;
  }

  function searchView(err, found, results) {
    return shell('search', `<h1>Patient Search</h1>${hridForm(err)}${found ? patientCard(found) : ''}
      <form data-form="secondary" class="card"><h2>Secondary lookup</h2><p class="mut">Date of birth plus full name or phone number, patients at your hospital only.</p>
        <div class="toolbar"><input name="name" placeholder="Full name" aria-label="Full name"><input name="phone" placeholder="Phone" aria-label="Phone"><input name="dob" type="date" required aria-label="Date of birth"><button type="submit">Search</button></div></form>
      ${results ? (results.length ? results.map(patientCard).join('') : '<p class="mut">No matching patient.</p>') : ''}`);
  }

  function uploadView(hrid, err, done) {
    const f = S.labFindPatient(hrid);
    if (!f.ok) return shell('search', `<h1>Upload Medical Report</h1>${alertBox('danger', esc(f.error))}<p><a href="#/search">← Patient search</a></p>`);
    if (done) {
      return shell('search', `<h1>Report uploaded</h1>${alertBox('ok', 'The PDF was stored and linked to ' + esc(f.patient.hrid) + '. AI processing has started.')}
        <div class="actions"><a class="btn primary" href="#/reports/${esc(done)}">View report &amp; AI result</a><a class="btn" href="#/upload/${esc(hrid)}">Upload another</a></div>`);
    }
    return shell('search', `<h1>Upload Medical Report</h1>
      <div class="card"><b>${esc(f.patient.name)}</b> <code>${esc(f.patient.hrid)}</code> · DOB ${esc(f.patient.dob)}</div>
      <form data-form="upload" class="card" data-hrid="${esc(f.patient.hrid)}">${err ? alertBox('danger', esc(err)) : ''}
        <label>Report title<input name="title" required minlength="3" maxlength="120"></label>
        <label>Category<select name="category" required>${S.REPORT_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
        <label>PDF file (max 10 MB)<input name="file" type="file" accept="application/pdf,.pdf" required></label>
        <p><button class="primary" type="submit">Upload report</button> <a class="btn" href="#/search">Cancel</a></p></form>`);
  }

  function reportsView() {
    const rows = S.labReports(scope);
    if (rows.some((r) => r.processingStatus === 'processing')) timer = setTimeout(render, 1000);
    return shell('reports', `<h1>Uploaded Reports</h1><div class="card"><div class="toolbar">
      <select id="scope" aria-label="Scope"><option value="mine" ${scope === 'mine' ? 'selected' : ''}>Uploaded by me</option><option value="hospital" ${scope === 'hospital' ? 'selected' : ''}>All at my hospital</option></select></div>
      ${reportTable(rows)}</div>`);
  }

  function detailView(id, msg) {
    const r = S.labReport(id);
    if (!r) return shell('reports', `<h1>Report</h1>${alertBox('danger', 'Report not found.')}`);
    if (r.processingStatus === 'processing') timer = setTimeout(render, 1000);
    const s = r.summary;
    return shell('reports', `<p><a href="#/reports">← Uploaded reports</a></p><h1>${esc(r.title)}</h1>${msg ? alertBox('danger', esc(msg)) : ''}
      <div class="card"><h2>Report details &amp; provenance</h2>
        <p>Patient: ${esc(r.patientName)} <code>${esc(r.hrid)}</code></p><p>Category: ${esc(r.category)}</p>
        <p>Uploaded: ${esc(fmt(r.uploadedAt))} by ${esc(r.uploadedByName || r.uploadedBy)} (${esc(r.uploadedBy)}) at ${esc(r.hospitalName)}</p>
        <p>File: ${esc(r.fileName)} · ${r.size ? Math.round(r.size / 1024) + ' KB' : 'demo seed record'}</p>
        ${r.sha256 ? `<p>SHA-256: <code>${esc(r.sha256)}</code></p>` : ''}
        ${r.hasFile ? `<button data-action="openPdf" data-id="${esc(r.id)}">Open PDF</button>` : ''}</div>
      <div class="card"><h2>AI processing result</h2><p>Status: ${badge(r.processingStatus)}${r.processedAt ? ' · ' + esc(fmt(r.processedAt)) : ''}</p>
        ${s ? `<p>${esc(s.headline)}</p>${s.findings.length ? `<table><thead><tr><th>Test</th><th>Value</th><th>Reference</th><th>Flag</th></tr></thead><tbody>
          ${s.findings.map((f) => `<tr><td>${esc(f.test)}</td><td>${esc(f.value)} ${esc(f.unit)}</td><td>${esc(f.range)}</td><td>${badge(f.flag)}</td></tr>`).join('')}</tbody></table>` : ''}
          <p class="mut">AI-generated (${esc(s.model || 'demo')}), demo only — requires clinician review.</p>` : '<p class="mut">Processing…</p>'}</div>`);
  }

  async function render() {
    await S.ready();
    if (!guard('lab')) return;
    S.touch();
    clearTimeout(timer);
    const [a, b] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
    let html;
    if (a === 'search') html = searchView();
    else if (a === 'upload' && b) html = uploadView(decodeURIComponent(b));
    else if (a === 'reports' && b) html = detailView(b);
    else if (a === 'reports') html = reportsView();
    else html = dashboardView();
    $app.innerHTML = html;
  }

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const k = form.dataset.form;
    if (k === 'upload') {
      const hrid = form.dataset.hrid, btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      const r = await S.labUploadReport({ hrid, title: form.elements.title.value, category: form.elements.category.value, file: form.elements.file.files[0] });
      if (r.ok) $app.innerHTML = uploadView(hrid, '', r.report.id); else $app.innerHTML = uploadView(hrid, r.error);
      return;
    }
    const d = Object.fromEntries(new FormData(form));
    if (k === 'hrid') {
      const r = S.labFindPatient(d.hrid);
      $app.innerHTML = searchView(r.ok ? '' : r.error, r.ok ? r.patient : null);
    } else if (k === 'secondary') {
      const r = S.labSearchSecondary(d);
      $app.innerHTML = searchView(r.ok ? '' : r.error, null, r.ok ? r.results : null);
    }
  });

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    if (b.dataset.action === 'logout') { S.logout(); location.href = '/'; }
    else if (b.dataset.action === 'openPdf') {
      const r = await S.labReportFile(b.dataset.id);
      if (!r.ok) { toast(r.error); return; }
      const url = URL.createObjectURL(r.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'scope') { scope = e.target.value; render(); } });

  window.addEventListener('hashchange', render);
  render();
})();
