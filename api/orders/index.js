import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { sanitizeInput } from '../_lib/sanitize.js';
import { STEPS } from '../_lib/steps.js';
import { daysUntilDue } from '../_lib/daysUntilDue.js';
import { requireAuth, resolveActor } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { ensureOrderImageColumn } from '../_lib/ensureSchema.js';
import { appendOrderToSheet } from '../_lib/googleSheets.js';
import { ensureTrackToken } from '../_lib/trackToken.js';
import { maybeNotify } from '../_lib/notify.js';

// LIKE 와일드카드(%, _, \\) 이스케이프 — 사용자 입력에 포함되면 전체매칭/단일자매칭으로 풀스캔 유발
function likeEscape(s) {
  if (s == null) return s;
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const ORDER_FIELDS = [
  'order_date', 'due_date', 'sales_person', 'client_name',
  'ship_date', 'sale_amount', 'lead_source', 'balance',
  'phone', 'product_type', 'door_type', 'design',
  'width', 'depth', 'height', 'quantity', 'color',
  'notes', 'remarks', 'etc_notes', 'ship_scheduled_date',
  'sms_sent', 'safe_delivery', 'work_order_image_url', 'status',
];

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

async function handleGet(req, res) {
  const db = getDb();
  await ensureOrderImageColumn(db);
  const {
    sales_person, status, client_name, product_type, search,
    overdue, due_soon,
  } = req.query;

  let limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 200));
  let offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // 상관 서브쿼리 3개를 derived table JOIN으로 변환 (N×M → N+M, idx_processes_order_id 활용)
  let sql = `
    SELECT
      o.id, o.order_date, o.due_date, o.sales_person, o.client_name,
      o.ship_date, o.sale_amount, o.lead_source, o.balance,
      o.phone, o.product_type, o.door_type, o.design,
      o.width, o.depth, o.height, o.quantity, o.color,
      o.notes, o.remarks, o.etc_notes, o.ship_scheduled_date,
      o.sms_sent, o.safe_delivery, o.status, o.created_at, o.updated_at,
      CASE WHEN o.work_order_image_url IS NULL OR o.work_order_image_url = '' THEN 0 ELSE 1 END AS has_work_order_image,
      (
        SELECT ph.file_path
        FROM photos ph
        JOIN processes pp ON pp.id = ph.process_id
        WHERE ph.order_id = o.id AND pp.step_name = '포장'
        ORDER BY ph.uploaded_at DESC
        LIMIT 1
      ) AS packing_photo_url,
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
      FROM processes
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

  if (search) {
    const s = `%${likeEscape(search)}%`;
    const cols = [
      'o.client_name', 'o.product_type', 'o.door_type', 'o.sales_person',
      'o.phone', 'o.color', 'o.design', 'o.notes', 'o.remarks', 'o.etc_notes',
      'o.lead_source', 'o.order_date', 'o.due_date',
      'CAST(o.width AS TEXT)', 'CAST(o.depth AS TEXT)', 'CAST(o.height AS TEXT)',
      'CAST(o.quantity AS TEXT)',
    ];
    sql += ` AND (${cols.map(col => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    params.push(...cols.map(() => s));
  }

  if (status === 'shipped') {
    sql += " AND o.status = 'shipped'";
  } else if (status === 'in_production') {
    sql += " AND o.status = 'in_production'";
  } else if (status === 'completed') {
    sql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') = 0`;
  } else if (status === 'in_progress') {
    sql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') > 0
             AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') > 0`;
  } else if (status === 'waiting') {
    sql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') = 0
             AND o.status = 'in_production'`;
  }

  // overdue/due_soon 필터를 SQL 단계로 (200건 LIMIT 후 JS filter 시 누락 방지)
  if (overdue === 'true') {
    sql += ` AND o.due_date IS NOT NULL AND o.due_date < to_char(CURRENT_DATE, 'YYYY-MM-DD') AND o.status != 'shipped'`;
  }
  if (due_soon === 'true') {
    sql += ` AND o.due_date IS NOT NULL
             AND o.due_date >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
             AND o.due_date <= to_char(CURRENT_DATE + INTERVAL '3 days', 'YYYY-MM-DD')
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
  if (search) {
    const s = `%${likeEscape(search)}%`;
    const cols = [
      'o.client_name', 'o.product_type', 'o.door_type', 'o.sales_person',
      'o.phone', 'o.color', 'o.design', 'o.notes', 'o.remarks', 'o.etc_notes',
      'o.lead_source', 'o.order_date', 'o.due_date',
      'CAST(o.width AS TEXT)', 'CAST(o.depth AS TEXT)', 'CAST(o.height AS TEXT)',
      'CAST(o.quantity AS TEXT)',
    ];
    countSql += ` AND (${cols.map(col => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
    countParams.push(...cols.map(() => s));
  }
  if (status === 'shipped') {
    countSql += " AND o.status = 'shipped'";
  } else if (status === 'in_production') {
    countSql += " AND o.status = 'in_production'";
  } else if (status === 'completed') {
    countSql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') = 0`;
  } else if (status === 'in_progress') {
    countSql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') > 0
             AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') > 0`;
  } else if (status === 'waiting') {
    countSql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') = 0
             AND o.status = 'in_production'`;
  }
  // overdue/due_soon — 메인 쿼리와 동일 조건 (total 정확성)
  if (overdue === 'true') {
    countSql += ` AND o.due_date IS NOT NULL AND o.due_date < to_char(CURRENT_DATE, 'YYYY-MM-DD') AND o.status != 'shipped'`;
  }
  if (due_soon === 'true') {
    countSql += ` AND o.due_date IS NOT NULL
             AND o.due_date >= to_char(CURRENT_DATE, 'YYYY-MM-DD')
             AND o.due_date <= to_char(CURRENT_DATE + INTERVAL '3 days', 'YYYY-MM-DD')
             AND o.status != 'shipped'`;
  }

  const countResult = await db.execute({ sql: countSql, args: countParams });
  const total = countResult.rows[0].count;

  return res.json({ orders, total });
}

async function handlePost(req, res) {
  const auth = requireAuth(req, res, { roles: ['sales'] });
  if (!auth) return;
  const body = sanitizeInput(req.body);
  const {
    client_name, width, depth, height, quantity, product_type, door_type, color,
  } = body;

  // Validation
  if (!client_name) {
    return res.status(400).json({ error: { message: 'client_name은 필수 항목입니다.', status: 400 } });
  }
  if (width !== undefined && width !== null && (typeof width !== 'number' || width <= 0)) {
    return res.status(400).json({ error: { message: 'width는 양의 정수여야 합니다.', status: 400 } });
  }
  if (depth !== undefined && depth !== null && (typeof depth !== 'number' || depth <= 0)) {
    return res.status(400).json({ error: { message: 'depth는 양의 정수여야 합니다.', status: 400 } });
  }
  if (height !== undefined && height !== null && (typeof height !== 'number' || height <= 0)) {
    return res.status(400).json({ error: { message: 'height는 양의 정수여야 합니다.', status: 400 } });
  }
  if (quantity !== undefined && quantity !== null && (typeof quantity !== 'number' || quantity <= 0)) {
    return res.status(400).json({ error: { message: 'quantity는 양의 정수여야 합니다.', status: 400 } });
  }

  const {
    order_date, due_date, sales_person,
    design, phone, notes, remarks, etc_notes,
    sale_amount, lead_source, balance,
    ship_scheduled_date, sms_sent, safe_delivery, work_order_image_url,
  } = body;

  const db = getDb();
  await ensureOrderImageColumn(db);
  const tx = await db.transaction('write');
  let createdOrderId = null; // 부분 실패 시 cleanup용

  try {
    const orderResult = await tx.execute({
      sql: `INSERT INTO orders (
        order_date, due_date, sales_person, client_name,
        product_type, door_type, design, width, depth, height,
        quantity, color, phone, notes, remarks, etc_notes,
        sale_amount, lead_source, balance,
        ship_scheduled_date, sms_sent, safe_delivery, work_order_image_url, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_production') RETURNING id`,
      args: [
        // 숫자 컬럼은 0 보존 (`||` 사용 시 0이 falsy로 변조됨 → `??` 또는 undefined 체크)
        order_date || null, due_date || null, sales_person || null, client_name,
        product_type || null, door_type || null, design || null,
        width ?? null, depth ?? null, height ?? null,
        quantity ?? 1, color || null, phone || null,
        notes || null, remarks || null, etc_notes || null,
        sale_amount ?? null, lead_source || null, balance ?? null,
        ship_scheduled_date || null, sms_sent ?? null, safe_delivery ?? 0, work_order_image_url || null,
      ],
    });
    if (!orderResult.rows || orderResult.rows.length === 0) {
      throw new Error('주문 생성 실패: ID가 반환되지 않았습니다.');
    }
    const orderId = Number(orderResult.rows[0].id);
    createdOrderId = orderId; // cleanup용 추적

    // STEPS 9개를 1회 호출로 multi-row INSERT (N+1 제거, round-trip 9→1)
    const stepPlaceholders = STEPS.map(() => `(?, ?, 'waiting')`).join(', ');
    const stepArgs = STEPS.flatMap(step => [orderId, step]);
    await tx.execute({
      sql: `INSERT INTO processes (order_id, step_name, status) VALUES ${stepPlaceholders}`,
      args: stepArgs,
    });

    await tx.execute({
      sql: `INSERT INTO pre_production (order_id) VALUES (?)`,
      args: [orderId],
    });

    await tx.execute({
      sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
      args: [orderId, '주문등록', `${client_name} 주문이 등록되었습니다.`, sales_person || '시스템'],
    });

    await tx.commit();

    // 관련 데이터 병렬 SELECT (3개 직렬 → Promise.all)
    const [orderRow, processRows, preProdRow] = await Promise.all([
      db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] }),
      db.execute({ sql: 'SELECT * FROM processes WHERE order_id = ?', args: [orderId] }),
      db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] }),
    ]);

    const created = {
      ...orderRow.rows[0],
      processes: processRows.rows,
      pre_production: preProdRow.rows[0] || null,
    };

    // 알림 훅: 주문 생성 → track_token 발급 + ordered 알림 (실패해도 본 응답에 영향 없음)
    // 토큰 발급 실패가 ordered 알림까지 삼키지 않도록 try 분리
    try {
      created.track_token = await ensureTrackToken(db, created);
    } catch (tokenErr) {
      console.error('[orders POST] track_token 발급 실패(무시):', tokenErr);
    }
    try {
      await maybeNotify(db, created, 'ordered');
    } catch (notifyErr) {
      console.error('[orders POST] ordered 알림 발송 실패(무시):', notifyErr);
    }

    try {
      await appendOrderToSheet(created);
    } catch (sheetErr) {
      console.warn('Google Sheets order append skipped:', sheetErr?.message || sheetErr);
    }

    return res.status(201).json(created);
  } catch (err) {
    // Neon HTTP는 진짜 트랜잭션 미지원 — 부분 실패 시 cleanup으로 정합성 보호
    if (createdOrderId) {
      try {
        await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [createdOrderId] });
        // ON DELETE CASCADE로 processes/pre_production/activity_feed 자동 정리
      } catch (cleanupErr) {
        console.error('주문 생성 부분 실패 후 cleanup도 실패:', cleanupErr);
      }
    }
    if (err.message && (err.message.includes('UNIQUE constraint') || err.message.includes('duplicate key'))) {
      return res.status(409).json({ error: { message: '이미 존재하는 주문입니다.', status: 409 } });
    }
    throw err;
  }
}
