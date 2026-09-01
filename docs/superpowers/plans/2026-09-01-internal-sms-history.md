# Internal SMS History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a public, masked history screen for internal production SMS messages, including recipient, Solapi request status, timestamp, subject, and exact sent body.

**Architecture:** Extend the existing append-only `notification_log` with three nullable snapshot columns and populate them only from the internal production SMS path. Expose a bounded, no-store public GET endpoint that selects only `internal_` milestones, then render it through a lazy-loaded React route linked directly below the two home role cards.

**Tech Stack:** Node.js Vercel functions, Neon PostgreSQL, React 18, React Router, Vite, plain CSS, Node test runner.

## Global Constraints

- No login or authentication is required for `/sms-history` or `/api/internal-notifications`.
- Never expose a full phone number; return only the already-masked `notification_log.to_phone` value.
- Query only internal production milestones beginning with `internal_`; customer and sales-risk messages are out of scope.
- Existing recipients, schedules, weekday rules, deduplication, shipping behavior, and sales SMS behavior remain unchanged.
- Existing log rows are not rewritten; missing snapshots display `내용 저장 전 기록`.
- No real Solapi request is allowed during tests or QA.
- Use the existing `DESIGN.md` white/light-blue operations surface and shared CSS tokens; do not add dependencies.
- Use inline SVG for the new message icon and preserve semantic buttons, focus states, 44px minimum touch targets, reduced-motion behavior, and Korean readability.

---

### Task 1: Persist Internal SMS Snapshots

**Files:**
- Modify: `api/_lib/notifySchema.js`
- Modify: `api/_lib/notify.js`
- Modify: `api/_lib/internalProductionAlerts.js`
- Modify: `tests/internal-production-alerts.test.mjs`
- Create: `tests/internal-notification-history.test.mjs`

**Interfaces:**
- Consumes: existing `sendAdminLms(db, message)` and `sendInternalAlertGroup(db, group, options)`.
- Produces: `sendAdminLms(db, { to, subject, text, tag, recipientName })`, with an append-only log row containing `recipient_name`, `message_subject`, and `message_text`.

- [ ] **Step 1: Write failing persistence tests**

Add a fake DB that records SQL and call the administrator LMS path with Solapi credentials removed:

```js
test('내부 LMS 로그는 수신자명·제목·발송 본문을 스냅샷으로 저장한다', async () => {
  const { sendAdminLms } = await import(`../api/_lib/notify.js?history=${Math.random()}`);
  const db = makeNotificationDb();
  const result = await sendAdminLms(db, {
    to: '010-9606-0873',
    recipientName: '강종효',
    subject: '[한성쇼케이스 포장 완료 점검]',
    text: '강종효님, 포장 완료까지 확인해 주세요.',
    tag: 'internal_assembly_daily',
  });

  assert.equal(result.dryRun, true);
  const insert = db.calls.find(call => call.sql.startsWith('INSERT INTO notification_log'));
  assert.match(insert.sql, /recipient_name, message_subject, message_text/);
  assert.deepEqual(insert.args.slice(-3), [
    '강종효',
    '[한성쇼케이스 포장 완료 점검]',
    '강종효님, 포장 완료까지 확인해 주세요.',
  ]);
});
```

Extend the existing internal group test to require `recipientName` in the injected `sendLms` payload.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
node --test tests/internal-notification-history.test.mjs tests/internal-production-alerts.test.mjs
```

Expected: FAIL because the three columns and `recipientName` logging are absent.

- [ ] **Step 3: Add additive schema columns**

After the existing `CREATE TABLE IF NOT EXISTS notification_log`, add:

```js
for (const sql of [
  'ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS recipient_name TEXT',
  'ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS message_subject TEXT',
  'ALTER TABLE notification_log ADD COLUMN IF NOT EXISTS message_text TEXT',
]) {
  await db.execute({ sql, args: [] });
}
```

- [ ] **Step 4: Store the snapshot without changing send behavior**

Change the administrator log insert to:

```js
export async function sendAdminLms(db, {
  to,
  subject,
  text,
  tag = 'admin_daily',
  recipientName = null,
}) {
  // existing Solapi send logic remains unchanged
  const isInternalHistory = String(tag || '').startsWith('internal_');
  await db.execute({
    sql: `INSERT INTO notification_log (
            order_id, milestone, channel, to_phone, status,
            provider_msgid, error, attempt,
            recipient_name, message_subject, message_text
          ) VALUES (NULL, ?, 'lms', ?, ?, ?, ?, 1, ?, ?, ?)`,
    args: [
      tag,
      maskPhone(phone),
      status,
      result.msgId || null,
      result.error ? String(result.error).slice(0, 500) : null,
      isInternalHistory ? recipientName : null,
      isInternalHistory ? String(subject || '').slice(0, 200) : null,
      isInternalHistory ? String(text || '').slice(0, 5000) : null,
    ],
  });
}
```

Pass `recipientName: group.recipientName` from `sendInternalAlertGroup`. Do not change existing sales or customer call sites, and assert that a non-`internal_` administrator tag still stores `null` in all three snapshot columns.

- [ ] **Step 5: Run persistence tests and verify GREEN**

Run the same focused command. Expected: all tests pass and no fetch reaches the Solapi endpoint.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- api/_lib/notifySchema.js api/_lib/notify.js api/_lib/internalProductionAlerts.js tests/internal-production-alerts.test.mjs tests/internal-notification-history.test.mjs
git commit -m "내부 문자 발송내용 로그 저장"
```

---

### Task 2: Expose a Bounded Public Internal-History API

**Files:**
- Create: `api/_lib/internalNotificationHistory.js`
- Create: `api/internal-notifications.js`
- Modify: `tests/internal-notification-history.test.mjs`

**Interfaces:**
- Consumes: `notification_log` snapshot columns from Task 1.
- Produces: `handleInternalNotifications(req, res, dependencies)` and GET `/api/internal-notifications?audience=all|executive|member&limit=50` returning `{ items, counts }`.

- [ ] **Step 1: Write failing API tests**

Use a fake DB with internal, sales-risk, and customer rows. Verify no Authorization header is needed, non-internal rows never appear, filtering works, and response fields are allowlisted:

```js
test('공개 발송내역 API는 인증 없이 내부 문자만 마스킹해 반환한다', async () => {
  const { handleInternalNotifications } = await import('../api/internal-notifications.js');
  const res = mockResponse();
  await handleInternalNotifications(
    { method: 'GET', headers: {}, query: { audience: 'all', limit: '50' } },
    res,
    { db: makeHistoryDb(), rateLimitCheck: () => true, ensureSchema: async () => {} },
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items.map(item => item.milestone), [
    'internal_assembly_daily',
    'internal_design_due',
  ]);
  assert.equal(res.body.items[0].phone, '010****0873');
  assert.equal('error' in res.body.items[0], false);
  assert.equal('provider_msgid' in res.body.items[0], false);
});
```

Add cases for `audience=member`, `audience=executive`, invalid audience `400`, non-GET `405`, limit clamped to `100`, and null body fallback.

- [ ] **Step 2: Run the API tests and verify RED**

Run:

```powershell
node --test tests/internal-notification-history.test.mjs
```

Expected: FAIL with missing modules/handler.

- [ ] **Step 3: Implement the pure serializer**

Create `internalNotificationHistory.js` with exact mappings:

```js
const EXECUTIVE_NAMES = {
  internal_vcut_completed: '이시아 부장',
  internal_design_due: '김보수 팀장',
  internal_laser_due: '이정섭 부장',
  internal_welding_due: '최우석 이사',
  internal_assembly_due: '박상규 공장장',
  internal_packing_due: '정영호 팀장',
};

const MEMBER_NAMES_BY_MASKED_PHONE = {
  '010****0873': '강종효',
  '010****2576': '카우사르',
  '010****9396': '나타왓',
  '010****8947': '마카라',
  '010****4464': '백승정',
  '010****4537': '까지',
};

export function audienceForMilestone(milestone) {
  return milestone === 'internal_assembly_daily' ? 'member' : 'executive';
}

export function serializeInternalNotification(row) {
  const audience = audienceForMilestone(row.milestone);
  return {
    id: Number(row.id),
    milestone: row.milestone,
    audience,
    recipient_name: row.recipient_name
      || EXECUTIVE_NAMES[row.milestone]
      || MEMBER_NAMES_BY_MASKED_PHONE[row.to_phone]
      || '팀원',
    phone: row.to_phone || '',
    status: ['success', 'failed', 'dry_run'].includes(row.status) ? row.status : 'failed',
    subject: row.message_subject || '',
    text: row.message_text || null,
    sent_at: row.created_at,
  };
}

export function summarizeInternalNotifications(items = []) {
  return {
    total: items.length,
    success: items.filter(item => item.status === 'success').length,
    failed: items.filter(item => item.status === 'failed').length,
    dry_run: items.filter(item => item.status === 'dry_run').length,
  };
}
```

- [ ] **Step 4: Implement the public handler**

The handler must set `Cache-Control: no-store`, apply rate limiting, validate `audience`, clamp `limit`, call `ensureNotifySchema`, and issue a controlled SQL query:

```js
export async function handleInternalNotifications(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;

  const audience = req.query?.audience || 'all';
  if (!['all', 'executive', 'member'].includes(audience)) {
    return res.status(400).json({ error: { message: '올바른 조회 구분이 아닙니다.', status: 400 } });
  }
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query?.limit, 10) || 50));
  const db = dependencies.db || getDb();
  await (dependencies.ensureSchema || ensureNotifySchema)(db);

  const filters = ["LEFT(milestone, 9) = 'internal_'"];
  if (audience === 'member') filters.push("milestone = 'internal_assembly_daily'");
  if (audience === 'executive') filters.push("milestone <> 'internal_assembly_daily'");
  const { rows } = await db.execute({
    sql: `SELECT id, milestone, to_phone, status, recipient_name,
                 message_subject, message_text, created_at
            FROM notification_log
           WHERE ${filters.join(' AND ')}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
    args: [limit],
  });
  const items = rows.map(serializeInternalNotification);
  return res.json({ items, counts: summarizeInternalNotifications(items) });
}
```

- [ ] **Step 5: Run API and security contract tests**

Run:

```powershell
node --test tests/internal-notification-history.test.mjs tests/security-auth.test.mjs
```

Expected: PASS; existing authenticated APIs still call `requireAuth`, while this explicitly public endpoint does not import it.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- api/_lib/internalNotificationHistory.js api/internal-notifications.js tests/internal-notification-history.test.mjs
git commit -m "내부 문자 발송내역 공개 조회 추가"
```

---

### Task 3: Add the Home Entry and SMS History Screen

**Files:**
- Modify: `DESIGN.md`
- Modify: `src/App.jsx`
- Modify: `src/pages/HomePage.jsx`
- Modify: `src/pages/HomePage.css`
- Create: `src/api/internalNotifications.js`
- Create: `src/pages/SmsHistoryPage.jsx`
- Create: `src/pages/SmsHistoryPage.css`
- Create: `tests/sms-history-ui.test.mjs`
- Modify: `tests/home-page-redesign.test.mjs`

**Interfaces:**
- Consumes: GET `/api/internal-notifications?audience=all&limit=100`.
- Produces: lazy route `/sms-history`, home button `문자 발송내역 확인하기`, and accessible filter/expand interactions.

- [ ] **Step 1: Write failing UI contract tests**

Create source-level regression checks for route wiring, exact copy, no auth dependency, semantic expansion, and responsive CSS:

```js
test('홈 역할 카드 아래 공개 문자 발송내역 진입 버튼이 있다', () => {
  assert.match(homeSource, /navigate\('\/sms-history'\)/);
  assert.match(homeSource, /문자 발송내역 확인하기/);
  assert.match(homeCss, /\.home-sms-history-link/);
});

test('문자 발송내역 화면은 간부·팀원 필터와 본문 펼침을 제공한다', () => {
  assert.match(pageSource, /전체/);
  assert.match(pageSource, /간부/);
  assert.match(pageSource, /팀원/);
  assert.match(pageSource, /aria-expanded=/);
  assert.match(pageSource, /내용 저장 전 기록/);
  assert.doesNotMatch(pageSource, /authClient|SalesLoginPage|requireAuth/);
});
```

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```powershell
node --test tests/sms-history-ui.test.mjs tests/home-page-redesign.test.mjs
```

Expected: FAIL because the route, page, button, and styles do not exist.

- [ ] **Step 3: Extend the design-system contract first**

Add these Section 5 primitives to `DESIGN.md` before component code:

```markdown
### Home Secondary Action
- Full-width compact action below role cards; surface background, default border, primary-blue focus ring.
- States: default, hover lift, active press, keyboard focus.

### Notification History Controls
- Three-button segmented filter with selected state using `--blue` and `--blue-light`.
- Summary cells use the shared H2/body/caption scale and success/error tokens.

### Notification History Item
- One surface row with recipient/status metadata and a single disclosure button.
- States: collapsed, expanded, legacy-content fallback, failed, dry-run.
```

- [ ] **Step 4: Add API client and route**

Create:

```js
import request from './client';

export function fetchInternalNotifications({ limit = 100 } = {}) {
  return request(`/internal-notifications?audience=all&limit=${limit}`, { cache: 'no-store' });
}
```

Lazy-load `SmsHistoryPage` in `App.jsx` and register `<Route path="/sms-history" element={<SmsHistoryPage />} />`.

- [ ] **Step 5: Add the home secondary action**

Insert it directly after `.home-cards--row`. Use an inline message SVG, exact Korean label, right arrow, and `navigate('/sms-history')`. Style it with existing variables only, minimum height `56px`, `max-width: 1280px`, visible `:focus-visible`, transform-only hover/press motion, and a mobile minimum touch target of `48px`.

- [ ] **Step 6: Build the history page**

The page state is:

```js
const [items, setItems] = useState([]);
const [status, setStatus] = useState('loading');
const [audience, setAudience] = useState('all');
const [expandedId, setExpandedId] = useState(null);
```

Fetch once on mount and retry on demand. Filter client-side:

```js
const filteredItems = useMemo(
  () => audience === 'all' ? items : items.filter(item => item.audience === audience),
  [items, audience],
);
```

Render semantic `header`, `main`, a three-button `aria-label="수신자 구분"` filter, summary cells, and an `article` per log. Disclosure buttons must use `aria-expanded` and `aria-controls`. Format `sent_at` with `Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', ... })`. Show `내용 저장 전 기록` when `text` is null.

- [ ] **Step 7: Style responsive states using declared tokens**

Use a centered content width up to `1000px`, 4px-based spacing, existing type scale, surface/border/shadow tokens, and a one-column list at every breakpoint. At `375px`, metadata wraps without horizontal scrolling; at `768px+`, summary uses three columns and recipient/status metadata share one line. Add `prefers-reduced-motion: reduce` overrides for transforms/transitions.

- [ ] **Step 8: Run UI tests and build**

Run:

```powershell
node --test tests/sms-history-ui.test.mjs tests/home-page-redesign.test.mjs
npm.cmd run build
```

Expected: UI tests pass; Vite build exits `0`; `SmsHistoryPage` is emitted as a lazy route chunk.

- [ ] **Step 9: Commit Task 3**

```powershell
git add -- DESIGN.md src/App.jsx src/pages/HomePage.jsx src/pages/HomePage.css src/api/internalNotifications.js src/pages/SmsHistoryPage.jsx src/pages/SmsHistoryPage.css tests/sms-history-ui.test.mjs tests/home-page-redesign.test.mjs
git commit -m "문자 발송내역 확인 화면 추가"
```

---

### Task 4: Regression, Real-Surface QA, and Production Deployment

**Files:**
- Verify only; repair the smallest responsible source if checks reveal a defect.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: passing regression/build evidence, browser artifacts at required widths, and a verified production deployment.

- [ ] **Step 1: Run focused backend and UI tests**

```powershell
node --test tests/internal-notification-history.test.mjs tests/internal-production-alerts.test.mjs tests/internal-production-process-hooks.test.mjs tests/home-page-redesign.test.mjs tests/sms-history-ui.test.mjs tests/security-auth.test.mjs
```

Expected: zero failures and no external Solapi request.

- [ ] **Step 2: Run full regression and production build**

```powershell
npm.cmd test
npm.cmd run build
```

Expected: all tests pass and build exits `0`.

- [ ] **Step 3: Run static React diagnostics without adding project dependencies**

```powershell
npx.cmd --yes react-doctor@latest . --json
```

Review only findings attributable to the changed files; do not refactor unrelated legacy UI.

- [ ] **Step 4: Run visual QA on the actual surface**

Use `/visual-qa` against the production build at `375px`, `768px`, and `1280px`.

Verify:

- the home action is directly under the two role cards;
- `/sms-history` opens without authentication;
- loading, empty/error, populated, filter-selected, keyboard-focus, collapsed, and expanded states are readable;
- no horizontal overflow, clipped Korean, invisible focus, or color-only meaning exists;
- the public response never contains a full phone number, customer text, or sales-risk text.

- [ ] **Step 5: Verify source provenance and push main**

Confirm a clean tracked worktree, `origin/main` ancestry, the exact Vercel project `production-status` (`prj_7URD4gLkA3qkeCne2xTwUDm9SMx1`), then fast-forward push the verified commit to `main`.

- [ ] **Step 6: Verify production without sending SMS**

After Vercel reports success:

```powershell
$verifiedCommit = git rev-parse --short HEAD
curl.exe -sS -D - -o NUL -H "Cache-Control: no-cache" "https://production-status.vercel.app/sms-history?cb=$verifiedCommit"
curl.exe -sS -D - -o NUL -H "Cache-Control: no-cache" "https://production-status.vercel.app/api/internal-notifications?limit=1&cb=$verifiedCommit"
```

Expected: both return `200`, the page references the current build assets, API cache is `no-store`, and the API payload contains only internal masked history fields. Do not call any cron or process mutation endpoint.

- [ ] **Step 7: Final report**

Report the implementation commits, deployment ID and alias, current JS/CSS assets, test/build counts, visual QA widths/states, public-access decision, masked-phone guarantee, and the fact that no test SMS was sent.
