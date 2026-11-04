/*
 * CareVault shared storage (Firestore + Cloud Storage over REST, so no SDK and the strict CSP stay intact).
 * Each top-level collection of the data model is one Firestore doc (carevault/<key>) holding a JSON string;
 * report PDFs go to Cloud Storage under reports/<id>. Writes use an updateTime precondition and retry after
 * merging by record id, so two people saving at once do not overwrite each other.
 */
(function () {
  const cfg = window.CAREVAULT_REMOTE || {};
  const enabled = !!(cfg.enabled && cfg.projectId && cfg.apiKey);
  const DOCS = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents/carevault';
  const key = '?key=' + encodeURIComponent(cfg.apiKey || '');
  const synced = {}; // last JSON we saw remotely per key, to push only what changed

  const decode = (doc) => { try { return JSON.parse(doc.fields.json.stringValue); } catch (e) { return undefined; } };
  const name = (doc) => doc.name.split('/').pop();

  async function pull() {
    const out = {};
    let token = '';
    do {
      const r = await fetch(DOCS + key + '&pageSize=100' + (token ? '&pageToken=' + token : ''));
      if (!r.ok) throw new Error('Shared storage read failed (' + r.status + ')');
      const j = await r.json();
      (j.documents || []).forEach((d) => { const v = decode(d); if (v !== undefined) { out[name(d)] = v; synced[name(d)] = JSON.stringify(v); } });
      token = j.nextPageToken || '';
    } while (token);
    return out;
  }

  const isList = (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'id' in x);
  // Union by id; records present on both sides come from the winning side.
  function merge(local, remote, remoteWins) {
    if (!isList(local) || !isList(remote)) return remoteWins ? remote : local;
    const win = remoteWins ? remote : local, lose = remoteWins ? local : remote;
    const ids = new Set(win.map((x) => x.id));
    return win.concat(lose.filter((x) => !ids.has(x.id)));
  }

  async function pushKey(k, value) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await fetch(DOCS + '/' + encodeURIComponent(k) + key);
      let precondition = '&currentDocument.exists=false';
      if (cur.ok) {
        const d = await cur.json();
        precondition = '&currentDocument.updateTime=' + encodeURIComponent(d.updateTime);
        const remote = decode(d);
        if (remote !== undefined && JSON.stringify(remote) !== synced[k]) value = merge(value, remote, false);
      } else if (cur.status !== 404) throw new Error('Shared storage read failed (' + cur.status + ')');
      const body = JSON.stringify({ fields: { json: { stringValue: JSON.stringify(value) } } });
      const w = await fetch(DOCS + '/' + encodeURIComponent(k) + key + '&updateMask.fieldPaths=json' + precondition, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      if (w.ok) { synced[k] = JSON.stringify(value); return value; }
      if (w.status !== 409 && w.status !== 400) throw new Error('Shared storage write failed (' + w.status + ')');
    }
    throw new Error('Shared storage write kept conflicting');
  }

  let chain = Promise.resolve();
  // Pushes changed keys one save at a time; resolves with the merged data to adopt.
  function push(db) {
    chain = chain.catch(() => {}).then(async () => {
      const merged = {};
      for (const k of Object.keys(db)) {
        if (JSON.stringify(db[k]) === synced[k]) { merged[k] = db[k]; continue; }
        merged[k] = await pushKey(k, db[k]);
      }
      return merged;
    });
    return chain;
  }

  const fileUrl = (id) => 'https://firebasestorage.googleapis.com/v0/b/' + cfg.storageBucket + '/o/' + encodeURIComponent('reports/' + id);
  async function putFile(id, buf) {
    const r = await fetch('https://firebasestorage.googleapis.com/v0/b/' + cfg.storageBucket + '/o?uploadType=media&name=' + encodeURIComponent('reports/' + id), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: buf });
    if (!r.ok) throw new Error('File upload failed (' + r.status + ')');
  }
  async function getFile(id) {
    const r = await fetch(fileUrl(id) + '?alt=media');
    return r.ok ? r.arrayBuffer() : null;
  }

  // Asks the Cloud Function to email the invite/reset link to the address registered for this token.
  async function sendMail(kind, token) {
    const r = await fetch('/api/sendInvite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, token }) });
    if (!r.ok) throw new Error('Email send failed (' + r.status + ')');
  }

  window.Remote = { enabled, pull, push, merge, putFile, getFile, sendMail };
})();
