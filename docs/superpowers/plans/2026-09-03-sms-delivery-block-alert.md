# SMS Delivery Block Alert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Solapi 최종 전송결과에서 직원 문자 수신거부·차단을 감지해 관리자 `010-7731-4237`로 하루 한 번 알린다.

**Architecture:** 인증된 Vercel Cron이 5분마다 최근 내부 문자 로그의 Solapi 메시지 ID를 묶어 조회한다. 최종 상태를 기존 로그에 저장하고, 차단 상태는 별도 원자적 선점 테이블로 중복을 막은 뒤 기존 `sendAdminLms` 경로로 관리자에게 알린다. 재시도 전에는 Solapi `customFields`의 날짜별 중복방지 토큰을 조회해 이전 요청의 응답만 유실된 경우 관리자 문자를 다시 보내지 않는다.

**Tech Stack:** Node.js ESM, Vercel Functions/Cron, Neon PostgreSQL, Solapi Messages v4 REST API, `node:test`.

## Global Constraints

- 감시 대상은 `internal_*`와 `chonbe_alert`만 포함한다.
- 차단 코드는 `1061`, `2061`, `3061`, `3047`, `3054`, `3055`이다.
- 같은 수신자·상태 코드·KST 날짜에는 관리자 문자를 한 번만 보낸다.
- 관리자 알림, 고객 알림, 기존 발송 조건과 수신자는 변경하지 않는다.
- 주말에는 관리자 알림을 보내지 않는다.
- 휴대전화 자체 차단은 감지 가능하다고 표시하지 않는다.

---

### Task 1: 전송결과 저장·중복방지 스키마

**Files:**
- Modify: `api/_lib/notifySchema.js`
- Test: `tests/sms-delivery-monitor.test.mjs`

**Interfaces:**
- Produces: `ensureSmsDeliveryMonitorSchema(db): Promise<void>`
- Produces columns: `delivery_status`, `delivery_status_code`, `delivery_reason`, `delivery_reported_at`, `delivery_received_at`
- Produces table: `notification_delivery_alerts`

- [ ] **Step 1: Write the failing schema test**

테스트 DB 스텁이 실행 SQL을 모은 뒤 다섯 컬럼과 `notification_delivery_alerts` 생성문을 모두 포함하는지 단언한다.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/sms-delivery-monitor.test.mjs`
Expected: `ensureSmsDeliveryMonitorSchema` export가 없어 실패한다.

- [ ] **Step 3: Write minimal schema implementation**

`ensureInternalNotificationHistorySchema(db)`를 먼저 호출하고 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`와 `CREATE TABLE IF NOT EXISTS notification_delivery_alerts`를 실행한다. 기존 `schemaFlags`로 같은 인스턴스의 반복 보정을 막는다.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/sms-delivery-monitor.test.mjs`
Expected: schema test PASS.

### Task 2: Solapi 결과 판정과 관리자 알림

**Files:**
- Create: `api/_lib/solapiDeliveryMonitor.js`
- Modify: `tests/sms-delivery-monitor.test.mjs`

**Interfaces:**
- Produces: `BLOCK_STATUS_CODES: ReadonlySet<string>`
- Produces: `fetchSolapiDeliveryReports(messageIds, options): Promise<object[]>`
- Produces: `runSmsDeliveryMonitor(db, options): Promise<{scanned, reported, received, blocked, alerted, failed}>`

- [ ] **Step 1: Write failing behavior tests**

다음 사례를 추가한다: `4000`은 상태만 저장, `3061`은 관리자에게 전송, 같은 수신자·코드·날짜의 두 메시지는 한 번만 전송, 관리자 발송 실패는 다음 실행에서 재시도, 감시 대상 외 마일스톤은 조회하지 않음.

- [ ] **Step 2: Run tests to verify expected failures**

Run: `node --test tests/sms-delivery-monitor.test.mjs`
Expected: 모듈 또는 export 부재로 각 새 동작 테스트가 실패한다.

- [ ] **Step 3: Implement Solapi report query**

기존 Solapi HMAC-SHA256 방식으로 `/messages/v4/list`를 최대 50개 ID씩 조회한다. 응답에서는 `messageId`, `status`, `statusCode`, `reason`, `dateReported`, `dateReceived`만 사용하고 수신번호·본문은 저장하거나 로그로 출력하지 않는다.

- [ ] **Step 4: Implement monitor and deduplication**

KST `2026-09-03` 이후의 대상 로그 중 미확정·처리중 상태와 아직 끝나지 않은 관리자 알림 큐를 조회한다. `sent` 처리된 최종 차단 행은 이후 조회에서 제외한다. 마지막 확인 시각이 오래된 순서로 순환 처리해 반복 실패 건이 다른 대기 건을 막지 않게 한다. 결과를 로그에 갱신하고 `KST날짜:수신자명:마스킹번호:상태코드` 키를 `notification_delivery_alerts`에 원자적으로 선점한다. 성공한 선점만 관리자 문자로 보내며 성공은 `sent`, 실패는 `failed`, 실행 한도 초과는 `queued`로 기록해 다음 실행에서 재시도할 수 있게 한다. 관리자 문자에는 선점 키의 해시를 `customFields.deliveryAlertKey`로 포함하고, 재시도 전에 당일 관리자 발송 내역의 같은 토큰을 조회한다. 30초 함수 제한을 넘지 않도록 한 실행에서 최대 20건을 조회하고 관리자 알림 처리는 최대 2건으로 제한한다.

- [ ] **Step 5: Run targeted tests**

Run: `node --test tests/sms-delivery-monitor.test.mjs`
Expected: all tests PASS.

### Task 3: 인증 Cron과 배포 설정

**Files:**
- Create: `api/cron/sms-delivery-monitor.js`
- Modify: `vercel.json`
- Modify: `tests/sms-delivery-monitor.test.mjs`

**Interfaces:**
- Produces: `handleSmsDeliveryMonitor(req, res, dependencies): Promise<Response>`
- Consumes: `runSmsDeliveryMonitor(db, options)`

- [ ] **Step 1: Write failing handler and schedule tests**

인증 없는 요청은 `401`이고 모니터를 호출하지 않으며, 올바른 Bearer 비밀값은 결과를 반환하고, 주말에는 모니터를 호출하지 않는지 단언한다. `vercel.json`에 `{ "path": "/api/cron/sms-delivery-monitor", "schedule": "*/5 * * * *" }`가 정확히 한 번 있는지도 단언한다.

- [ ] **Step 2: Run tests to verify expected failures**

Run: `node --test tests/sms-delivery-monitor.test.mjs`
Expected: cron handler와 schedule이 없어 실패한다.

- [ ] **Step 3: Implement authenticated cron**

GET만 허용하고 `CRON_SECRET` Bearer 값을 상수시간 비교한다. KST 주말이면 `skipped: "weekend"`를 반환하고, 평일이면 DB와 모니터를 호출한다. 상세 수신자 정보는 응답에 포함하지 않는다.

- [ ] **Step 4: Add five-minute schedule and run tests**

Run: `node --test tests/sms-delivery-monitor.test.mjs tests/internal-production-alerts.test.mjs`
Expected: all tests PASS.

### Task 4: 통합 검증과 운영 반영

**Files:**
- Verify all changed files

- [ ] **Step 1: Run focused and project checks**

Run: `node --test tests/sms-delivery-monitor.test.mjs tests/internal-production-alerts.test.mjs tests/internal-notification-history.test.mjs`
Expected: 0 failures.

Run: `npm run build`
Expected: exit code 0.

- [ ] **Step 2: Commit only requested implementation**

Stage the monitor module, cron, schema, tests, and `vercel.json`. Commit with the repository's Korean subject style.

- [ ] **Step 3: Push and verify production**

Confirm `HEAD^` matches `origin/main`, push `HEAD:main`, wait for Vercel `READY`, and confirm deployment Git SHA equals the pushed commit and the production alias points to it.

- [ ] **Step 4: Verify first scheduled execution**

After the next five-minute boundary, query `notification_log.delivery_status_code` and Vercel logs read-only. Confirm the Cron executed without error and at least the eligible recent messages received a final status; report any real block alert instead of sending a synthetic employee alert.
