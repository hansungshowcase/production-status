import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';

const DEPARTMENTS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장'];

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'POST') {
    return handlePost(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(req, res) {
  const db = getDb();
  const { department } = req.query;

  if (department) {
    if (!DEPARTMENTS.includes(department)) {
      return res.status(400).json({
        error: { message: `유효하지 않은 부서명입니다. 유효한 부서: ${DEPARTMENTS.join(', ')}`, status: 400 },
      });
    }
    const { rows } = await db.execute({
      sql: 'SELECT * FROM workers WHERE department = ? ORDER BY name',
      args: [department],
    });
    return res.json(rows);
  }

  const { rows } = await db.execute({ sql: 'SELECT * FROM workers ORDER BY department, name', args: [] });
  return res.json(rows);
}

async function handlePost(req, res) {
  const { name, department } = req.body;

  // Validation
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: { message: 'name은 필수 항목입니다.', status: 400 } });
  }
  if (!department || !DEPARTMENTS.includes(department)) {
    return res.status(400).json({
      error: { message: `department은 다음 중 하나여야 합니다: ${DEPARTMENTS.join(', ')}`, status: 400 },
    });
  }

  const db = getDb();

  const existingResult = await db.execute({
    sql: 'SELECT id FROM workers WHERE name = ? AND department = ?',
    args: [name, department],
  });
  if (existingResult.rows.length > 0) {
    return res.status(409).json({
      error: { message: '이미 등록된 작업자입니다.', status: 409 },
    });
  }

  const result = await db.execute({
    sql: 'INSERT INTO workers (name, department) VALUES (?, ?)',
    args: [name, department],
  });

  const workerResult = await db.execute({
    sql: 'SELECT * FROM workers WHERE id = ?',
    args: [Number(result.lastInsertRowid)],
  });

  return res.status(201).json(workerResult.rows[0]);
}
