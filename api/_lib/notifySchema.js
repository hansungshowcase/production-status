// 알림 파이프라인용 스키마 지연 보장 — ensureSchema.js 와 동일 패턴
// (ALTER TABLE ... IF NOT EXISTS + 모듈레벨 Map 캐시, 같은 인스턴스에서 1회만 실행)
const schemaFlags = new Map();

export async function ensureNotifySchema(db) {
  if (schemaFlags.get('notify.schema')) return;

  // 고객 조회 토큰 (추측 불가, UNIQUE)
  await db.execute({
    sql: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token TEXT',
    args: [],
  });
  await db.execute({
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_track_token ON orders (track_token)',
    args: [],
  });

  // 마일스톤별 발송 상태 (멱등성 진실원천) — 기존 sms_sent 컬럼은 건드리지 않음
  await db.execute({
    sql: `ALTER TABLE orders ADD COLUMN IF NOT EXISTS notify_state JSONB DEFAULT '{}'::jsonb`,
    args: [],
  });

  // 발송 로그 (모든 시도 append — 감사/재시도 판단/정산 대조)
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS notification_log (
      id BIGSERIAL PRIMARY KEY,
      order_id INT,
      milestone TEXT NOT NULL,
      channel TEXT,
      to_phone TEXT,
      status TEXT NOT NULL,
      provider_msgid TEXT,
      error TEXT,
      attempt INT DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });

  for (const sql of [
    'ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS recipient_name TEXT',
    'ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS message_subject TEXT',
    'ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS message_text TEXT',
  ]) {
    await db.execute({ sql, args: [] });
  }

  schemaFlags.set('notify.schema', true);
}
