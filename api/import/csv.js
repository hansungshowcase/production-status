import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { STEPS } from '../_lib/steps.js';
import { parseMultipart, getFilePart } from '../_lib/parseBody.js';
import { requireAuth } from '../_lib/auth.js';
import { normalizeOrderMutationInput } from '../_lib/orderCreateInput.js';
import { ensureSheetSyncSchema } from '../_lib/sheetSyncSchema.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { generateTrackToken } from '../_lib/trackToken.js';

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

// orders 의 치수/수량 컬럼은 INTEGER 다. '1200mm' 같은 값을 Number() 로 그대로 넘기면
// NaN 이 SQL 로 들어가고 Postgres 가 청크(최대 100행) 전체를 거절한다.
// 파싱은 행 단위로 막아야 나머지 행이 정상 등록된다.
const NUMERIC_FIELD_LABELS = {
  quantity: '수량',
  width: '가로',
  depth: '세로',
  height: '높이',
};

export function parseIntegerCell(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const text = String(raw).trim().replace(/,/g, '');
  if (!text) return { ok: true, value: null };
  if (!/^[+-]?\d+(?:\.0+)?$/.test(text)) return { ok: false, value: null };
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { ok: false, value: null };
  }
  return { ok: true, value };
}

export async function handleCsvImport(req, res, dependencies = {}) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const checkAuth = dependencies.requireAuth || requireAuth;
  const auth = checkAuth(req, res, { roles: ['admin'] });
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

  const db = dependencies.db || getDb();
  const ensureSyncSchema = dependencies.ensureSheetSyncSchema || ensureSheetSyncSchema;
  const ensureTokenSchema = dependencies.ensureNotifySchema || ensureNotifySchema;
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

    // 숫자 컬럼 파싱 실패는 그 행만 오류로 기록하고 건너뛴다. NaN 을 SQL 로 넘기면
    // 같은 청크의 멀쩡한 행까지 통째로 실패한다.
    const numbers = {};
    let hasNumericError = false;
    for (const [field, label] of Object.entries(NUMERIC_FIELD_LABELS)) {
      const raw = get(field);
      const parsed = parseIntegerCell(raw);
      if (!parsed.ok) {
        errors.push(`행 ${i + 1}: '${label}' 값 "${String(raw).trim()}" 은(는) 숫자가 아니라 건너뜁니다.`);
        hasNumericError = true;
        continue;
      }
      numbers[field] = parsed.value;
    }
    if (hasNumericError) continue;

    const quantity = numbers.quantity;
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
        width: numbers.width,
        depth: numbers.depth,
        height: numbers.height,
        quantity,
        color: get('color'),
        notes: get('notes'),
        status,
      }),
    });
  }

  const totalCount = candidates.length;

  // CSV 로 만든 주문도 정상 등록 경로(api/orders/index.js handlePost)와 똑같이
  // sheet_sync_jobs 에 동기화 잡을 넣어야 구글시트에 반영된다.
  // 잡 INSERT 전에 스키마 보정이 끝나 있어야 한다. (dry-run 은 쓰지 않으므로 제외)
  if (!dryRun && candidates.length > 0) {
    await ensureSyncSchema(db);
    // 고객 조회 링크는 등록 경로와 동일하게 CSV 주문에도 발급한다(발송은 하지 않는다).
    // 컬럼/유니크 인덱스가 있어야 INSERT 가 track_token 을 채울 수 있다.
    await ensureTokenSchema(db);
  }

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
        // 중복 조회가 실패하면 existingKeys 가 빈 채로 남아 "중복 없음"으로 오판하고
        // 이미 있는 주문을 전량 다시 INSERT 한다. 대량 중복 생성이 훨씬 큰 피해라
        // 여기서 요청을 실패시킨다.
        const detail = `중복 조회 실패(행 ${chunk[0]?.rowIndex}-${chunk[chunk.length - 1]?.rowIndex}): ${err.message}`;
        errors.push(detail);
        return res.status(500).json({
          error: {
            message: `기존 주문 중복 확인에 실패해 가져오기를 중단했습니다. 중복 등록을 막기 위해 남은 행은 저장하지 않았습니다. (${err.message})`,
            status: 500,
          },
          imported: importedCount,
          inserted: importedCount,
          skipped: skippedCount,
          total: totalCount,
          dryRun,
          errors: errors.length,
          errorDetails: errors.slice(0, 20),
        });
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
        'quantity', 'color', 'notes', 'status', 'track_token',
      ];
      const rowPh = `(${cols.map(() => '?').join(', ')})`;
      const valuesSql = toInsert.map(() => rowPh).join(', ');
      const args = [];
      for (const cand of toInsert) {
        // 고객 조회 링크 토큰은 행마다 새로 뽑는다(순수 CPU, 실패 없음).
        for (const col of cols) args.push(col === 'track_token' ? generateTrackToken() : cand.values[col]);
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

      // ---- 2-e: sheet_sync_jobs 배치 INSERT (구글시트 동기화 큐) ----
      // 정상 등록 경로는 주문 INSERT 와 잡 INSERT 를 한 CTE 로 실행한다. CSV 경로에도
      // 잡을 넣어야 CSV 주문이 구글시트에 들어간다. 즉시 동기화는 크론이 처리하므로 여기선 큐잉만.
      //
      // 고객 알림(notify.js 의 maybeNotify)은 의도적으로 부르지 않는다.
      // CSV 가져오기는 과거 주문 대량 이관에 쓰이므로, 여기서 알림을 보내면
      // 몇 달 지난 주문의 접수 문자가 지금 고객에게 발송되는 사고가 난다.
      if (insertedIds.length > 0) {
        const jobValuesSql = insertedIds.map(() => `(?, 'pending')`).join(', ');
        await db.execute({
          sql: `INSERT INTO sheet_sync_jobs (order_id, status) VALUES ${jobValuesSql}
                ON CONFLICT (order_id) DO NOTHING`,
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
}

export default cors(handleCsvImport);
