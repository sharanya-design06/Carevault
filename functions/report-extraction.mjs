const MAX_PAGES = 100;
const MAX_EXCERPTS = 12;
const MAX_OCR_PIXELS = 12000000;
const SYNTHETIC_MARKER = /synthetic test fixture|fictional test data only|not for clinical use/i;
const SUMMARY_LINE = /\b(impression|final source wording|reason documented|source-listed diagnosis|finding \d+|pending test|medication|reported allergy|no (?:acute )?abnormality|recommendation)\b|(?:flag|alt|vitamin d)\s*:/i;
const LAB_RESULT = /^([^:]+):\s*([+\-]?\d+(?:\.\d+)?)\s*([^\s.;]+)?(?:\.\s*Reference:\s*(.*?)\.\s*Flag:\s*([^.]+))?\./i;

async function browserOcr() {
  const { default: Tesseract } = await import('../vendor/ocr/tesseract.esm.min.js');
  return Tesseract.createWorker('eng', 1, {
    workerPath: '/assets/vendor/ocr/worker.min.js',
    corePath: '/assets/vendor/ocr/core',
    langPath: '/assets/vendor/ocr/lang',
    workerBlobURL: false,
    cacheMethod: 'none',
  });
}

function pageLines(items) {
  const lines = [];
  let line = '', lastY;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform && item.transform[5];
    if (line && y != null && lastY != null && Math.abs(y - lastY) > 2) {
      lines.push(line.trim());
      line = '';
    }
    if (item.str.trim()) line += (line ? ' ' : '') + item.str.trim();
    if (y != null) lastY = y;
    if (item.hasEOL && line) {
      lines.push(line.trim());
      line = '';
    }
  }
  if (line) lines.push(line.trim());
  return lines;
}

export async function extractReportPages(buffer, onPage, parser, options = {}, ocr = {}) {
  if (!parser) {
    parser = await import('../vendor/pdfjs/pdf.min.mjs');
    parser.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdfjs/pdf.worker.min.mjs';
    options = {
      standardFontDataUrl: '/assets/vendor/pdfjs/standard_fonts/',
      cMapUrl: '/assets/vendor/pdfjs/cmaps/',
      cMapPacked: true,
    };
  }
  const task = parser.getDocument({ ...options, isEvalSupported: false, data: new Uint8Array(buffer).slice() });
  let document, worker, ocrPages = 0;
  try {
    document = await task.promise;
    if (document.numPages > MAX_PAGES) {
      const error = new Error('Report exceeds the 100-page processing limit. Split it into smaller PDFs.');
      error.code = 'report-page-limit';
      throw error;
    }
    const pages = [];
    const imageOperators = new Set([
      parser.OPS.paintImageXObject, parser.OPS.paintInlineImageXObject,
      parser.OPS.paintInlineImageXObjectGroup, parser.OPS.paintImageMaskXObject,
      parser.OPS.paintImageMaskXObjectGroup, parser.OPS.paintImageXObjectRepeat,
      parser.OPS.paintImageMaskXObjectRepeat, parser.OPS.paintSolidColorImageMask,
    ].filter((value) => value !== undefined));
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const textLines = pageLines(content.items).filter(Boolean);
      const operators = await page.getOperatorList();
      const hasImages = operators.fnArray.some((op) => imageOperators.has(op));
      const lines = textLines.map((text) => ({ page: pageNumber, text, source: 'pdf' }));
      let ocrTextFound = false;
      if (!textLines.length || hasImages) {
        if (!worker) worker = await (ocr.createWorker || browserOcr)();
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.sqrt(MAX_OCR_PIXELS / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        const canvas = ocr.createCanvas ? ocr.createCanvas() : globalThis.document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        try {
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const result = await worker.recognize(canvas);
          const ocrLines = result.data.text.split(/\r?\n/).map((text) => text.trim()).filter(Boolean);
          ocrTextFound = ocrLines.length > 0;
          ocrLines.forEach((text) => lines.push({ page: pageNumber, text, source: 'ocr' }));
          ocrPages++;
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
      const pageInfo = { page: pageNumber, ocr: !textLines.length || hasImages, readable: lines.length > 0, ocrTextFound };
      pages.push(pageInfo);
      await onPage({ ...pageInfo, lines });
      page.cleanup();
    }
    return { pages, ocrPages };
  } finally {
    try { if (worker) await worker.terminate(); } finally { await task.destroy(); }
  }
}

export async function summarizeReport(buffer, parser, options = {}, ocr = {}) {
  const first = [], relevant = [], all = [];
  let firstCount = 0, relevantCount = 0;
  const extraction = await extractReportPages(buffer, ({ lines }) => {
    for (const line of lines) {
      all.push(line);
      firstCount++;
      if (first.length < MAX_EXCERPTS) first.push(line);
      if (SUMMARY_LINE.test(line.text) ||
          /\b(result|conclusion|assessment|glucose|hba1c|cholesterol|haemoglobin|hemoglobin|creatinine|egfr|triglycerides|ldl|hdl)\b/i.test(line.text)) {
        relevantCount++;
        if (relevant.length < MAX_EXCERPTS) relevant.push(line);
      }
    }
  }, parser, options, ocr);
  const synthetic = all.some((line) => SYNTHETIC_MARKER.test(line.text));
  const selected = relevantCount ? relevant : first;
  const selectedCount = relevantCount || firstCount;
  const excerpts = selected.map(({ page, text, source }) => ({
    page, source, text: text.length > 300 ? text.slice(0, 300) + '…' : text,
  }));
  const findings = synthetic ? selected.map(({ text }) => {
    const match = text.match(LAB_RESULT);
    if (!match || !match[4] || !match[5]) return null;
    return {
      test: match[1].trim(), value: match[2], unit: (match[3] || '').trim(),
      range: match[4].trim(), flag: match[5].trim().toLowerCase(),
    };
  }).filter(Boolean) : [];
  const summaryLines = selected.filter(({ text }) =>
    !SYNTHETIC_MARKER.test(text) && !/^fictional (?:laboratory report|ct chest report|discharge summary|mri report|medication reconciliation|pathology report|long report)/i.test(text));
  const headline = !excerpts.length
    ? 'No text could be extracted from this report. Review the original PDF.'
    : synthetic
      ? 'Synthetic report summary: ' + (summaryLines.slice(0, 3).map(({ text }) => text).join(' ') ||
        'no clinically meaningful findings were extracted.')
      : 'Extracted passages from the report; this is not a complete or interpreted summary.';
  return {
    headline,
    excerpts, findings, extracted: excerpts.length > 0,
    model: synthetic ? 'synthetic-extractive-v1' : 'pdf-text-extract-v3',
    pipelineStatus: synthetic ? 'synthetic-summary-complete' : 'model-not-configured',
    inputs: extraction.ocrPages ? 'PDF text and English OCR' : 'PDF text',
    limitations: synthetic
      ? 'Synthetic extractive summary only. It preserves source passages and does not infer diagnoses or validate clinical meaning. Review the original fictional PDF.'
      : 'Extractive demo, not an AI summary. Text and OCR may be incomplete or incorrect; review the original.',
    ocrPages: extraction.ocrPages,
    unreadablePages: extraction.pages.filter((page) => !page.readable).map((page) => page.page),
    ocrWithoutText: extraction.pages.filter((page) => page.ocr && !page.ocrTextFound).map((page) => page.page),
    truncated: (relevantCount > 0 && firstCount > relevantCount) ||
      selectedCount > MAX_EXCERPTS || selected.some((line) => line.text.length > 300),
    generatedAt: new Date().toISOString(),
  };
}
