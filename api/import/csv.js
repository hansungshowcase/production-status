import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { STEPS } from '../_lib/steps.js';
import { parseMultipart, getFilePart } from '../_lib/parseBody.js';
import { requireAuth } from '../_lib/auth.js';
import { normalizeOrderMutationInput } from '../_lib/orderCreateInput.js';

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
  '도어타입': 'door_type',
  '디자인': 'design',
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

  const auth = requireAuth(req, res, { roles: ['admin'] });
  if (!auth) return;

  let parts;
  try {
    parts = await parseMultipart(req);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: { message: status === 413 ? '파일 크기는 10MB 이하여야 합니다.' : 'multipart/form-data 형식으로 전송해주세요.', status } });
  }
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
  let skippedCount = 0;
  const errors = [];

  // dry-run 플래그: ?dryRun=1 이면 INSERT 하지 않고 카운트만 보고
  const dryRun = String(req.query?.dryRun ?? '') === '1'
    || String(req.query?.dryRun ?? '') === 'true';

  // ---- 1단계: 모든 행 파싱 + 검증 ----
  const candidates = []; // { rowIndex, values, dedupeKey }
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

    const orderDate = get('order_date');
    const productType = get('product_type');
    const quantityRaw = get('quantity');
    const quantity = quantityRaw ? Number(quantityRaw) : null;
    const status = mapStatus(get('status'));

    candidates.push({
      rowIndex: i + 1,
      dedupeKey: `${clientName}||${orderDate ?? ''}||${productType ?? ''}||${quantity ?? ''}`,
      values: normalizeOrderMutationInput({
        order_date: orderDate,
        due_date: get('due_date'),
        sales_person: get('sales_person'),
        client_name: clientName,
        ship_date: get('ship_date'),
        product_type: productType,
        door_type: get('door_type'),
        design: get('design'),
        width: get('width') ? Number(get('width')) : null,
        depth: get('depth') ? Number(get('depth')) : null,
        height: get('height') ? Number(get('height')) : null,
        quantity,
        color: get('color'),
        notes: get('notes'),
        status,
      }),
    });
  }

  const totalCount = candidates.length;

  // ---- 2단계: 청크 단위 처리 (100행) ----
  const CHUNK_SIZE = 100;
  for (let start = 0; start < candidates.length; start += CHUNK_SIZE) {
    const chunk = candidates.slice(start, start + CHUNK_SIZE);

    // ---- 2-a: 기존 데이터 조회로 중복 체크 (client-side dedupe) ----
    // 청크 내 거래처명 집합으로 좁혀서 SELECT
    const clientNames = [...new Set(chunk.map(c => c.values.client_name))];
    const existingKeys = new Set();
    if (clientNames.length > 0) {
      try {
        const placeholders = clientNames.map(() => '?').join(', ');
        const existing = await db.execute({
          sql: `SELECT id, client_name, order_date, product_type, quantity
                FROM orders WHERE client_name IN (${placeholders})`,
          args: clientNames,
        });
        for (const r of existing.rows) {
          // order_date 가 Date 객체로 올 수 있으니 YYYY-MM-DD 문자열로 정규화
          let od = r.order_date;
          if (od instanceof Date) {
            od = od.toISOString().slice(0, 10);
          } else if (od != null) {
            od = String(od).slice(0, 10);
          } else {
            od = '';
          }
          const qty = r.quantity == null ? '' : Number(r.quantity);
          const key = `${r.client_name}||${od}||${r.product_type ?? ''}||${qty}`;
          existingKeys.add(key);
        }
      } catch (err) {
        errors.push(`중복 조회 실패(청크 ${start}-${start + chunk.length}): ${err.message}`);
      }
    }

    // 청크 내부 중복도 거름 (같은 CSV 안에서 같은 키가 두 번 나오면 첫 번째만)
    const seenInChunk = new Set();
    const toInsert = [];
    for (const cand of chunk) {
      if (existingKeys.has(cand.dedupeKey) || seenInChunk.has(cand.dedupeKey)) {
        skippedCount++;
        continue;
      }
      seenInChunk.add(cand.dedupeKey);
      toInsert.push(cand);
    }

    if (dryRun || toInsert.length === 0) {
      if (dryRun) importedCount += toInsert.length; // dry-run 시 "삽입 예정 수"로 누적
      continue;
    }

    // ---- 2-b: orders 배치 INSERT (RETURNING id) ----
    let insertedIds = [];
    try {
      const cols = [
        'order_date', 'due_date', 'sales_person', 'client_name', 'ship_date',
        'product_type', 'door_type', 'design', 'width', 'depth', 'height',
        'quantity', 'color', 'notes', 'status',
      ];
      const rowPh = `(${cols.map(() => '?').join(', ')})`;
      const valuesSql = toInsert.map(() => rowPh).join(', ');
      const args = [];
      for (const cand of toInsert) {
        for (const col of cols) args.push(cand.values[col]);
      }
      const orderResult = await db.execute({
        sql: `INSERT INTO orders (${cols.join(', ')}) VALUES ${valuesSql} RETURNING id`,
        args,
      });

      insertedIds = orderResult.rows.map(r => Number(r.id));

      // ---- 2-c: processes 배치 INSERT (orders × STEPS) ----
      if (insertedIds.length > 0 && STEPS.length > 0) {
        const procRowPh = `(?, ?, 'waiting')`;
        const procRows = [];
        const procArgs = [];
        for (const orderId of insertedIds) {
          for (const step of STEPS) {
            procRows.push(procRowPh);
            procArgs.push(orderId, step);
          }
        }
        await db.execute({
          sql: `INSERT INTO processes (order_id, step_name, status) VALUES ${procRows.join(', ')}`,
          args: procArgs,
        });

        // ---- 2-d: pre_production 배치 INSERT ----
        const preRowPh = `(?)`;
        const preValuesSql = insertedIds.map(() => preRowPh).join(', ');
        await db.execute({
          sql: `INSERT INTO pre_production (order_id) VALUES ${preValuesSql}`,
          args: insertedIds,
        });
      }

      importedCount += insertedIds.length;
    } catch (err) {
      if (insertedIds.length > 0) {
        try {
          const placeholders = insertedIds.map(() => '?').join(',');
          await db.execute({
            sql: `DELETE FROM orders WHERE id IN (${placeholders})`,
            args: insertedIds,
          });
        } catch (cleanupErr) {
          errors.push(`청크 실패 후 정리 실패: ${cleanupErr.message}`);
        }
      }
      // 청크 실패 시 해당 청크 행 번호 범위로 에러 기록
      const first = toInsert[0]?.rowIndex;
      const last = toInsert[toInsert.length - 1]?.rowIndex;
      errors.push(`청크 INSERT 실패(행 ${first}-${last}): ${err.message}`);
    }
  }

  return res.json({
    imported: importedCount,
    inserted: importedCount,
    skipped: skippedCount,
    total: totalCount,
    dryRun,
    errors: errors.length,
    errorDetails: errors.slice(0, 20),
  });
});
