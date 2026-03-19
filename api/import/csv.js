import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { STEPS } from '../_lib/steps.js';
import { parseMultipart, getFilePart } from '../_lib/parseBody.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

const HEADER_MAP = {
  '발주일': 'order_date',
  '납기일': 'due_date',
  '담당': 'sales_person',
  '거래처': 'client_name',
  '출고완료일': 'ship_date',
  '사양': 'product_type',
  '디자인': 'door_type',
  '가로': 'width',
  '세로': 'depth',
  '높이': 'height',
  '수량': 'quantity',
  '색상': 'color',
  '비고': 'notes',
  '상태': 'status',
};

function parseCSV(text) {
  // Remove BOM if present
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  const lines = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      lines.push(current);
      current = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        i++;
      }
      lines.push(current);
      current = '';
      // Mark row boundary with null sentinel
      lines.push(null);
    } else {
      current += ch;
    }
  }
  // Push last field
  if (current || lines.length > 0) {
    lines.push(current);
  }

  // Split into rows at null sentinels
  const rows = [];
  let row = [];
  for (const val of lines) {
    if (val === null) {
      if (row.length > 0) rows.push(row);
      row = [];
    } else {
      row.push(val.trim());
    }
  }
  if (row.length > 0) rows.push(row);

  return rows;
}

function mapStatus(koreanStatus) {
  if (!koreanStatus) return 'in_production';
  if (koreanStatus.includes('출고')) return 'shipped';
  if (koreanStatus.includes('취소')) return 'cancelled';
  return 'in_production';
}

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const parts = await parseMultipart(req);
  const filePart = getFilePart(parts, 'file');

  if (!filePart) {
    return res.status(400).json({ error: { message: 'CSV 파일을 업로드해주세요.', status: 400 } });
  }

  const text = filePart.data.toString('utf-8');
  const rows = parseCSV(text);

  if (rows.length < 2) {
    return res.status(400).json({ error: { message: 'CSV 파일에 데이터가 없습니다.', status: 400 } });
  }

  const headers = rows[0];
  const colMap = {};
  for (let i = 0; i < headers.length; i++) {
    const dbField = HEADER_MAP[headers[i]];
    if (dbField) {
      colMap[dbField] = i;
    }
  }

  // Validate required columns exist
  if (colMap.client_name === undefined) {
    return res.status(400).json({ error: { message: "'거래처' 컬럼이 필요합니다.", status: 400 } });
  }

  const db = getDb();
  let importedCount = 0;
  const errors = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const get = (field) => {
      const idx = colMap[field];
      return idx !== undefined && idx < row.length ? row[idx] || null : null;
    };

    const clientName = get('client_name');
    if (!clientName) {
      errors.push(`행 ${i + 1}: 거래처명이 비어있습니다.`);
      continue;
    }

    const status = mapStatus(get('status'));

    try {
      const orderResult = await db.execute({
        sql: `INSERT INTO orders (
          order_date, due_date, sales_person, client_name, ship_date,
          product_type, door_type, width, depth, height,
          quantity, color, notes, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        args: [
          get('order_date'), get('due_date'), get('sales_person'), clientName,
          get('ship_date'), get('product_type'), get('door_type'),
          get('width') ? Number(get('width')) : null,
          get('depth') ? Number(get('depth')) : null,
          get('height') ? Number(get('height')) : null,
          get('quantity') ? Number(get('quantity')) : 1,
          get('color'), get('notes'), status,
        ],
      });

      const orderId = Number(orderResult.rows[0].id);

      for (const step of STEPS) {
        await db.execute({
          sql: `INSERT INTO processes (order_id, step_name, status) VALUES (?, ?, 'waiting')`,
          args: [orderId, step],
        });
      }

      await db.execute({
        sql: `INSERT INTO pre_production (order_id) VALUES (?)`,
        args: [orderId],
      });

      importedCount++;
    } catch (err) {
      errors.push(`행 ${i + 1}: ${err.message}`);
    }
  }

  return res.json({
    imported: importedCount,
    errors: errors.length,
    errorDetails: errors.slice(0, 20),
  });
});
