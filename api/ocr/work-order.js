import { cors } from '../_lib/cors.js';
import { parseMultipart, getFilePart } from '../_lib/parseBody.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { normalizeOrderMemoForStorage } from '../../src/utils/orderText.js';
import { isCanonicalCalendarDate } from '../../src/utils/dateUtils.js';
import { parseWorkOrderJson } from '../_lib/ocrParse.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const CURRENT_YEAR = new Date().getFullYear();
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const CANONICAL_SALES_PERSONS = new Set(['신은철', '이준형']);
const SALES_PERSON_ALIASES = [
  ['신은철', '신은철'],
  ['신은절', '신은철'],
  ['이준형', '이준형'],
  ['김보수', '이준형'],
];
const EMPTY_OCR_DATA = {
  client_name: '',
  order_date: '',
  due_date: '',
  phone: '',
  delivery_address: '',
  freight_payment: '',
  sales_person: '',
  product_type: '',
  door_type: '',
  width: '',
  depth: '',
  height: '',
  quantity: '',
  color: '',
  notes: '',
};
const WORK_ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    client_name: { type: ['string', 'null'] },
    order_date: { type: ['string', 'null'] },
    due_date: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    delivery_address: { type: ['string', 'null'] },
    freight_payment: { type: ['string', 'null'] },
    sales_person: { type: ['string', 'null'] },
    product_type: { type: ['string', 'null'] },
    door_type: { type: ['string', 'null'] },
    width: { type: ['number', 'string', 'null'] },
    depth: { type: ['number', 'string', 'null'] },
    height: { type: ['number', 'string', 'null'] },
    quantity: { type: ['number', 'string', 'null'] },
    color: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
  },
  required: [
    'client_name',
    'order_date',
    'due_date',
    'phone',
    'delivery_address',
    'freight_payment',
    'sales_person',
    'product_type',
    'door_type',
    'width',
    'depth',
    'height',
    'quantity',
    'color',
    'notes',
  ],
};

const PROMPT = `이 이미지는 냉장쇼케이스 제조업체의 작업지시서입니다.
이미지에서 다음 정보를 추출해서 JSON으로 반환하세요.
반드시 아래 필드명을 사용하세요. 값이 없으면 null로 반환하세요.
숫자 필드(width, depth, height, quantity)는 반드시 숫자만 반환하세요.
수량 표기에 "총 N대"가 있으면 앞의 개별 표기보다 총 N대를 quantity로 반환하세요.
날짜는 반드시 YYYY-MM-DD 형식으로 반환하세요. 연도가 불분명하면 ${CURRENT_YEAR}년으로 설정하세요.

{
  "client_name": "발주처/거래처명",
  "order_date": "발주일 (YYYY-MM-DD 형식, 연도 불분명시 ${CURRENT_YEAR})",
  "due_date": "납기일 (YYYY-MM-DD 형식, 연도 불분명시 ${CURRENT_YEAR})",
  "phone": "연락처/전화번호",
  "delivery_address": "납품주소/배송주소",
  "freight_payment": "운임여부 (예: 소비자부담, 본사부담)",
  "sales_person": "담당자/영업담당",
  "product_type": "품명/사양 (제과/정육/반찬/꽃/와인/오픈/진열/마카롱/샌드위치/음료/밧트/토핑/양념육/유럽형/주류 중 하나)",
  "door_type": "문짝/디자인 (앞문/뒷문/양문/여닫이/오픈/라운드앞문/라운드뒷문/평대 중 하나)",
  "width": "가로 규격 (mm 단위, 숫자만)",
  "depth": "세로 규격 (mm 단위, 숫자만)",
  "height": "높이 규격 (mm 단위, 숫자만)",
  "quantity": "수량 (숫자만)",
  "color": "색상 (화이트/올백색/올스텐/올검정/블랙/골드스텐/골드미러 중 가장 가까운 것)",
  "notes": "비고/특이사항 (LED, 조명, 선반배열 등 기타 정보를 여기에 합쳐서 기재)"
}

JSON만 반환하세요. 다른 텍스트 없이 순수 JSON만 반환하세요.`;

const ESSENTIAL_FIELD_PROMPT = `

필수 정확도 규칙:
- sales_person은 신은철 또는 이준형만 반환한다. 김보수(김보수 팀장 포함)는 이준형으로, 신은절은 신은철로 정규화한다. 판독 불가하면 null로 둔다.
- due_date는 납기/납기일/납기일자 라벨 바로 뒤의 날짜를 우선 읽고 반드시 실제 YYYY-MM-DD 날짜로 반환한다. 연도가 없으면 ${CURRENT_YEAR}년을 사용하며, 읽지 못하면 null로 둔다.
- quantity에 여러 숫자가 있으면 "총 N대"의 N을 우선 반환한다. 확실하지 않으면 null로 둔다.`;

function getImageMimeType(filePart) {
  let mimeType = filePart.contentType || 'image/jpeg';
  if (mimeType === 'application/octet-stream' || !mimeType.startsWith('image/')) {
    const ext = (filePart.filename || '').split('.').pop()?.toLowerCase();
    const extMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' };
    mimeType = extMap[ext] || 'image/jpeg';
  }
  return mimeType;
}

function extractResponseText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === 'string') chunks.push(content.text);
    }
  }
  return chunks.join('\n');
}

function extractGeminiText(data) {
  const chunks = [];
  for (const candidate of data?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function parseOcrJson(text) {
  // 잘리거나 깨진 JSON 도 복구해서 읽는다(담당자·납기 등 앞쪽 필드 우선 확보).
  return normalizeOcrResult(parseWorkOrderJson(text));
}

export function extractQuantityFromOcrValue(value) {
  const totalMatch = String(value || '').match(/총\s*(\d+)\s*대/);
  if (totalMatch) return parseInt(totalMatch[1], 10) || null;
  return parseInt(String(value || '').replace(/[^0-9]/g, ''), 10) || null;
}

export function normalizeOcrSalesPerson(value) {
  const compact = String(value || '').replace(/\s+/g, '');
  for (const [alias, canonical] of SALES_PERSON_ALIASES) {
    if (compact.includes(alias)) return canonical;
  }
  return '';
}

function toIsoDate(year, month, day) {
  const normalizedYear = Number(year);
  const normalizedMonth = Number(month);
  const normalizedDay = Number(day);
  if (!Number.isInteger(normalizedYear) || !Number.isInteger(normalizedMonth) || !Number.isInteger(normalizedDay)) return '';
  const date = new Date(Date.UTC(normalizedYear, normalizedMonth - 1, normalizedDay));
  if (date.getUTCFullYear() !== normalizedYear || date.getUTCMonth() !== normalizedMonth - 1 || date.getUTCDate() !== normalizedDay) return '';
  return `${String(normalizedYear).padStart(4, '0')}-${String(normalizedMonth).padStart(2, '0')}-${String(normalizedDay).padStart(2, '0')}`;
}

export function normalizeOcrDueDate(value) {
  const source = String(value || '').trim();
  const fullDateMatch = source.match(/(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*(?:일)?/);
  if (fullDateMatch) return toIsoDate(fullDateMatch[1], fullDateMatch[2], fullDateMatch[3]);

  const labeledDateMatch = source.match(/납기(?:일자|일)?\s*[:：-]?\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  if (labeledDateMatch) return toIsoDate(CURRENT_YEAR, labeledDateMatch[1], labeledDateMatch[2]);
  return '';
}

export function hasCompleteOcrEssentials(data) {
  return Boolean(String(data?.client_name || '').trim())
    && isCanonicalCalendarDate(data?.order_date)
    && CANONICAL_SALES_PERSONS.has(data?.sales_person)
    && Boolean(data?.due_date)
    && normalizeOcrDueDate(data?.due_date) === data?.due_date
    && Boolean(String(data?.product_type || '').trim())
    && Number.isInteger(data?.quantity)
    && data.quantity > 0;
}

function normalizeOcrResult(parsed) {
  if (parsed.width) parsed.width = parseInt(String(parsed.width).replace(/[^0-9]/g, ''), 10) || null;
  if (parsed.depth) parsed.depth = parseInt(String(parsed.depth).replace(/[^0-9]/g, ''), 10) || null;
  if (parsed.height) parsed.height = parseInt(String(parsed.height).replace(/[^0-9]/g, ''), 10) || null;
  if (parsed.quantity) parsed.quantity = extractQuantityFromOcrValue(parsed.quantity);

  if (parsed.order_date && typeof parsed.order_date === 'string') {
    const m = parsed.order_date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m && parseInt(m[1], 10) < CURRENT_YEAR) {
      parsed.order_date = `${CURRENT_YEAR}-${m[2]}-${m[3]}`;
    }
  }
  parsed.due_date = normalizeOcrDueDate(parsed.due_date);
  parsed.sales_person = normalizeOcrSalesPerson(parsed.sales_person);

  parsed.notes = normalizeOrderMemoForStorage(parsed.notes);

  return parsed;
}

async function callOpenAiOcr({ apiKey, mimeType, filePart }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: PROMPT + ESSENTIAL_FIELD_PROMPT },
          {
            type: 'input_image',
            image_url: `data:${mimeType};base64,${filePart.data.toString('base64')}`,
            detail: 'high',
          },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'work_order_ocr',
          schema: WORK_ORDER_SCHEMA,
          strict: false,
        },
      },
      max_output_tokens: 3000,
    }),
    signal: AbortSignal.timeout(20000), // 지연 시 매달리지 않고 폴백(Gemini→수동)으로 넘어감
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const upstreamMessage = errorData?.error?.message || `OpenAI OCR request failed (${response.status})`;
    const err = new Error(upstreamMessage);
    err.status = response.status;
    err.provider = 'OpenAI';
    throw err;
  }

  const responseData = await response.json();
  return parseOcrJson(extractResponseText(responseData));
}

async function callGeminiOcr({ apiKey, mimeType, filePart }) {
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: PROMPT + ESSENTIAL_FIELD_PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: filePart.data.toString('base64'),
            },
          },
        ],
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 3000,
      },
    }),
    signal: AbortSignal.timeout(20000), // 지연 시 매달리지 않고 수동입력으로 폴백
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const upstreamMessage = errorData?.error?.message || `Gemini OCR request failed (${response.status})`;
    const err = new Error(upstreamMessage);
    err.status = response.status;
    err.provider = 'Gemini';
    throw err;
  }

  const responseData = await response.json();
  return parseOcrJson(extractGeminiText(responseData));
}

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res, { windowMs: 60000, max: 120 })) return;

  let parts;
  try {
    parts = await parseMultipart(req);
  } catch (parseErr) {
    console.error('Multipart parse error:', parseErr);
    const status = parseErr.status || 400;
    return res.status(status).json({ error: { message: status === 413 ? '파일 크기는 10MB 이하여야 합니다.' : '이미지 파싱 실패: ' + parseErr.message, status } });
  }
  const filePart = getFilePart(parts, 'image');

  if (!filePart) {
    return res.status(400).json({ error: { message: '이미지를 업로드해주세요.', status: 400 } });
  }

  const openAiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if ((!openAiKey || openAiKey.includes('your-key-here')) && !geminiKey) {
    return res.status(500).json({ error: { message: 'OCR API 키가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.', status: 500 } });
  }

  try {
    const mimeType = getImageMimeType(filePart);
    if (!OPENAI_SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      return res.status(415).json({ error: { message: '이미지 인식은 JPG, PNG, WEBP, GIF 파일만 지원합니다.', status: 415 } });
    }

    if (openAiKey && !openAiKey.includes('your-key-here')) {
      try {
        const parsed = await callOpenAiOcr({ apiKey: openAiKey, mimeType, filePart });
        if (hasCompleteOcrEssentials(parsed)) {
          return res.json({
            success: true,
            provider: 'openai',
            essentials_complete: true,
            data: parsed,
          });
        }
        if (!hasCompleteOcrEssentials(parsed) && geminiKey) {
          console.warn('OpenAI OCR returned incomplete essentials, trying Gemini fallback');
        } else {
          return res.json({
            success: false,
            provider: 'manual',
            warning: 'OCR 핵심 항목을 모두 읽지 못해 브라우저 OCR로 다시 인식합니다.',
            data: parsed,
          });
        }
      } catch (openAiErr) {
        console.warn('OpenAI OCR failed, trying Gemini fallback:', openAiErr.status, openAiErr.message);
        if (!geminiKey) {
          return res.json({
            success: false,
            provider: 'manual',
            warning: '자동 인식이 지연되어 수동 입력으로 전환했습니다. 작업지시서 이미지는 첨부되었습니다.',
            data: EMPTY_OCR_DATA,
          });
        }
      }
    }

    const parsed = await callGeminiOcr({ apiKey: geminiKey, mimeType, filePart });
    return res.json({
      success: hasCompleteOcrEssentials(parsed),
      provider: hasCompleteOcrEssentials(parsed) ? 'gemini' : 'manual',
      essentials_complete: hasCompleteOcrEssentials(parsed),
      data: parsed,
    });
  } catch (err) {
    // OCR 은 편의 기능 — 어떤 실패(파싱 실패·provider 오류·타임아웃)든 하드 에러(500) 대신
    // '수동입력'으로 우아하게 강등한다. 작업지시서 이미지는 이미 첨부되어 있으므로 작업 흐름은 안 끊긴다.
    console.warn('OCR 실패 → 수동입력 전환:', err.provider || 'unknown', err.status || '', err.message || err);
    return res.json({
      success: false,
      provider: 'manual',
      warning: '자동 인식이 어려워 수동 입력으로 전환했습니다. 작업지시서 이미지는 첨부되었습니다.',
      data: EMPTY_OCR_DATA,
    });
  }
});
