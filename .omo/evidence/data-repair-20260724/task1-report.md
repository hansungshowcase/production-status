# Task 1 report — orders GET schema-read-only

Worktree: `C:\Users\user\production-status-ocr-accuracy-20260724`

Branch: `fix/data-repair-20260724`

Commit: `a5efc0c` (`주문 GET 스키마 읽기 전용 유지`)

## RED

- Scenario: the regression suite describes the intended GET boundary and migration ownership.
- Invocation: `node --test tests/orders-get-schema-init.test.mjs`
- Binary observable: exit code `1`; both tests failed for the expected pre-fix behavior. `handleGet` still contained `ensureOrderImageColumn`, and migration source did not contain the optional-column ALTER statements (the first missing assertion was `delivery_address`).
- Captured artifact: this report, `task1-report.md`, RED section.

## GREEN and regression checks

- Scenario: targeted GET schema test plus existing order-registration regression tests.
- Invocation: `node --test tests/orders-get-schema-init.test.mjs tests/order-registration-payload.test.mjs`
- Binary observable: exit code `0`; `20` tests passed, `0` failed.
- Captured artifact: this report, GREEN section.

- Scenario: complete project test suite.
- Invocation: `npm.cmd test`
- Binary observable: exit code `0`; `200` tests passed, `0` failed.
- Captured artifact: this report, full-suite section.

- Scenario: production build.
- Invocation: `npm.cmd run build`
- Binary observable: exit code `0`; Vite reported `184 modules transformed` and `✓ built in 1.65s`.
- Captured artifact: this report, build section.

- Scenario: whitespace/error check for the committed patch.
- Invocation: `git diff --check` (also run as `git diff --cached --check` before commit).
- Binary observable: exit code `0`; no diff-check errors. Git emitted only existing LF/CRLF normalization warnings.
- Captured artifact: this report, diff-check section.

## Manual source-level QA

- Scenario: confirm runtime schema initialization is absent from GET, retained for POST, and migration owns every optional column.
- Invocation: Node source assertion over `api/orders/index.js` and `scripts/migrate.js`.
- Binary observable: exit code `0`, with the following result:

```json
{
  "getFound": true,
  "postFound": true,
  "getInvokesSchema": false,
  "postInvokesSchema": true,
  "migrationColumns": {
    "work_order_image_url": true,
    "delivery_address": true,
    "sale_amount": true,
    "balance": true,
    "freight_payment": true
  }
}
```

- Scenario: compare migration column types with the existing runtime helper.
- Invocation: Node source assertion comparing `scripts/migrate.js` with `api/_lib/ensureSchema.js`.
- Binary observable: exit code `0`; all five columns matched exactly: `work_order_image_url TEXT`, `delivery_address TEXT`, `sale_amount DOUBLE PRECISION`, `balance DOUBLE PRECISION`, and `freight_payment TEXT`.
- Captured artifact: this report, manual source-level QA section.

## Changed paths

- `api/orders/index.js`: removed only the `ensureOrderImageColumn(db)` call from `handleGet`; POST retains its write-path call.
- `scripts/migrate.js`: added idempotent ALTER statements for all five optional order columns using the helper's types.
- `tests/orders-get-schema-init.test.mjs`: added source regression tests for the GET boundary and migration ownership.

Only those three paths were staged and committed. Existing untracked `.omo/evidence` paths were preserved.

## Self-review

- The GET handler still reads the same columns and query logic; only runtime DDL was removed.
- POST's schema helper call remains immediately before the write transaction.
- Migration statements are idempotent (`ADD COLUMN IF NOT EXISTS`) and do not alter data rows.
- The added tests fail against the original source and pass after the minimal patch.
- No unrelated source, configuration, or dependency files were changed.

## Review-blocker fix - behavioral regression proof (2026-07-24)

This append supersedes the earlier source-token test evidence. The production behavior from `a5efc0c` remains intact; the only production changes below are explicit test seams that preserve the default Vercel and migration CLI paths.

### RED

- Scenario: execute the replacement GET, POST, and migration behavior tests before adding the required seams.
- Invocation: `node --test tests/orders-get-schema-init.test.mjs`
- Binary observable: exit code `1`; `0` passed and `3` failed for the intended deficiencies. GET and POST had no injectable handler exports, and importing `scripts/migrate.js` executed the live migration entry point instead of exposing an import-safe runner.
- Captured artifact: `.omo/evidence/data-repair-20260724/task1-tests-red.txt`

### GREEN behavior proof

- Scenario: execute GET with a fake DB, stop POST at the write transaction after recording DB calls, and execute the real migration loop against a fake query boundary.
- Invocation: `node --test tests/orders-get-schema-init.test.mjs`
- Binary observable: exit code `0`; `3` passed and `0` failed.
  - GET returned `{ orders: [], total: 0 }`, issued exactly two `SELECT` statements, and issued no schema DDL.
  - POST issued the five optional-column `ALTER TABLE` statements through the real schema preparation helper before `transaction('write')`.
  - The migration runner called its query boundary once for each exact statement: `work_order_image_url TEXT`, `delivery_address TEXT`, `sale_amount DOUBLE PRECISION`, `balance DOUBLE PRECISION`, and `freight_payment TEXT`.
- Captured artifact: `.omo/evidence/data-repair-20260724/task1-tests-green.txt`

### Required regression and build gates

- Scenario: preserve existing order-registration behavior.
- Invocation: `node --test tests/order-registration-payload.test.mjs`
- Binary observable: exit code `0`; `18` passed and `0` failed.
- Captured artifact: `.omo/evidence/data-repair-20260724/task1-registration-regression.txt`

- Scenario: run the complete project regression suite.
- Invocation: `npm.cmd test`
- Binary observable: exit code `0`; `201` passed and `0` failed.
- Captured artifact: `.omo/evidence/data-repair-20260724/task1-full-tests.txt`

- Scenario: compile the production application.
- Invocation: `npm.cmd run build`
- Binary observable: exit code `0`; Vite transformed `184` modules and completed the production build.
- Captured artifact: `.omo/evidence/data-repair-20260724/task1-build.txt`

- Scenario: reject whitespace errors in the scoped patch.
- Invocation: `git diff --check`
- Binary observable: exit code `0`; no diff-check errors. Git reported only LF/CRLF normalization warnings.
- Captured artifact: `.omo/evidence/data-repair-20260724/task1-diff-check.txt`

### Minimal seams and scope

- `api/orders/index.js`: exports `handleGet` and `handlePost` and accepts an optional injected DB. Calls from the default Vercel handler still omit that argument; POST still resolves the real DB only after validation.
- `scripts/migrate.js`: exports `runMigrationStatements` and guards the CLI entry point with a direct-execution check. `npm run db:migrate` still creates the Neon client and executes the same statement sequence.
- `tests/orders-get-schema-init.test.mjs`: replaces source scanning with DB-boundary behavior assertions.
- No database, production deployment, dependency, or unrelated application file was changed.
