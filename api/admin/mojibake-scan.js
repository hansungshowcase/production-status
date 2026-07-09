import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';

// 진단 전용. cp949 잔존 행 검출 후 ID/prefix 반환. 변환은 별도 결정.
export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const auth = requireAuth(req, res, { roles: ['admin'] });
  if (!auth) return;

  const db = getDb();

  // 표본 추출 — 각 테이블에서 한글 컬럼 일부 가져와 클라이언트 측 판별 회피하고 SQL에서 한글 외 잠재 깨짐 패턴 검색
  // Postgres에서 cp949 잔존 데이터는 utf8 환경에서는 ENCODING 에러로 보통 SELECT 시 ? 또는 invalid byte 발생.
  // 안전을 위해 일정 패턴(연속 ? 또는 비ASCII 비한글 캐릭터)을 의심 행으로 마킹.
  // 가-힯: 완성형 한글, 정상 범위
  // 의심 패턴: 비ASCII이면서 한글/숫자/기호 범위 외
  const suspectRegex = `[^\\x20-\\x7E\\uAC00-\\uD7AF\\u3131-\\u318E\\u2000-\\u206F\\u00A0-\\u00FF]`;

  const checks = [
    { table: 'activity_feed', col: 'description' },
    { table: 'orders', col: 'client_name' },
    { table: 'orders', col: 'notes' },
    { table: 'orders', col: 'remarks' },
    { table: 'issues', col: 'description' },
  ];

  const results = {};
  for (const c of checks) {
    try {
      const { rows: countRows } = await db.execute({
        sql: `SELECT COUNT(*) AS count FROM ${c.table}
              WHERE ${c.col} IS NOT NULL AND ${c.col} ~ ?`,
        args: [suspectRegex],
      });
      const { rows } = await db.execute({
        sql: `SELECT id, ${c.col} AS sample FROM ${c.table}
              WHERE ${c.col} IS NOT NULL AND ${c.col} ~ ?
              ORDER BY id DESC LIMIT 20`,
        args: [suspectRegex],
      });
      results[`${c.table}.${c.col}`] = {
        suspectCount: Number(countRows[0]?.count || 0),
        samples: rows.map(r => ({
          id: r.id,
          preview: String(r.sample).slice(0, 80),
        })),
      };
    } catch (err) {
      results[`${c.table}.${c.col}`] = { error: err.message || 'scan failed' };
    }
  }

  const total = Object.values(results)
    .reduce((sum, r) => sum + (r.suspectCount || 0), 0);

  return res.json({
    scanned_at: new Date().toISOString(),
    total_suspect_rows: total,
    note: total === 0
      ? '의심 데이터 없음. 변환 작업 불필요.'
      : '의심 행 발견 — 샘플 확인 후 별도 변환 스크립트 결정.',
    results,
  });
});
