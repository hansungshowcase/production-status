import { cors } from '../_lib/cors.js';
import { parseMultipart, getFilePart } from '../_lib/parseBody.js';
import { requireAuth } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const CURRENT_YEAR = new Date().getFullYear();
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const OPENAI_SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const WORK_ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    client_name: { type: ['string', 'null'] },
    order_date: { type: ['string', 'null'] },
    due_date: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
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
날짜는 반드시 YYYY-MM-DD 형식으로 반환하세요. 연도가 불분명하면 ${CURRENT_YEAR}년으로 설정하세요.

{
  "client_name": "발주처/거래처명",
  "order_date": "발주일 (YYYY-MM-DD 형식, 연도 불분명시 ${CURRENT_YEAR})",
  "due_date": "납기일 (YYYY-MM-DD 형식, 연도 불분명시 ${CURRENT_YEAR})",
  "phone": "연락처/전화번호",
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

function normalizeOcrResult(parsed) {
  if (parsed.width) parsed.width = parseInt(String(parsed.width).replace(/[^0-9]/g, ''), 10) || null;
  if (parsed.depth) parsed.depth = parseInt(String(parsed.depth).replace(/[^0-9]/g, ''), 10) || null;
  if (parsed.height) parsed.height = parseInt(String(parsed.height).replace(/[^0-9]/g, ''), 10) || null;
  if (parsed.quantity) parsed.quantity = parseInt(String(parsed.quantity).replace(/[^0-9]/g, ''), 10) || null;

  const thisYear = String(CURRENT_YEAR);
  ['order_date', 'due_date'].forEach(field => {
    if (parsed[field] && typeof parsed[field] === 'string') {
      const m = parsed[field].match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m && parseInt(m[1], 10) < CURRENT_YEAR) {
        parsed[field] = thisYear + '-' + m[2] + '-' + m[3];
      }
    }
  });

  return parsed;
}

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;
  const auth = requireAuth(req, res, { roles: ['sales'] });
  if (!auth) return;

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.includes('your-key-here')) {
    return res.status(500).json({ error: { message: 'OPENAI_API_KEY가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.', status: 500 } });
  }

  try {
    const mimeType = getImageMimeType(filePart);
    if (!OPENAI_SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      return res.status(415).json({ error: { message: '이미지 인식은 JPG, PNG, WEBP, GIF 파일만 지원합니다.', status: 415 } });
    }

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
            { type: 'input_text', text: PROMPT },
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
        max_output_tokens: 1200,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const upstreamMessage = errorData?.error?.message || `OpenAI OCR request failed (${response.status})`;
      const status = response.status >= 500 ? 502 : response.status;
      console.error('OpenAI OCR error:', response.status, upstreamMessage);
      return res.status(status).json({ error: { message: '이미지 인식에 실패했습니다: ' + upstreamMessage, status } });
    }

    const responseData = await response.json();
    const text = extractResponseText(responseData);
    if (!text) {
      throw new Error('OpenAI 응답에 인식 결과가 없습니다.');
    }

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    jsonStr = jsonStr.trim();

    const parsed = normalizeOcrResult(JSON.parse(jsonStr));

    return res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('OCR error:', err);
    return res.status(500).json({ error: { message: '이미지 인식에 실패했습니다: ' + (err.message || ''), status: 500 } });
  }
});
