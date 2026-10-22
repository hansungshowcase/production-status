import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { sanitizeInput } from '../_lib/sanitize.js';
import { STEPS } from '../_lib/steps.js';
import { daysUntilDue } from '../_lib/daysUntilDue.js';
import { requireAuth } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { ensureOrderImageColumn } from '../_lib/ensureSchema.js';
import { appendOrderToSheet } from '../_lib/googleSheets.js';
import { ensureSheetSyncSchema } from '../_lib/sheetSyncSchema.js';
import { syncOrderToSheet } from '../_lib/sheetSync.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { generateTrackToken } from '../_lib/trackToken.js';
import {
  normalizeOrderCreateInput,
  OrderCreateInputValidationError,
} from '../_lib/orderCreateInput.js';

async function ensureCreatedOrderTrackToken(db, order) {
  const { ensureTrackToken } = await import('../_lib/trackToken.js');
  return ensureTrackToken(db, order);
}

async function notifyCreatedOrder(db, order) {
  const { maybeNotify } = await import('../_lib/notify.js');
  return maybeNotify(db, order, 'ordered');
}

// LIKE 와일드카드(%, _, \\) 이스케이프 — 사용자 입력에 포함되면 전체매칭/단일자매칭으로 풀스캔 유발
function likeEscape(s) {
  if (s == null) return s;
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function normalizeWorkOrderSearch(s) {
  return String(s || '').trim().replace(/촵/g, '찹');
}

function compactSearchText(s) {
  return normalizeWorkOrderSearch(s)
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]/g, '');
}

const GENERAL_SEARCH_WHITESPACE_SQL = "E' \\t\\n\\r\\f\\u000B\\u00A0\\u3000'";

function normalizeGeneralSearch(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[ \t\n\r\f\v\u00A0\u3000]/g, '');
}

function buildSearchFilter(search, isWorkOrderSearch) {
  const searchText = isWorkOrderSearch ? normalizeWorkOrderSearch(search) : search;
  const originalPattern = `%${likeEscape(searchText)}%`;
  const columns = isWorkOrderSearch ? [
    'CAST(o.id AS TEXT)',
    'o.client_name', 'o.product_type', 'o.door_type', 'o.sales_person',
    'o.notes', 'o.remarks', 'o.etc_notes',
    'o.phone', 'o.color', 'o.design', 'o.lead_source',
    'o.order_date', 'o.due_date', 'o.ship_scheduled_date',
    'CAST(o.width AS TEXT)', 'CAST(o.depth AS TEXT)', 'CAST(o.height AS TEXT)',
    'CAST(o.quantity AS TEXT)',
  ] : [
    'CAST(o.id AS TEXT)',
    'o.client_name', 'o.product_type', 'o.door_type', 'o.sales_person',
    'o.phone', 'o.color', 'o.design', 'o.notes', 'o.remarks', 'o.etc_notes',
    'o.lead_source', 'o.order_date', 'o.due_date', 'o.ship_scheduled_date',
    'o.work_order_image_url',
    'CAST(o.width AS TEXT)', 'CAST(o.depth AS TEXT)', 'CAST(o.height AS TEXT)',
    'CAST(o.quantity AS TEXT)',
  ];
  const originalPredicates = columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ');

  if (isWorkOrderSearch) {
    const compact = compactSearchText(searchText);
    if (compact) {
      const haystack = `regexp_replace(lower(concat_ws(' ', ${columns.map(column => `COALESCE(${column}, '')`).join(', ')})), '[^0-9a-z가-힣]', '', 'g')`;
      return {
        sql: ` AND ((${originalPredicates}) OR ${haystack} LIKE ?)`,
        args: [...columns.map(() => originalPattern), `%${compact}%`],
      };
    }
  } else {
    const normalizedText = normalizeGeneralSearch(searchText);
    if (normalizedText) {
      const normalizedPattern = `%${likeEscape(normalizedText)}%`;
      const normalizedPredicates = columns.map(column => (
        `translate(normalize(COALESCE(${column}, ''), NFC), ${GENERAL_SEARCH_WHITESPACE_SQL}, '') LIKE ? ESCAPE '\\'`
      )).join(' OR ');
      return {
        sql: ` AND ((${originalPredicates}) OR (${normalizedPredicates}))`,
        args: [
          ...columns.map(() => originalPattern),
          ...columns.map(() => normalizedPattern),
        ],
      };
    }
  }

  return {
    sql: ` AND (${originalPredicates})`,
    args: columns.map(() => originalPattern),
  };
}

const ORDER_FIELDS = [
  'order_date', 'due_date', 'sales_person', 'client_name',
  'ship_date', 'sale_amount', 'lead_source', 'balance',
  'phone', 'delivery_address', 'freight_payment', 'product_type', 'door_type', 'design',
  'width', 'depth', 'height', 'quantity', 'color',
  'notes', 'remarks', 'etc_notes', 'ship_scheduled_date',
  'sms_sent', 'safe_delivery', 'work_order_image_url', 'status',
];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stepOrderCase(alias) {
  const clauses = STEPS.map((step, index) => `WHEN ${sqlString(step)} THEN ${index}`).join(' ');
  return `CASE ${alias}.step_name ${clauses} ELSE 999 END`;
}

function stepListSql() {
  return STEPS.map(sqlString).join(', ');
}

function completedStepCountSql() {
  return `(
    SELECT COUNT(DISTINCT p.step_name)
    FROM processes p
    WHERE p.order_id = o.id
      AND p.step_name IN (${stepListSql()})
      AND p.status = 'completed'
  )`;
}

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'POST') {
    if (!rateLimitCheck(req, res)) return;
    return handlePost(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

export async function handleGet(req, res, db = getDb()) {
  const processStepOrder = stepOrderCase('p');
  const {
    sales_person, status, client_name, product_type, search,
    overdue, due_soon, search_mode,
  } = req.query;
  const isWorkOrderSearch = search_mode === 'work_order';
  const searchFilter = search ? buildSearchFilter(search, isWorkOrderSearch) : null;

  let limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 200));
  let offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // 상관 서브쿼리 3개를 derived table JOIN으로 변환 (N×M → N+M, idx_processes_order_id 활용)
  let sql = `
    SELECT
      o.id, o.order_date, o.due_date, o.sales_person, o.client_name,
      o.ship_date, o.sale_amount, o.lead_source, o.balance,
      o.phone, o.delivery_address, o.freight_payment, o.product_type, o.door_type, o.design,
      o.width, o.depth, o.height, o.quantity, o.color,
      o.notes, o.remarks, o.etc_notes, o.ship_scheduled_date,
      o.sms_sent, o.safe_delivery, o.status, o.created_at, o.updated_at,
      o.work_instruction_revision, o.work_instruction_received_revision,
      o.work_instruction_received_at, o.work_instruction_received_by,
      CASE WHEN o.work_order_image_url IS NULL OR o.work_order_image_url = '' THEN 0 ELSE 1 END AS has_work_order_image,
      (
        SELECT ph.file_path
        FROM photos ph
        JOIN processes pp ON pp.id = ph.process_id
        WHERE ph.order_id = o.id AND pp.step_name = '포장'
        ORDER BY ph.uploaded_at DESC
        LIMIT 1
      ) AS packing_photo_url,
      (
        SELECT ph.id
        FROM photos ph
        JOIN processes pp ON pp.id = ph.process_id
        WHERE ph.order_id = o.id AND pp.step_name = '포장'
        ORDER BY ph.uploaded_at DESC
        LIMIT 1
      ) AS packing_photo_id,
      COALESCE(ps.completed_steps, 0) AS completed_steps,
      COALESCE(ps.total_steps, 0) AS total_steps,
      COALESCE(ps.process_summary, '{}'::jsonb) AS process_summary,
      COALESCE(iss.open_issues, 0) AS open_issues
    FROM orders o
    LEFT JOIN (
      SELECT order_id,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_steps,
        COUNT(*) AS total_steps,
        jsonb_object_agg(
          step_name,
          jsonb_build_object(
            'status', status,
            'started_by', started_by,
            'completed_by', completed_by,
            'started_at', started_at,
            'completed_at', completed_at
          )
        ) AS process_summary
      FROM (
        SELECT *
        FROM (
          SELECT p.*,
            ROW_NUMBER() OVER (
              PARTITION BY p.order_id, p.step_name
              ORDER BY
                CASE p.status
                  WHEN 'in_progress' THEN 0
                  WHEN 'completed' THEN 1
                  WHEN 'waiting' THEN 2
                  ELSE 3
                END,
                p.id DESC
            ) AS rn
          FROM processes p
          WHERE p.step_name IN (${stepListSql()})
        ) ranked
        WHERE rn = 1
      ) canonical_processes
      GROUP BY order_id
    ) ps ON ps.order_id = o.id
    LEFT JOIN (
      SELECT order_id, COUNT(*) AS open_issues
      FROM issues
      WHERE resolved_at IS NULL
      GROUP BY order_id
    ) iss ON iss.order_id = o.id
    WHERE 1=1
  `;
  const params = [];

  if (sales_person) {
    sql += ' AND o.sales_person = ?';
    params.push(sales_person);
  }

  if (client_name) {
    sql += " AND o.client_name LIKE ? ESCAPE '\\'";
    params.push(`%${likeEscape(client_name)}%`);
  }

  if (product_type) {
    sql += " AND o.product_type LIKE ? ESCAPE '\\'";
    params.push(`%${likeEscape(product_type)}%`);
  }

  if (searchFilter) {
    sql += searchFilter.sql;
    params.push(...searchFilter.args);
  }

  if (status === 'shipped') {
    sql += " AND o.status = 'shipped'";
  } else if (status === 'in_production') {
    sql += " AND o.status = 'in_production'";
  } else if (status === 'completed') {
    sql += ` AND ${completedStepCountSql()} = ${STEPS.length}`;
  } else if (status === 'in_progress') {
    sql += ` AND ${completedStepCountSql()} > 0
             AND ${completedStepCountSql()} < ${STEPS.length}`;
  } else if (status === 'waiting') {
    sql += ` AND ${completedStepCountSql()} = 0
             AND o.status = 'in_production'`;
  }

  // overdue/due_soon 필터를 SQL 단계로 (200건 LIMIT 후 JS filter 시 누락 방지)
  if (overdue === 'true') {
    sql += ` AND o.due_date IS NOT NULL AND o.due_date < to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AND o.status != 'shipped'`;
  }
  if (due_soon === 'true') {
    sql += ` AND o.due_date IS NOT NULL
             AND o.due_date >= to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD')
             AND o.due_date <= to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date + INTERVAL '3 days', 'YYYY-MM-DD')
             AND o.status != 'shipped'`;
  }

  sql += ' ORDER BY o.id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const result = await db.execute({ sql, args: params });
  let orders = result.rows;

  // Add computed field: days_until_due
  orders = orders.map(order => ({
    ...order,
    days_until_due: daysUntilDue(order.due_date),
  }));

  // Get total count for pagination
  let countSql = 'SELECT COUNT(*) AS count FROM orders o WHERE 1=1';
  const countParams = [];
  if (sales_person) { countSql += ' AND o.sales_person = ?'; countParams.push(sales_person); }
  if (client_name) { countSql += " AND o.client_name LIKE ? ESCAPE '\\'"; countParams.push(`%${likeEscape(client_name)}%`); }
  if (product_type) { countSql += " AND o.product_type LIKE ? ESCAPE '\\'"; countParams.push(`%${likeEscape(product_type)}%`); }
  if (searchFilter) {
    countSql += searchFilter.sql;
    countParams.push(...searchFilter.args);
  }
  if (status === 'shipped') {
    countSql += " AND o.status = 'shipped'";
  } else if (status === 'in_production') {
    countSql += " AND o.status = 'in_production'";
  } else if (status === 'completed') {
    countSql += ` AND ${completedStepCountSql()} = ${STEPS.length}`;
  } else if (status === 'in_progress') {
    countSql += ` AND ${completedStepCountSql()} > 0
             AND ${completedStepCountSql()} < ${STEPS.length}`;
  } else if (status === 'waiting') {
    countSql += ` AND ${completedStepCountSql()} = 0
             AND o.status = 'in_production'`;
  }
  // overdue/due_soon — 메인 쿼리와 동일 조건 (total 정확성)
  if (overdue === 'true') {
    countSql += ` AND o.due_date IS NOT NULL AND o.due_date < to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AND o.status != 'shipped'`;
  }
  if (due_soon === 'true') {
    countSql += ` AND o.due_date IS NOT NULL
             AND o.due_date >= to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD')
             AND o.due_date <= to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Seoul')::date + INTERVAL '3 days', 'YYYY-MM-DD')
             AND o.status != 'shipped'`;
  }

  const countResult = await db.execute({ sql: countSql, args: countParams });
  const total = countResult.rows[0].count;

  return res.json({ orders, total });
}

export async function handlePost(req, res, db, {
  append = appendOrderToSheet,
  ensureTrackToken = ensureCreatedOrderTrackToken,
  notify = notifyCreatedOrder,
  requireAuth: checkAuth = requireAuth,
} = {}) {
  const auth = await checkAuth(req, res, { roles: ['sales', 'admin', 'worker'] });
  if (!auth) return;
  const sanitizedBody = sanitizeInput(req.body);
  if (!sanitizedBody.client_name) {
    return res.status(400).json({ error: { message: '거래처는 필수 항목입니다.', status: 400 } });
  }
  let body;
  try {
    body = normalizeOrderCreateInput(sanitizedBody);
  } catch (err) {
    if (err instanceof OrderCreateInputValidationError) {
      return res.status(400).json({ error: { message: err.message, status: 400 } });
    }
    throw err;
  }
  const {
    client_name, width, depth, height, quantity, product_type, door_type, color,
  } = body;

  // Validation
  if (!client_name) {
    return res.status(400).json({ error: { message: '거래처는 필수 항목입니다.', status: 400 } });
  }

  const {
    order_date, due_date, sales_person,
    design, phone, delivery_address, freight_payment, notes, remarks, etc_notes,
    sale_amount, lead_source, balance,
    ship_scheduled_date, sms_sent, safe_delivery, work_order_image_url,
  } = body;

  db ??= getDb();
  await ensureOrderImageColumn(db);
  await ensureNotifySchema(db);
  await ensureSheetSyncSchema(db);

  try {
    const orderedIntent = JSON.stringify({ ordered: { status: 'queued', at: new Date().toISOString() } });
    const stepValues = STEPS.map((_, index) => `(?, ${index})`).join(', ');
    const orderResult = await db.execute({
      sql: `WITH inserted_order AS (
        INSERT INTO orders (
          order_date, due_date, sales_person, client_name,
          product_type, door_type, design, width, depth, height,
          quantity, color, phone, delivery_address, freight_payment, notes, remarks, etc_notes,
          sale_amount, lead_source, balance,
          ship_scheduled_date, sms_sent, safe_delivery, work_order_image_url, track_token, notify_state, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'in_production')
        RETURNING *
      ),
      inserted_sheet_sync_job AS (
        INSERT INTO sheet_sync_jobs (order_id, status)
        SELECT id, 'pending' FROM inserted_order
        RETURNING order_id
      ),
      step_values (step_name, step_order) AS (
        VALUES ${stepValues}
      ),
      inserted_processes AS (
        INSERT INTO processes (order_id, step_name, status)
        SELECT io.id, sv.step_name, 'waiting'
          FROM inserted_order io
          CROSS JOIN step_values sv
         ORDER BY sv.step_order
        RETURNING *
      ),
      inserted_pre_production AS (
        INSERT INTO pre_production (order_id)
        SELECT id FROM inserted_order
        RETURNING *
      ),
      inserted_activity AS (
        INSERT INTO activity_feed (order_id, action_type, description, actor)
        SELECT id, '주문등록', ?, ?
          FROM inserted_order
        RETURNING id
      )
      SELECT to_jsonb(io) AS order_row,
             COALESCE((
               SELECT jsonb_agg(to_jsonb(ip) ORDER BY ${stepOrderCase('ip')}, ip.id)
                 FROM inserted_processes ip
             ), '[]'::jsonb) AS process_rows,
             (SELECT to_jsonb(pp) FROM inserted_pre_production pp) AS pre_production_row
        FROM inserted_order io
        JOIN inserted_sheet_sync_job sj ON sj.order_id = io.id
       WHERE (SELECT COUNT(*) FROM inserted_processes) = ?
         AND EXISTS (SELECT 1 FROM inserted_pre_production)
         AND EXISTS (SELECT 1 FROM inserted_activity)`,
      args: [
        order_date || null, due_date || null, sales_person || null, client_name,
        product_type || null, door_type || null, design || null,
        width ?? null, depth ?? null, height ?? null,
        quantity, color || null, phone || null, delivery_address || null, freight_payment || null,
        notes || null, remarks || null, etc_notes || null,
        sale_amount ?? null, lead_source || null, balance ?? null,
        ship_scheduled_date || null, sms_sent ?? null, safe_delivery ?? 0, work_order_image_url || null,
        generateTrackToken(),
        orderedIntent,
        ...STEPS,
        `${client_name} 주문이 등록되었습니다.`,
        auth.actor,
        STEPS.length,
      ],
    });
    if (!orderResult.rows || orderResult.rows.length === 0) {
      throw new Error('주문 생성 필수 레코드가 단일 원자 작업 안에서 완료되지 않았습니다.');
    }
    const committed = orderResult.rows[0];
    const created = {
      ...committed.order_row,
      processes: committed.process_rows,
      pre_production: committed.pre_production_row || null,
    };
    created.sheet_sync = await syncOrderToSheet(db, created, { append });

    // 알림 훅: 주문 생성 → track_token 발급 + 접수 알림 (실패해도 본 응답에 영향 없음)
    try {
      created.track_token = await ensureTrackToken(db, created);
    } catch (tokenErr) {
      console.error('[orders POST] track_token 발급 실패(무시):', tokenErr?.message || tokenErr);
    }
    try {
      await notify(db, created);
    } catch (notifyErr) {
      console.error('[orders POST] ordered 알림 발송 실패(무시):', notifyErr?.message || notifyErr);
    }

    return res.status(201).json(created);
  } catch (err) {
    if (err.message && (err.message.includes('UNIQUE constraint') || err.message.includes('duplicate key'))) {
      return res.status(409).json({ error: { message: '이미 존재하는 주문입니다.', status: 409 } });
    }
    throw err;
  }
}
