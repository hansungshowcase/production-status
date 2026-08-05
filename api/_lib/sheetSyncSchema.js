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

  schemaReady = true;
}
