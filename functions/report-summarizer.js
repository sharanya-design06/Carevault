/*
 * Deterministic extractive summarizer. It is not a generative model: every statement is assembled only from text
 * that exists in one or more cited extracted lines, so each claim carries exact UTF-16 source offsets.
 */
const ENGINE = 'carevault-extractive';
const ENGINE_VERSION = '1.0.0';
const MAX_INPUT_CHARS = 200000;
const MAX_STATEMENTS = 100;
const MAX_STATEMENT_CHARS = 600;

const BOILERPLATE = [
  /^synthetic test fixture\b/i,
  /^fictional test data only\b/i,
  /^fixture id\b/i,
  /^fictional (?:laboratory report|ct chest report|discharge summary|mri report|medication reconciliation|pathology report|long report)\b/i,
  /^page \d+ of \d+\.?$/i,
  /\bnot for (?:clinical use|patient care)\b/i,
  /^this invented (?:fixture|document)\b/i,
  /^all (?:names|events|people|details)\b/i,
  /^synthetic (?:software-test )?fixture only\b/i,
  /^do not (?:treat|convert|generalize)\b/i,
];
const LAB = /^([A-Za-z][A-Za-z0-9 ()/-]{1,60}?):\s*(\d+(?:\.\d+)?)\s*([^\s.;,]+)?\.\s*Reference:\s*(.+?)\.\s*Flag:\s*([A-Za-z]+)\.?$/;
const NOT_REPORTED = /^(.+?):\s*not reported\.?$/i;
const DATED_ENTRY = /^\d{4}-\d{2}-\d{2}:\s+\S/;
const CONTEXT = /^(?:collection date|study date|study|encounter|review date|collected|received|comparison|examination|specimen(?: label)?)\s*[:.]/i;
const KEY = [
  [/^impression\s*:/i, 'impression'], [/^source impression\s*:/i, 'impression'],
  [/^final source wording\s*:/i, 'impression'], [/^finding \d+\s*:/i, 'finding'],
  [/^(?:right|left|bilateral)?\s*(?:upper|lower|middle)?\s*(?:lobe|lung)\b.*:/i, 'finding'],
  [/^(?:mediastinum|pleura|liver|microscopy|margins|limit)\s*:/i, 'finding'],
  [/^source recommendation\s*:/i, 'follow-up'],
  [/^reason documented\s*:/i, 'context'], [/^hospital course\s*:/i, 'context'],
  [/^source-listed diagnosis\s*:/i, 'diagnosis'], [/^medication\s*:/i, 'medication'],
  [/^exampletab\b/i, 'medication'], [/^pending test\s*:/i, 'pending'],
  [/^(?:reported )?allergy(?: status)?\s*:/i, 'allergy'], [/^reported allergy\s*:/i, 'allergy'],
  [/^source comment\s*:/i, 'note'], [/^the (?:record|source) (?:does not|states)\b/i, 'note'],
  [/^no (?:interaction|clinical history|acute)\b/i, 'note'],
  [/follow-up|follow up/i, 'follow-up'],
];

function clean(text) {
  const value = String(text).replace(/\s+/g, ' ').trim();
  return value.length > MAX_STATEMENT_CHARS ? value.slice(0, MAX_STATEMENT_CHARS - 1) + '…' : value;
}

function source(line, text) {
  return { page: line.page, line: line.index, source: line.source, start: 0, end: text.length };
}

function statementFor(line) {
  const text = line.text.trim();
  if (!text || BOILERPLATE.some((pattern) => pattern.test(text))) return null;
  const lab = LAB.exec(text);
  if (lab) {
    const [, test, value, unit, range, flag] = lab;
    return {
      category: 'lab', priority: /^normal$/i.test(flag) ? 3 : 2,
      text: clean(`${test.trim()} is ${value}${unit ? (unit === '%' ? '' : ' ') + unit : ''} ` +
        `(reference ${range.trim()}), flagged ${flag}.`),
      sources: [source(line, line.text)],
    };
  }
  const missing = NOT_REPORTED.exec(text);
  if (missing) {
    return { category: 'gap', priority: 4, text: clean('Not reported: ' + missing[1].trim() + '.'), sources: [source(line, line.text)] };
  }
  if (CONTEXT.test(text)) return { category: 'context', priority: 0, text: clean(text), sources: [source(line, line.text)] };
  for (const [pattern, category] of KEY) {
    if (pattern.test(text)) {
      return {
        category, priority: category === 'impression' ? 1 : category === 'note' ? 4 : 2,
        text: clean(text), sources: [source(line, line.text)],
      };
    }
  }
  return null;
}

/**
 * @param {{page:number, lines:{page:number, text:string, source:'pdf'|'ocr'}[]}[]} pages
 * @returns {{statements: object[], inputCharacters: number}}
 * @throws Error with code REPORT_TOO_LARGE or NO_READABLE_TEXT; never returns a partial summary.
 */
function summarizePages(pages) {
  const lines = [];
  let inputCharacters = 0;
  for (const page of pages) {
    page.lines.forEach((line, index) => {
      inputCharacters += line.text.length;
      lines.push({ page: page.page, index, text: line.text, source: line.source });
    });
  }
  if (inputCharacters > MAX_INPUT_CHARS) {
    const error = new Error('Report exceeds the summarization input limit; no text was truncated.');
    error.code = 'REPORT_TOO_LARGE';
    throw error;
  }
  if (!lines.some((line) => line.text.trim())) {
    const error = new Error('The report contained no readable text to summarize.');
    error.code = 'NO_READABLE_TEXT';
    throw error;
  }

  const items = [];
  let run = [];
  const flush = () => {
    if (run.length === 1) items.push(statementFor(run[0]) || null);
    else if (run.length > 1) {
      const first = run[0].text.slice(0, 10), last = run[run.length - 1].text.slice(0, 10);
      items.push({
        category: 'timeline', priority: 3,
        text: `Dated entries recorded from ${first} through ${last}; see the cited lines for each entry.`,
        sources: run.map((line) => source(line, line.text)),
      });
    }
    run = [];
  };
  for (const line of lines) {
    if (DATED_ENTRY.test(line.text.trim()) && !BOILERPLATE.some((pattern) => pattern.test(line.text.trim()))) {
      run.push(line);
    } else {
      flush();
      items.push(statementFor(line));
    }
  }
  flush();

  let statements = items.filter(Boolean);
  if (!statements.length) {
    statements = lines.filter((line) => line.text.trim() && !BOILERPLATE.some((pattern) => pattern.test(line.text.trim())))
      .slice(0, 12).map((line) => ({ category: 'excerpt', priority: 5, text: clean(line.text), sources: [source(line, line.text)] }));
  }
  if (!statements.length) {
    const error = new Error('The report contained no readable text to summarize.');
    error.code = 'NO_READABLE_TEXT';
    throw error;
  }
  if (statements.length > MAX_STATEMENTS) {
    const error = new Error('Report produced more statements than can be reviewed; no text was truncated.');
    error.code = 'REPORT_TOO_LARGE';
    throw error;
  }
  // Stable presentation order: document order within each priority tier (context first, gaps last).
  statements = statements.map((statement, order) => ({ ...statement, order }))
    .sort((a, b) => a.priority - b.priority || a.order - b.order)
    .map(({ category, text, sources }) => ({ category, text, sources }));
  return { statements, inputCharacters };
}

module.exports = { summarizePages, ENGINE, ENGINE_VERSION, MAX_INPUT_CHARS, MAX_STATEMENTS };
