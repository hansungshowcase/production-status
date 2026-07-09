# Delivery Adherence Rule Change Code Review

## Scope

- Project: `C:\Users\user\production-status`
- Reviewed files only:
  - `api/_lib/deliveryAdherence.js`
  - `api/delivery-adherence.js`
  - `tests/delivery-adherence.test.mjs`
- User requirement: missed if `due_date` passed and equipment work completed after due date; missed if `due_date` passed and no equipment completion/reached evidence; compliant if equipment completed on/before due date or not yet due. Denominator is production units with `due_date`; missing `due_date` excluded and counted separately.
- Diff evidence: the three files are untracked additions. Normal `git diff -- <files>` is empty; inspected full additions with `git diff --no-index -- NUL <file>`.
- External evidence/notepad input: none provided.

## Skill Perspective Check

- `superpowers:using-superpowers` loaded before review workflow.
- `omo:remove-ai-slops` consulted for production/test slop review. Violations found: brittle source-text tests and unused production helpers.
- `omo:programming` consulted for maintainability/test-quality perspective. Violations found: tests that mirror implementation/source constants instead of observable behavior, plus a missing edge test for the stated rule.

## Verification Run

- `node --test tests/delivery-adherence.test.mjs`: PASS, 5 tests, 0 failures.
- Ad hoc rule check:
  - Input: `{ quantity: 1, due_date: '2026-07-10', equipment_completed_at: '2026-07-11' }`, today `'2026-07-03'`.
  - Actual: `on_time_units: 0`, `missed_units: 1`.
  - Expected from stated rule: not yet due, so compliant.

## Findings

### CRITICAL

- None.

### HIGH

1. `api/_lib/deliveryAdherence.js:60` violates the "compliant if not yet due" branch when a future/not-yet-due row already has a reached date after its due date. The current condition only gives not-yet-due credit when `!reachedDate` is true:

   ```js
   (reachedDate && reachedDate <= dueDate) || (!reachedDate && dueDate >= today)
   ```

   That means a row with `due_date >= today` and `equipment_completed_at > due_date` is counted as missed even though the user requirement makes "not yet due" independently compliant. This is a direct rule mismatch and is not covered by the tests.

2. `tests/delivery-adherence.test.mjs:54` and `tests/delivery-adherence.test.mjs:64` are brittle source-inspection tests, not behavior tests. They assert that source files contain strings such as `calculateDeliveryAdherence`, SQL aliases, cache header text, JSX component usage, and Korean labels. These tests can pass while the API returns wrong adherence data, while cache behavior is not applied at runtime, or while the UI renders the values incorrectly. From the `remove-ai-slops` and `programming` perspectives, this is false-confidence coverage and scope drift.

### MEDIUM

1. `api/delivery-adherence.js:18` has no runtime/integration coverage proving that the SQL actually maps real `processes` rows into `equipment_completed_at` and `later_step_started_at` correctly. The current test only checks for alias text in the source at `tests/delivery-adherence.test.mjs:58`, so a broken join, grouping issue, or wrong status filter could survive.

### LOW

1. `api/_lib/deliveryAdherence.js:1` and `api/_lib/deliveryAdherence.js:16` define `SHIPPED_STATUSES` and `isShipped`, but `isShipped` is never used. This is dead production code and is also misleading because the requested rule is based on equipment completion/reached evidence, not shipped status.

2. `tests/delivery-adherence.test.mjs:11`, `tests/delivery-adherence.test.mjs:12`, and `tests/delivery-adherence.test.mjs:40` use fixture fields named `equipment_completed` and `later_step_started`, but production reads `equipment_completed_at` and `later_step_started_at`. The tests pass because those fields are ignored, but the fixture shape obscures which absence-of-evidence case is being tested.

## Key Rule Test Coverage

- Covered at unit level:
  - Equipment completed on due date is compliant.
  - Later-step reached evidence on due date is compliant.
  - Due date passed with no recognized reached evidence is missed.
  - Due date passed with equipment completion after due date is missed.
  - Not-yet-due with no reached evidence is compliant.
  - Missing `due_date` is excluded from `measurable_units` and counted in `missing_due_date_units`.
- Not covered:
  - Not-yet-due with a reached/completion date after the due date, which currently fails the stated rule.
  - Runtime API/SQL behavior against representative DB rows.

## Status

- `codeQualityStatus`: BLOCK
- `recommendation`: REQUEST_CHANGES
- `blockers`:
  - Fix `api/_lib/deliveryAdherence.js:60` so "not yet due" rows are compliant regardless of reached-date presence, unless the business rule is clarified differently.
  - Add a behavior test for the not-yet-due/reached-after-due edge case.
  - Replace or supplement source-inspection tests with observable API/UI behavior tests for the delivery-adherence surface.
