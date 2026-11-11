import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  groupSource, groupStatusLabel, slimGroup, fetchSolapiGroupsDay, buildGroupRows, clearSolapiGroupCache,
} from '../api/_lib/solapiGroupLog.js';

const NOW = Date.parse('2026-11-11T06:10:00.000Z');
process.env.SOLAPI_API_KEY = 'k';
process.env.SOLAPI_API_SECRET = 's';

const rawGroup = (id, over = {}) => ({
  groupId: id, status: 'COMPLETE', accountId: 'ACC1', balance: 9999, deposit: 1234, point: 5,
  app: { appId: null, profit: 3 }, dateCreated: '2026-11-11T02:00:00.000Z',
  count: { total: 3, sentTotal: 3, sentSuccess: 2, sentFailed: 1, sentPending: 0, sentReplacement: 0, registeredFailed: 0, refund: 0 },
  log: [{ createAt: '2026-11-11T02:00:01.000Z', message: '첫 기록' }, { createAt: '2026-11-11T02:00:05.000Z', message: '마지막 기록' }],
  ...over,
});
const fakeFetch = pages => {
  const calls = [];
  const impl = async url => {
    calls.push(String(url));
    const body = pages[calls.length - 1] || pages.at(-1);
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
};

beforeEach(() => clearSolapiGroupCache());

test('groupSource 3값과 APP', () => {
  assert.equal(groupSource(null), 'API');
  assert.equal(groupSource('dJLDX22NaHBQ'), 'COMM');
  assert.equal(groupSource('JfpLPhLYJqGV'), 'AUTO');
  assert.equal(groupSource('zzz'), 'APP');
});

test('상태 이름', () => {
  assert.equal(groupStatusLabel('COMPLETE'), '처리완료');
  assert.equal(groupStatusLabel('SENDING'), '발송요청완료');
  assert.equal(groupStatusLabel('PENDING'), '접수대기');
  assert.equal(groupStatusLabel('SCHEDULED'), '예약대기');
  assert.equal(groupStatusLabel('FAILED'), '실패');
  assert.equal(groupStatusLabel('WEIRD'), 'WEIRD');
});

test('slimGroup 은 계정·잔액·예치금을 남기지 않고 마지막 log 만 남긴다', () => {
  const slim = slimGroup(rawGroup('G1'));
  const text = JSON.stringify(slim);
  assert.doesNotMatch(text, /accountId|ACC1|balance|deposit|point|profit/);
  assert.equal(slim.log.message, '마지막 기록');
  assert.equal(slim.count.sentFailed, 1);
});

test('failed = sentFailed + registeredFailed, 출처·상태 이름', () => {
  const [row] = buildGroupRows([slimGroup(rawGroup('G1', { count: { total: 5, sentFailed: 1, registeredFailed: 2, sentSuccess: 2 } }))], []);
  assert.equal(row.failed, 3);
  assert.equal(row.success, 2);
  assert.equal(row.source, 'API');
  assert.equal(row.status_label, '처리완료');
  assert.deepEqual(row.types, []);
  assert.equal(row.audience, null);
});

test('날짜 범위 밖 그룹 제외', async () => {
  const f = fakeFetch([{ groupList: {
    a: rawGroup('A'), b: rawGroup('B', { dateCreated: '2026-11-10T14:59:00.000Z' }), c: rawGroup('C', { dateCreated: '2026-11-11T15:00:00.000Z' }),
  } }]);
  const { groups, partial } = await fetchSolapiGroupsDay('2026-11-11', { fetchImpl: f, nowMs: NOW });
  assert.deepEqual(groups.map(g => g.groupId), ['A']);
  assert.equal(partial, false);
  assert.match(f.calls[0], /\/messages\/v4\/groups\?/);
});

test('nextKey 3쪽이면 partial', async () => {
  const f = fakeFetch([
    { groupList: { a: rawGroup('A') }, nextKey: 'k1' },
    { groupList: { b: rawGroup('B') }, nextKey: 'k2' },
    { groupList: { c: rawGroup('C') }, nextKey: 'k3' },
  ]);
  const { groups, partial } = await fetchSolapiGroupsDay('2026-11-11', { fetchImpl: f, nowMs: NOW });
  assert.equal(f.calls.length, 3);
  assert.equal(groups.length, 3);
  assert.equal(partial, true);
  assert.match(f.calls[1], /startKey=k1/);
});

test('캐시: 두 번째 호출은 fetch 0회', async () => {
  const f = fakeFetch([{ groupList: { a: rawGroup('A') } }]);
  await fetchSolapiGroupsDay('2026-11-11', { fetchImpl: f, nowMs: NOW });
  await fetchSolapiGroupsDay('2026-11-11', { fetchImpl: f, nowMs: NOW + 1000 });
  assert.equal(f.calls.length, 1);
});

test('실패 시 throw', async () => {
  const bad = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(fetchSolapiGroupsDay('2026-11-11', { fetchImpl: bad, nowMs: NOW }), /HTTP 500/);
});

test('buildGroupRows: types 묶음·audience mixed·대표 category·last_log safeText', () => {
  const g = slimGroup(rawGroup('G1', { log: [{ createAt: '2026-11-11T02:00:05.000Z', message: '문의 010-1234-5678 로 연락' }] }));
  const items = [
    { group_id: 'G1', audience: 'customer', category: '출고 안내', type: 'LMS', replaced_from: 'BMS_FREE', recipient_name: '홍길동', to: '010-****-5678' },
    { group_id: 'G1', audience: 'customer', category: '출고 안내', type: 'BMS_TEXT', replaced_from: null, recipient_name: null, to: '010-****-1111' },
    { group_id: 'G1', audience: 'staff', category: '직원 알림', type: 'LMS', replaced_from: null, recipient_name: '관리자', to: '010-****-2222' },
    { group_id: 'OTHER', audience: 'staff', category: 'x', type: 'SMS', replaced_from: null, to: '1' },
  ];
  const [row] = buildGroupRows([g], items);
  assert.deepEqual(row.types, ['BMS', 'LMS']);
  assert.equal(row.audience, 'mixed');
  assert.equal(row.category, '출고 안내');
  assert.deepEqual(row.recipients_preview, ['홍길동', '010-****-1111', '관리자']);
  assert.doesNotMatch(row.last_log.message, /example\.com/);
  // 인증 없이 공개되는 API 라 그룹 최근 기록의 전화번호도 가려져야 한다
  assert.doesNotMatch(row.last_log.message, /010-?1234-?5678/);
  assert.doesNotMatch(JSON.stringify(row), /1234-?5678/);
});

test('buildGroupRows: 최신 생성일 먼저, audience 한 가지면 그것', () => {
  const a = slimGroup(rawGroup('A', { dateCreated: '2026-11-11T01:00:00.000Z' }));
  const b = slimGroup(rawGroup('B', { dateCreated: '2026-11-11T03:00:00.000Z' }));
  const rows = buildGroupRows([a, b], [{ group_id: 'A', audience: 'staff', category: 'c', type: 'LMS', to: '1' }]);
  assert.deepEqual(rows.map(r => r.group_id), ['B', 'A']);
  assert.equal(rows[1].audience, 'staff');
  assert.doesNotMatch(JSON.stringify(rows), /accountId|balance|deposit/);
});
