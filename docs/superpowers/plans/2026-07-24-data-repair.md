# Data Integrity Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove schema writes from the orders GET path and safely repair only the six deterministic legacy sales-person aliases.

**Architecture:** Schema ownership moves to the explicit migration script, so read requests never run DDL. A one-time repair script uses a bounded ID/value manifest, a transaction, compare-and-set predicates, and a rollback manifest; rows without deterministic source values remain unchanged for manual image review.

**Tech Stack:** Node.js ESM, Vercel serverless API, Neon/PostgreSQL, node:test.

## Global Constraints

- Work only in `production-status`; preserve existing OCR, registration, and image-order validation behavior.
- Never infer missing due dates or assignees from incomplete DB fields.
- Production DB repair is limited to IDs `203`–`208`, only when the stored legacy alias exactly matches the approved mapping to `이준형`.
- Verify project ID `prj_7URD4gLkA3qkeCne2xTwUDm9SMx1` and production-status DB before every production command.
- Run the migration before deployment; deploy only after the migration proves the required columns exist.

---

### Task 1: Make `GET /api/orders` schema-read-only

**Files:**
- Modify: `api/orders/index.js:8,74-77`
- Modify: `scripts/migrate.js:7-36,90-94`
- Test: `tests/orders-get-schema-init.test.mjs`

**Interfaces:**
- Consumes: `ensureOrderImageColumn(db)` for write paths only.
- Produces: `handleGet()` that runs no schema helper; `npm run db:migrate` that idempotently creates all five optional order columns.

- [ ] **Step 1: Write the failing regression test**

```js
test('orders GET does not invoke runtime schema initialization', () => {
  const source = readFileSync('api/orders/index.js', 'utf8');
  const getStart = source.indexOf('async function handleGet');
  const postStart = source.indexOf('async function handlePost');
  assert.equal(source.slice(getStart, postStart).includes('ensureOrderImageColumn'), false);
});

test('explicit migration owns every optional orders column', () => {
  const source = readFileSync('scripts/migrate.js', 'utf8');
  for (const column of ['work_order_image_url', 'delivery_address', 'sale_amount', 'balance', 'freight_payment']) {
    assert.match(source, new RegExp(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ${column}`));
  }
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test tests/orders-get-schema-init.test.mjs`

Expected: FAIL because `handleGet` invokes `ensureOrderImageColumn` and migration lacks required optional-column ownership.

- [ ] **Step 3: Implement the smallest change**

```js
// api/orders/index.js
async function handleGet(req, res) {
  const db = getDb();
  // Do not call ensureOrderImageColumn here.
}

// scripts/migrate.js migration statement list
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS work_order_image_url TEXT`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS sale_amount INTEGER`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance INTEGER`,
`ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_payment TEXT`,
```

- [ ] **Step 4: Run GREEN and regression checks**

Run: `node --test tests/orders-get-schema-init.test.mjs tests/order-registration-payload.test.mjs`

Expected: PASS; POST and image-order validation continue to invoke the helper before writes.

- [ ] **Step 5: Commit the isolated code/test unit**

```bash
git add api/orders/index.js scripts/migrate.js tests/orders-get-schema-init.test.mjs
git commit -m "Keep orders GET schema-read-only"
```

### Task 2: Add a bounded legacy alias repair tool

**Files:**
- Create: `scripts/repair-legacy-sales-person-aliases.js`
- Test: `tests/repair-legacy-sales-person-aliases.test.mjs`

**Interfaces:**
- Consumes: `POSTGRES_URL`, explicit `{ id, expectedSalesPerson, replacementSalesPerson }` manifest.
- Produces: a transactionally applied JSON rollback manifest containing preimage and affected IDs; exits before any mutation when an ID/value predicate does not match.

- [ ] **Step 1: Write failing tests for the bounded manifest and SQL guard**

```js
test('repair manifest is limited to IDs 203 through 208 and maps only the approved legacy alias', () => {
  assert.deepEqual(REPAIRS, [
    { id: 203, expectedSalesPerson: '김보수', replacementSalesPerson: '이준형' },
    // IDs 204 through 208 follow the same exact mapping.
  ]);
});

test('repair SQL compare-and-set requires the original value', () => {
  assert.match(buildRepairSql(), /WHERE id = \? AND sales_person = \?/);
});
```

- [ ] **Step 2: Run RED**

Run: `node --test tests/repair-legacy-sales-person-aliases.test.mjs`

Expected: FAIL because the repair tool and fixed manifest do not exist.

- [ ] **Step 3: Implement dry-run first, then transactional apply**

```js
const REPAIRS = Object.freeze([/* six exact IDs and aliases */]);

// default: SELECT preimage and print sanitized ID/count only
// --apply: BEGIN; run guarded UPDATE; require rowCount === 1 for every ID;
// write JSON rollback manifest with original values; COMMIT; otherwise ROLLBACK.
```

- [ ] **Step 4: Run GREEN and dry-run proof**

Run: `node --test tests/repair-legacy-sales-person-aliases.test.mjs`

Expected: PASS.

Run: `node --env-file=.env.local scripts/repair-legacy-sales-person-aliases.js --dry-run`

Expected: exactly six intended IDs; no SQL mutation.

- [ ] **Step 5: Commit the isolated code/test unit**

```bash
git add scripts/repair-legacy-sales-person-aliases.js tests/repair-legacy-sales-person-aliases.test.mjs
git commit -m "Add guarded legacy sales alias repair"
```

### Task 3: Apply production migration, repair approved aliases, deploy, and verify

**Files:**
- No source edits; use Task 1–2 outputs.

**Interfaces:**
- Consumes: committed migration and repair script.
- Produces: production schema prepared before deployment, six repaired rows, deployment verified from cache-busted production requests.

- [ ] **Step 1: Verify exact target before mutation**

Run: inspect `.vercel/repo.json`, local sanitized DB identity, and `vercel inspect` where authenticated.

Expected: project `production-status`, ID `prj_7URD4gLkA3qkeCne2xTwUDm9SMx1` only.

- [ ] **Step 2: Run explicit migration**

Run: `npm run db:migrate`

Expected: all optional-order columns exist; no data rows are changed.

- [ ] **Step 3: Run guarded six-row repair**

Run: `node --env-file=.env.local scripts/repair-legacy-sales-person-aliases.js --apply`

Expected: exactly six compare-and-set updates; a rollback manifest is emitted. Any mismatch rolls back every update.

- [ ] **Step 4: Deploy and cache-verify**

Run: production deploy command, then cache-busted `GET /api/orders?limit=1` only after Task 1 code is live.

Expected: deployment alias points to the new revision; GET is data-read-only by source and returns 200.

- [ ] **Step 5: Run full regression suite and final data checks**

Run: `npm test && npm run build`

Expected: all tests and build pass; a SELECT-only targeted check shows IDs 203–208 now use `이준형` and the remaining 24 historical rows stay untouched.

- [ ] **Step 6: Commit and push deployment-ready changes**

```bash
git add docs/superpowers/plans/2026-07-24-data-repair.md
git commit -m "Plan data integrity repair"
git push origin fix/data-repair-20260724
```
