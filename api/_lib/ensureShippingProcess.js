// 출고 공정 중복 생성(두 작업자 동시 완료 / 더블클릭)을 DB 가 막아주는 부분 유니크 인덱스.
// 이게 없으면 두 요청이 모두 `INSERT ... WHERE NOT EXISTS` 를 통과해 '출고' 행이 2개 생기고,
// 이후 남은 고아 행이 revert 의 startedLater 검사에 걸려 이전 공정 되돌리기가 영구 차단된다.
export const SHIPPING_PROCESS_UNIQUE_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_unique_shipping
          ON processes(order_id, step_name)
          WHERE step_name = '출고'`;

// 모듈 단위 캐시 — 매 요청마다 DDL 왕복을 돌지 않는다. (api/_lib/ensureSchema.js 와 동일 방식)
// getDb() 가 매번 새 객체를 반환하므로 WeakMap(db) 키 캐시는 쓰지 않는다.
let shippingUniqueIndexReady = false;

export async function ensureShippingProcessUniqueIndex(db) {
  if (shippingUniqueIndexReady) return;
  try {
    await db.execute({ sql: SHIPPING_PROCESS_UNIQUE_INDEX_SQL, args: [] });
    shippingUniqueIndexReady = true;
  } catch (error) {
    // 이미 중복 '출고' 행이 남아 있으면 인덱스 생성이 실패한다.
    // 그 실패로 출고/공정완료 자체를 막으면 안 되므로 로그만 남기고 계속 진행한다.
    // 성공 시에만 캐시하므로 원인이 정리되면 다음 요청에서 자동으로 다시 시도한다.
    console.warn('[processes] 출고 중복 방지 인덱스 생성 실패(무시):', error?.message || error);
  }
}

export async function ensureShippingProcesses(db) {
  await db.execute({
    sql: `DELETE FROM processes
          WHERE step_name = '출고'
            AND id IN (
              SELECT id
              FROM (
                SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY order_id, step_name
                    ORDER BY
                      CASE status
                        WHEN 'completed' THEN 1
                        WHEN 'in_progress' THEN 2
                        ELSE 3
                      END,
                      id
                  ) AS duplicate_rank
                FROM processes
                WHERE step_name = '출고'
              ) ranked
              WHERE duplicate_rank > 1
            )`,
    args: [],
  });

  await db.execute({
    sql: SHIPPING_PROCESS_UNIQUE_INDEX_SQL,
    args: [],
  });

  await db.execute({
    sql: `INSERT INTO processes (order_id, step_name, status)
          SELECT o.id, '출고', 'waiting'
          FROM orders o
          WHERE o.status = 'in_production'
            AND EXISTS (
              SELECT 1 FROM processes p_pack
              WHERE p_pack.order_id = o.id AND p_pack.step_name = '포장' AND p_pack.status = 'completed'
            )
            AND NOT EXISTS (
              SELECT 1 FROM processes p_ship
              WHERE p_ship.order_id = o.id AND p_ship.step_name = '출고'
            )
          ON CONFLICT (order_id, step_name) WHERE step_name = '출고' DO NOTHING`,
    args: [],
  });

}
