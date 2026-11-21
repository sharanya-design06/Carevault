const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { summarizePages, MAX_INPUT_CHARS } = require('../functions/report-summarizer');
const { verifySources } = require('../functions/summary-verification');

async function pagesOf(name) {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { extractReportPages } = await import('../functions/report-extraction.mjs');
  const pages = [];
  await extractReportPages(fs.readFileSync(path.join('synthetic-reports', name)), (page) => pages.push(page), pdf, {
    standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + path.sep,
    cMapUrl: path.resolve('node_modules/pdfjs-dist/cmaps') + path.sep,
    cMapPacked: true,
  }, { createWorker: async () => { throw new Error('OCR is not expected for text fixtures'); } });
  return pages.map(({ page, lines }) => ({ page, lines }));
}

const loader = (pages) => async (number) => Buffer.from(JSON.stringify(pages[number - 1]));
const draftOf = (statements) => ({ statements });

test('laboratory fixture becomes cited, flagged statements with an explicit gap', async () => {
  const pages = await pagesOf('01-fictional-laboratory-report.pdf');
  const { statements } = summarizePages(pages);
  const texts = statements.map((statement) => statement.text);
  assert.ok(texts.includes('Glucose is 118 mg/dL (reference 70-99 mg/dL), flagged High.'));
  assert.ok(texts.includes('Hemoglobin A1c is 6.1% (reference below 5.7%), flagged High.'));
  assert.ok(texts.includes('HDL cholesterol is 38 mg/dL (reference above 40 mg/dL), flagged Low.'));
  assert.ok(texts.some((text) => /^Not reported: Sodium, potassium, calcium, AST, and triglycerides\.$/.test(text)));
  assert.ok(texts.indexOf('Creatinine is 0.9 mg/dL (reference 0.6-1.2 mg/dL), flagged Normal.') >
    texts.indexOf('Glucose is 118 mg/dL (reference 70-99 mg/dL), flagged High.'), 'abnormal results come first');
  assert.ok(!texts.some((text) => /fixture|not for clinical use/i.test(text)), 'banners are not summarized');
  const verification = await verifySources(draftOf(statements), 1, loader(pages));
  assert.equal(verification.blocking, false);
  assert.ok(verification.statements.every((item) => item.issues.length === 0));
});

test('narrative statements are verbatim source text, so nothing is diagnosed or reassured', async () => {
  for (const name of ['02-fictional-ct-chest-report.pdf', '04-fictional-mri-report.pdf', '06-fictional-pathology-report.pdf']) {
    const pages = await pagesOf(name);
    const { statements } = summarizePages(pages);
    for (const statement of statements) {
      if (['lab', 'gap', 'timeline'].includes(statement.category)) continue;
      const [source] = statement.sources;
      assert.equal(statement.text, pages[source.page - 1].lines[source.line].text.slice(source.start, source.end).trim(), name);
    }
  }
  const ct = summarizePages(await pagesOf('02-fictional-ct-chest-report.pdf')).statements.map((s) => s.text);
  assert.ok(ct.includes('Impression: indeterminate 8 mm right upper lobe nodule.'));
  assert.ok(ct.includes('Source recommendation: follow-up CT in 3 months for the nodule.'));
  const mri = summarizePages(await pagesOf('04-fictional-mri-report.pdf')).statements.map((s) => s.text);
  assert.ok(mri.some((text) => /nonspecific 6 mm focus/.test(text)));
});

test('long dated reports are grouped with every entry cited rather than dropped', async () => {
  const pages = await pagesOf('07-fictional-long-report-limit-test.pdf');
  const { statements } = summarizePages(pages);
  const timeline = statements.filter((statement) => statement.category === 'timeline');
  assert.equal(timeline.reduce((total, statement) => total + statement.sources.length, 0), 22);
  assert.ok(timeline.some((statement) => /2026-07-01 through 2026-07-1\d|2026-07-11 through 2026-07-22/.test(statement.text)));
  const verification = await verifySources(draftOf(statements), 2, loader(pages));
  assert.equal(verification.blocking, false);
});

test('every synthetic fixture yields a verifiable, non-empty summary', async () => {
  const names = fs.readdirSync('synthetic-reports').filter((name) => name.endsWith('.pdf'));
  assert.equal(names.length, 7);
  for (const name of names) {
    const pages = await pagesOf(name);
    const { statements } = summarizePages(pages);
    assert.ok(statements.length > 0, name);
    const verification = await verifySources(draftOf(statements), pages.length, loader(pages));
    assert.equal(verification.blocking, false, name);
  }
});

test('oversized or empty input fails without returning a partial summary', () => {
  const big = [{ page: 1, lines: [{ page: 1, source: 'pdf', text: 'x'.repeat(MAX_INPUT_CHARS + 1) }] }];
  assert.throws(() => summarizePages(big), { code: 'REPORT_TOO_LARGE' });
  assert.throws(() => summarizePages([{ page: 1, lines: [] }]), { code: 'NO_READABLE_TEXT' });
});

test('verification flags altered numbers, units, spans and OCR citations', async () => {
  const pages = [{ page: 1, lines: [
    { page: 1, source: 'pdf', text: 'Glucose: 118 mg/dL. Reference: 70-99 mg/dL. Flag: High.' },
    { page: 1, source: 'ocr', text: 'Impression: 8 mm nodule.' },
  ] }];
  const span = (line, end) => ({ page: 1, line, source: line === 0 ? 'pdf' : 'ocr', start: 0, end });
  const check = async (text, sources) => (await verifySources({ statements: [{ text, sources }] }, 1, loader(pages))).statements[0].issues.map((i) => i.code);
  assert.deepEqual(await check('Glucose is 118 mg/dL (reference 70-99 mg/dL), flagged High.', [span(0, 55)]), []);
  assert.ok((await check('Glucose is 181 mg/dL (reference 70-99 mg/dL).', [span(0, 55)])).includes('number-not-found'));
  assert.ok((await check('Glucose is 118 mmol/L (reference 70-99 mg/dL).', [span(0, 55)])).includes('unit-mismatch'));
  assert.ok((await check('Glucose is 118 mg/dL.', [span(0, 55)])).includes('source-number-omitted'));
  assert.deepEqual(await check('No source.', []), ['missing-source']);
  assert.ok((await check('Glucose is 118 mg/dL.', [span(0, 9999)])).includes('source-not-found'));
  assert.ok((await check('Glucose is 118 mg/dL.', [{ ...span(0, 55), source: 'ocr' }])).includes('source-not-found'));
  const ocr = await verifySources({ statements: [{ text: 'Impression: 8 mm nodule.', sources: [span(1, 24)] }] }, 1, loader(pages));
  assert.deepEqual(ocr.statements[0].issues, [{ code: 'ocr-source' }]);
  assert.equal(ocr.blocking, false, 'OCR is flagged for manual review but not blocking');
});

test('source digests change when a cited page changes', async () => {
  const pages = await pagesOf('01-fictional-laboratory-report.pdf');
  const { statements } = summarizePages(pages);
  const original = await verifySources(draftOf(statements), 1, loader(pages));
  const altered = structuredClone(pages);
  altered[0].lines[4].text = altered[0].lines[4].text.replace('118', '181');
  const changed = await verifySources(draftOf(statements), 1, loader(altered));
  assert.notEqual(original.sourceDigest, changed.sourceDigest);
  assert.equal(changed.blocking, true);
});
