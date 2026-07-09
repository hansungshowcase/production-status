const OCR_RAW_PREFIX_RE = /^OCR\s+\uC6D0\uBB38\s*:/i;

const OCR_RAW_MARKERS = [
  '\uC791\uC5C5\uC9C0\uC2DC\uC11C',
  '\uBC1C\uC8FC\uC77C',
  '\uC5F0\uB77D\uCC98',
  '\uB2F4\uB2F9\uC790',
  '\uD488\uBA85',
  '\uADDC\uACA9',
  '\uC678\uAD00\uC0C9\uC0C1',
  '\uC120\uBC18\uBC30\uC5F4',
  '\uBB38\uC9DD',
  '\uB0A9\uAE30\uC77C',
  '\uB77C\uC9C0\uC5D0\uD0C0',
  '\uCFE8\uB7EC \uBC30\uAD00',
  '\uC794\uAE08',
];

const OCR_RAW_STRUCTURE_PATTERNS = [
  /\uC791\uC5C5\uC9C0\uC2DC\uC11C/,
  /\uBC1C\uC8FC\uC77C\s*(?:[:\uFF1A]|\d{2,4}[./-]|\d{4})/,
  /\uC5F0\uB77D\uCC98\s*[:\uFF1A]/,
  /\uB2F4\uB2F9\uC790\s*[:\uFF1A]/,
  /\uD488\uBA85\s*[:\uFF1A]/,
  /\uADDC\uACA9\s*[:\uFF1A]?\s*\d{2,5}/,
  /\uB0A9\uAE30\uC77C\s*(?:[:\uFF1A]|\d{1,4}[./-]|\d{1,2}\uC6D4)/,
];

const MEMO_LINE_PREFIXES = [
  '\uBE44\uACE0',
  '\uD2B9\uC774\uC0AC\uD56D',
  '\uC694\uCCAD\uC0AC\uD56D',
  '\uBA54\uBAA8',
  'Note',
  'Notes',
  'Memo',
  'LED',
  '\uC870\uBA85',
  '\uC120\uBC18\uBC30\uC5F4',
  '\uBB38\uC9DD',
  '\uC794\uAE08',
];

const EMPTY_LABEL_RE = /^(?:\uC678\uAD00\uC0C9\uC0C1|\uC0C9\uC0C1|LED\uC0C9\uC0C1|LED|\uC120\uBC18\uBC30\uC5F4|\uBB38\uC9DD|\uBE44\uACE0|\uD2B9\uC774\uC0AC\uD56D|\uC694\uCCAD\uC0AC\uD56D|\uBA54\uBAA8)\s*[:\uFF1A]?\s*$/i;

const BOILERPLATE_CHUNK_RES = [
  /\uB0A9\uAE30(?:\uB294|\uB294\s+|\s*)\uBC1C\uC8FC\uC77C\uB85C\uBD80\uD130.*(?:\uC9C0\uD0AC|지킬)/i,
  /\uC791\uC5C5\uC9C0\uC2DC\uC11C\s*\uC5C6\uC774\s*\uC791\uC5C5\uAE08\uC9C0/i,
  /\uC808\uB300\s*\uC5C4\uAE08/i,
];

const NON_MEMO_PREFIX_RE = new RegExp(
  '^(' + [
    '\uC791\uC5C5\uC9C0\uC2DC\uC11C',
    '\uBC1C\uC8FC\uC77C',
    '\uC8FC\uBB38\uC77C',
    '\uC791\uC131\uC77C',
    '\uB0A9\uAE30\uC77C',
    '\uB0A9\uD488\uC77C',
    '\uCD9C\uACE0\uC77C',
    '\uC5F0\uB77D\uCC98',
    '\uC804\uD654',
    '\uD734\uB300\uD3F0',
    '\uB2F4\uB2F9\uC790',
    '\uC601\uC5C5\uB2F4\uB2F9',
    '\uAC70\uB798\uCC98',
    '\uBC1C\uC8FC\uCC98',
    '\uC0C1\uD638',
    '\uC5C5\uCCB4\uBA85',
    '\uACE0\uAC1D\uBA85',
    '\uD488\uBA85',
    '\uC81C\uD488',
    '\uADDC\uACA9',
    '\uC0AC\uC774\uC988',
    '\uD06C\uAE30',
    '\uC218\uB7C9',
    '\uAC1C\uC218',
    '\uAC00\uB85C',
    '\uC138\uB85C',
    '\uB192\uC774',
    '\uD3ED',
    '\uAE4A\uC774',
    '\uC0C9\uC0C1',
    '\uCEEC\uB7EC',
    '\uC678\uAD00\uC0C9\uC0C1',
  ].join('|') + ')(\\s*[:\uFF1A]|\\s|$)',
  'i'
);

function normalizeText(value) {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripLabel(line) {
  return line
    .replace(/^[\-\*\u00B7\u2022\s]+/, '')
    .replace(/^(?:\uBE44\uACE0|\uD2B9\uC774\uC0AC\uD56D|\uC694\uCCAD\uC0AC\uD56D|\uBA54\uBAA8|Notes?|Memo)\s*[:\uFF1A]\s*/i, '')
    .replace(/\s+[_\-]\s+/g, ' ')
    .replace(/[_\-]+/g, ' ')
    .replace(/([\uAC00-\uD7A3])\s+[A-Za-z](?:\s+[A-Za-z]{1,4})+$/g, '$1')
    .replace(/([\uAC00-\uD7A3])\s+x$/i, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripDecorativeMarks(value) {
  return String(value || '')
    .replace(/[★☆]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isBoilerplateMemoChunk(chunk) {
  const text = stripDecorativeMarks(chunk);
  if (!text) return true;
  if (EMPTY_LABEL_RE.test(text)) return true;
  return BOILERPLATE_CHUNK_RES.some((pattern) => pattern.test(text));
}

function cleanMemoChunk(chunk) {
  return stripDecorativeMarks(chunk)
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function normalizeOrderMemoForStorage(value) {
  const visible = getVisibleOrderMemo(value);
  if (!visible) return null;
  const joiner = visible.includes('\n') ? '\n' : ', ';

  const chunks = visible
    .split(/[\n,]+|(?<=\.)\s+/)
    .map(cleanMemoChunk)
    .filter((chunk) => chunk && !isBoilerplateMemoChunk(chunk))
    .map((chunk) => chunk.replace(/[.]$/g, '').trim())
    .filter(Boolean);

  const normalized = Array.from(new Set(chunks)).join(joiner).trim();
  return normalized || null;
}

function isUsefulMemoLine(line) {
  if (!line || line.length < 2) return false;
  if (NON_MEMO_PREFIX_RE.test(line)) return false;

  const compact = line.replace(/\s/g, '');
  return MEMO_LINE_PREFIXES.some((prefix) => compact.startsWith(prefix.replace(/\s/g, '')));
}

export function extractWorkMemoFromOcrText(value) {
  const text = normalizeText(value).replace(OCR_RAW_PREFIX_RE, '').trim();
  if (!text) return '';

  const lines = text
    .split('\n')
    .map((line) => stripLabel(line))
    .filter(Boolean)
    .filter(isUsefulMemoLine);

  return Array.from(new Set(lines)).join('\n');
}

export function isRawOcrMemo(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (OCR_RAW_PREFIX_RE.test(text)) return true;

  const structureMarkerCount = OCR_RAW_STRUCTURE_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0
  );
  const markerCount = OCR_RAW_MARKERS.reduce(
    (count, marker) => count + (text.includes(marker) ? 1 : 0),
    0
  );

  if (structureMarkerCount >= 2) return true;
  if (text.length > 180 && structureMarkerCount >= 2 && markerCount >= 3) return true;
  if (/^[a-z]{2,}\s+[a-z]{2,}/i.test(text) && structureMarkerCount >= 1) return true;

  return false;
}

export function getVisibleOrderMemo(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (isRawOcrMemo(text)) return extractWorkMemoFromOcrText(text);
  return text;
}
