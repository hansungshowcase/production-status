import { cors } from '../_lib/cors.js';
import { parseMultipart, getFilePart } from '../_lib/parseBody.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const config = {
  api: {
    bodyParser: false,
  },
};

const PROMPT = `이 이미지는 냉장쇼케이스 제조업체의 작업지시서입니다.
이미지에서 다음 정보를 추출해서 JSON으로 반환하세요.
반드시 아래 필드명을 사용하세요. 값이 없으면 null로 반환하세요.
숫자 필드(width, depth, height, quantity)는 반드시 숫자만 반환하세요.

{
  "client_name": "발주처/거래처명",
  "order_date": "발주일 (YYYY-MM-DD 형식)",
  "due_date": "납기일 (YYYY-MM-DD 형식)",
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

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const parts = await parseMultipart(req);
  const filePart = getFilePart(parts, 'image');

  if (!filePart) {
    return res.status(400).json({ error: { message: '이미지를 업로드해주세요.', status: 400 } });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.includes('your-key-here')) {
    return res.status(500).json({ error: { message: 'GEMINI_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.', status: 500 } });
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const imagePart = {
      inlineData: {
        data: filePart.data.toString('base64'),
        mimeType: filePart.contentType || 'image/jpeg',
      },
    };

    const result = await model.generateContent([PROMPT, imagePart]);
    const text = result.response.text();

    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1];
    jsonStr = jsonStr.trim();

    const parsed = JSON.parse(jsonStr);

    // Normalize numeric fields
    if (parsed.width) parsed.width = parseInt(String(parsed.width).replace(/[^0-9]/g, ''), 10) || null;
    if (parsed.depth) parsed.depth = parseInt(String(parsed.depth).replace(/[^0-9]/g, ''), 10) || null;
    if (parsed.height) parsed.height = parseInt(String(parsed.height).replace(/[^0-9]/g, ''), 10) || null;
    if (parsed.quantity) parsed.quantity = parseInt(String(parsed.quantity).replace(/[^0-9]/g, ''), 10) || null;

    return res.json({ success: true, data: parsed });
  } catch (err) {
    console.error('OCR error:', err);
    return res.status(500).json({ error: { message: '이미지 인식에 실패했습니다: ' + (err.message || ''), status: 500 } });
  }
});
