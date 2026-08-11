export const SHEET_SYNC_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS sheet_sync_jobs (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ,
  sheet_row INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

// CREATE TABLE IF NOT EXISTS 는 이미 존재하는 테이블을 고치지 않는다.
// 프로덕션에는 예전 스키마(id PK + action NOT NULL + 아래 세 컬럼 없음)가 남아 있어,
// 보정하지 않으면 claim/markSynced 쿼리가 "column does not exist" 로 죽는다.
export const SHEET_SYNC_COLUMN_BACKFILL_SQL = [
  'ALTER TABLE sheet_sync_jobs ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ',
  'ALTER TABLE sheet_sync_jobs ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ',
  'ALTER TABLE sheet_sync_jobs ADD COLUMN IF NOT EXISTS sheet_row INTEGER',
];

// 레거시 action 컬럼은 NOT NULL 인데 기본값이 없었다. 주문 등록은 orders INSERT 와
// 잡 INSERT 를 하나의 CTE 로 실행하므로, 잡 INSERT 가 NOT NULL 위반으로 실패하면
// 주문 등록 자체가 통째로 실패한다. (2026-08-04 등록 장애의 직접 원인)
export const SHEET_SYNC_LEGACY_ACTION_DEFAULT_SQL = "ALTER TABLE sheet_sync_jobs ALTER COLUMN action SET DEFAULT 'upsertOrder'";

// 신규 스키마에는 action 컬럼이 없다. 없는 컬럼에 ALTER 를 걸면 에러라서 먼저 확인한다.
// table_schema 를 고정한다. 다른 스키마의 동명 테이블에 반응해 없는 컬럼에 ALTER 를 걸면
// ensureSheetSyncSchema 가 통째로 실패하고, 그러면 막으려던 등록 장애가 그대로 재현된다.
export const SHEET_SYNC_LEGACY_ACTION_PROBE_SQL = "SELECT 1 AS present FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sheet_sync_jobs' AND column_name = 'action'";

// CREATE TABLE 문에는 ON DELETE CASCADE 가 적혀 있지만, 프로덕션의 레거시 테이블에는
// 외래키가 붙어 있지 않다(action 컬럼과 같은 유형). 주문을 지워도 잡이 남아,
// 재시도 쿼리가 orders 를 JOIN 하는 탓에 영영 선택되지 않는 pending 이 쌓인다.
// 대기 건수가 '아직 시트에 안 올라간 주문 수'를 더 이상 뜻하지 못하게 된다.
// (2026-08-11 확인: 고아 6건, 그중 2건이 pending 으로 영구 잔류)
// 출고 큐(sheet_shipping_sync_jobs)는 CASCADE 가 붙어 있어 고아가 0건이다. 등록 큐를 거기에 맞춘다.
export const SHEET_SYNC_FK_PROBE_SQL = `SELECT 1 AS present
   FROM pg_constraint c
   JOIN pg_class t ON t.oid = c.conrelid
   JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE c.contype = 'f' AND n.nspname = 'public' AND t.relname = 'sheet_sync_jobs'`;

// 외래키를 붙이려면 기존 고아부터 지워야 한다. 참조 대상 주문이 이미 없는 행이라
// 시트에 올릴 내용도 없다.
export const SHEET_SYNC_ORPHAN_CLEANUP_SQL = 'DELETE FROM sheet_sync_jobs j WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = j.order_id)';

// NOT VALID 로 붙인다. 기존 행을 검사하지 않으므로 정리 직후 다른 요청이 주문을 지워
// 새 고아가 생겨도 ADD CONSTRAINT 가 실패하지 않는다. 앞으로의 삭제에는 CASCADE 가 그대로 걸린다.
export const SHEET_SYNC_FK_SQL = 'ALTER TABLE sheet_sync_jobs ADD CONSTRAINT sheet_sync_jobs_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE NOT VALID';

let schemaReady = false;

export async function ensureSheetSyncSchema(db) {
  if (schemaReady) return;

  await db.execute({ sql: SHEET_SYNC_SCHEMA_SQL, args: [] });

  for (const sql of SHEET_SYNC_COLUMN_BACKFILL_SQL) {
    await db.execute({ sql, args: [] });
  }

  const probe = await db.execute({ sql: SHEET_SYNC_LEGACY_ACTION_PROBE_SQL, args: [] });
  if (probe?.rows?.length) {
    await db.execute({ sql: SHEET_SYNC_LEGACY_ACTION_DEFAULT_SQL, args: [] });
  }

  // 외래키는 청소 목적이라 주문 등록을 막을 만한 가치가 없다. 여기서 던지면
  // ensureSheetSyncSchema 를 부르는 등록 경로가 통째로 죽는다(2026-08-04 장애와 같은 길).
  // 실패하면 조용히 넘기고 다음 콜드 스타트에서 다시 시도한다.
  try {
    const fkProbe = await db.execute({ sql: SHEET_SYNC_FK_PROBE_SQL, args: [] });
    if (!fkProbe?.rows?.length) {
      await db.execute({ sql: SHEET_SYNC_ORPHAN_CLEANUP_SQL, args: [] });
      await db.execute({ sql: SHEET_SYNC_FK_SQL, args: [] });
    }
  } catch {
    // 무시
  }

  schemaReady = true;
}
