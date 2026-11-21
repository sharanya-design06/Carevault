const { createHash } = require('node:crypto');

const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const QUANTITY = /(?<![\w.])(\d+(?:\.\d+)?)(?![\d.]*\d)(?:\s*(%|[A-Za-z\u00B5\u03BC\u00B0]+(?:\/[A-Za-z\u00B5\u03BC]+)?))?/g;
const BLOCKING = new Set(['missing-source', 'source-not-found', 'number-not-found', 'unit-mismatch',
  'source-number-omitted', 'date-not-found']);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const number = (value) => String(Number(value));

function claims(text) {
  const dates = new Set(text.match(DATE) || []);
  const quantities = [];
  for (const match of text.replace(DATE, ' ').matchAll(QUANTITY)) {
    quantities.push({ number: number(match[1]), unit: (match[2] || '').toLowerCase(), claim: match[0].trim() });
  }
  return { dates, quantities };
}

function validSpan(line, source) {
  return line && source.source === line.source && typeof line.text === 'string' &&
    Number.isSafeInteger(source.start) && Number.isSafeInteger(source.end) &&
    source.start >= 0 && source.end > source.start && source.end <= line.text.length;
}

function statementText(statement, citedText) {
  const issues = [];
  const stated = claims(statement.text), cited = claims(citedText);
  for (const date of stated.dates) if (!cited.dates.has(date)) issues.push({ code: 'date-not-found', claim: date });
  for (const quantity of stated.quantities) {
    const same = cited.quantities.filter((item) => item.number === quantity.number);
    if (!same.length) issues.push({ code: 'number-not-found', claim: quantity.claim });
    else if (quantity.unit && !same.some((item) => item.unit === quantity.unit)) {
      issues.push({ code: 'unit-mismatch', claim: quantity.claim });
    }
  }
  // Timeline statements intentionally summarize many dated lines, so only dates are exempt from omission checks.
  const statedNumbers = new Set(stated.quantities.map((item) => item.number));
  for (const quantity of cited.quantities) {
    if (!statedNumbers.has(quantity.number)) issues.push({ code: 'source-number-omitted', claim: quantity.claim });
  }
  return issues;
}

/**
 * Re-reads every cited extracted page and checks each statement's citations and numeric claims.
 * `loadPage(pageNumber)` must resolve to the stored extraction bytes of that page.
 * Lexical checks only: matching numbers do not prove clinical correctness.
 */
async function verifySources(summary, pageCount, loadPage) {
  const pages = new Map(), hashes = new Map();
  async function page(number) {
    if (!pages.has(number)) {
      let parsed = null;
      try {
        const bytes = await loadPage(number);
        hashes.set(number, sha256(bytes));
        parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
        if (!parsed || parsed.page !== number || !Array.isArray(parsed.lines)) parsed = null;
      } catch (error) {
        const failure = new Error('A referenced extracted page could not be verified.');
        failure.code = 'SOURCE_PAGE_UNAVAILABLE';
        failure.cause = error;
        throw failure;
      }
      pages.set(number, parsed);
    }
    return pages.get(number);
  }

  const statements = [];
  for (const statement of summary.statements) {
    const issues = [], sources = [], cited = [];
    if (!Array.isArray(statement.sources) || !statement.sources.length) issues.push({ code: 'missing-source' });
    for (const reference of Array.isArray(statement.sources) ? statement.sources : []) {
      const info = { page: reference.page, line: reference.line, source: null };
      sources.push(info);
      if (!Number.isSafeInteger(reference.page) || reference.page < 1 || reference.page > pageCount ||
          !Number.isSafeInteger(reference.line) || reference.line < 0) {
        issues.push({ code: 'source-not-found' });
        continue;
      }
      const line = (await page(reference.page)).lines[reference.line];
      if (!validSpan(line, reference)) { issues.push({ code: 'source-not-found' }); continue; }
      info.source = line.source;
      cited.push(line.text.slice(reference.start, reference.end));
    }
    if (cited.length) issues.push(...statementText(statement, cited.join('\n')));
    if (sources.some((item) => item.source === 'ocr')) issues.push({ code: 'ocr-source' });
    statements.push({ sources, issues });
  }
  const sourceDigest = sha256([...hashes.entries()].sort((a, b) => a[0] - b[0]).map(([n, h]) => n + ':' + h).join('\n'));
  const blocking = statements.some((item) => item.issues.some((issue) => BLOCKING.has(issue.code)));
  return { statements, blocking, sourceDigest };
}

module.exports = { verifySources, claims, BLOCKING };
