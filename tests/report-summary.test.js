const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function summarize(name) {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { summarizeReport } = await import('../public/assets/js/report-summary.mjs');
  return summarizeReport(fs.readFileSync(path.join('synthetic-reports', name)), pdf, {
    standardFontDataUrl: path.resolve('node_modules/pdfjs-dist/standard_fonts') + path.sep,
    cMapUrl: path.resolve('node_modules/pdfjs-dist/cmaps') + path.sep,
    cMapPacked: true,
  });
}

test('synthetic laboratory fixture produces source-linked structured results', async () => {
  const result = await summarize('01-fictional-laboratory-report.pdf');
  assert.equal(result.pipelineStatus, 'synthetic-summary-complete');
  assert.equal(result.model, 'synthetic-extractive-v1');
  assert.equal(result.findings.length, 7);
  assert.ok(result.findings.some((finding) => finding.test === 'Glucose' &&
    finding.value === '118' && finding.flag === 'high'));
  assert.ok(result.excerpts.some((excerpt) => excerpt.page === 1 &&
    excerpt.source === 'pdf' && /Glucose: 118 mg\/dL/.test(excerpt.text)));
  assert.match(result.limitations, /Synthetic extractive summary only/);
});

test('synthetic narrative fixtures summarize preserved source wording without a diagnosis', async () => {
  const ct = await summarize('02-fictional-ct-chest-report.pdf');
  assert.match(ct.headline, /indeterminate 8 mm right upper lobe nodule/i);
  assert.ok(ct.excerpts.some((excerpt) => /follow-up CT in 3 months/i.test(excerpt.text)));

  const pathology = await summarize('06-fictional-pathology-report.pdf');
  assert.match(pathology.headline, /no malignancy identified in the submitted sample/i);
});

test('all synthetic report fixtures can be processed end to end', async () => {
  const fixtures = fs.readdirSync('synthetic-reports').filter((name) => name.endsWith('.pdf'));
  assert.equal(fixtures.length, 7);
  for (const fixture of fixtures) {
    const result = await summarize(fixture);
    assert.equal(result.extracted, true, fixture);
    assert.ok(result.excerpts.length > 0, fixture);
    assert.equal(result.model, 'synthetic-extractive-v1', fixture);
  }
});
