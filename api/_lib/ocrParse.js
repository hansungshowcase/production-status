// 작업지시서 OCR(LLM) 응답 JSON 견고 파서.
// LLM 이 종종 잘린/깨진 JSON(문자열 미종료, 트레일링 콤마, 제어문자, 코드펜스)을 반환하는데,
// 그 경우에도 담당자·납기 등 앞쪽 필드는 살려낸다.
//   1) 코드펜스 제거 → {..} 추출 → JSON.parse (정상 경로)
//   2) 트레일링 콤마 제거 / 제어문자 정리 후 재시도
//   3) 그래도 안 되면 알려진 필드명 기준으로 개별 추출(부분 인식이라도 건짐)

export const WORK_ORDER_FIELDS = [
  'client_name', 'order_date', 'due_date', 'phone', 'delivery_address',
  'freight_payment', 'balance', 'sales_person', 'product_type', 'door_type',
  'width', 'depth', 'height', 'quantity', 'color', 'notes',
];

// 문자열 내부 원시 제어문자(개행/탭 등)를 잡는 정규식 — 소스에 리터럴 제어문자를 넣지 않도록 생성자 사용
const CTRL_CHARS = new RegExp('[\\u0000-\\u001F]+', 'g');
const TRAILING_COMMA = new RegExp(',\\s*([}\\]])', 'g');

function stripToObject(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s;
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
  } catch { return null; }
}

const ESCAPE_MAP = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };

// 알려진 필드명 기준으로 "key": value 를 하나씩 뜯어낸다.
// 미종료 문자열(닫는 따옴표 없음) 필드는 건너뛰고, 그 앞 필드들은 살린다.
export function extractFieldsLoose(raw, fields = WORK_ORDER_FIELDS) {
  const text = String(raw || '');
  const out = {};
  let found = false;
  for (const f of fields) {
    let i = text.indexOf('"' + f + '"');
    if (i < 0) continue;
    i += f.length + 2;
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== ':') continue;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    if (text[i] === '"') {
      i += 1;
      let val = '';
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '\\') {
          const n = text[i + 1];
          val += (n in ESCAPE_MAP) ? ESCAPE_MAP[n] : n;
          i += 2;
          continue;
        }
        if (c === '"') { closed = true; i += 1; break; }
        val += c;
        i += 1;
      }
      if (closed) { out[f] = val; found = true; } // 미종료면 스킵(앞 필드는 이미 확보)
    } else {
      let j = i;
      while (j < text.length && !',}\n'.includes(text[j])) j += 1;
      const lit = text.slice(i, j).trim();
      if (lit === 'null') { out[f] = null; found = true; }
      else if (/^-?\d+(?:\.\d+)?$/.test(lit)) { out[f] = Number(lit); found = true; }
      else if (lit) { out[f] = lit.replace(/^"|"$/g, ''); found = true; }
    }
  }
  return found ? out : null;
}

export function parseWorkOrderJson(text) {
  if (!text || !String(text).trim()) throw new Error('OCR 응답에 인식 결과가 없습니다.');
  const s = stripToObject(text);

  // 1) 정상 파싱
  const direct = tryParse(s);
  if (direct) return direct;

  // 2) 트레일링 콤마 제거 → 제어문자 정리 재시도
  const noTrailing = tryParse(s.replace(TRAILING_COMMA, '$1'));
  if (noTrailing) return noTrailing;
  const noCtrl = tryParse(s.replace(TRAILING_COMMA, '$1').replace(CTRL_CHARS, ' '));
  if (noCtrl) return noCtrl;

  // 3) 필드 개별 추출(부분 인식 복구)
  const loose = extractFieldsLoose(text);
  if (loose) return loose;

  throw new Error('OCR 응답 JSON 파싱 실패');
}
