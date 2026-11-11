import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/components/SolapiMessageLog.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/SolapiMessageLog.css', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/api/solapiMessages.js', import.meta.url), 'utf8');

test('쏠라피 API 호출은 읽기 전용 GET 이고 캐시하지 않는다', () => {
  assert.match(api, /new URLSearchParams/);
  assert.match(api, /cache:\s*'no-store'/);
  assert.match(api, /\/solapi-messages/);
  assert.doesNotMatch(api, /POST|PUT|DELETE|PATCH/);
  assert.doesNotMatch(src, /method:\s*'(POST|PUT|DELETE|PATCH)'/);
});

test('구분 탭과 보기 전환 이름은 쏠라피와 같다', () => {
  assert.match(src, /label:\s*'전체'/);
  assert.match(src, /label:\s*'고객'/);
  assert.match(src, /label:\s*'직원'/);
  assert.match(src, /건별 내역/);
  assert.match(src, /요청별 내역/);
});

test('발송 상태 필터가 날짜 필터보다 앞에 온다', () => {
  const statusAt = src.indexOf('<span>발송 상태</span>');
  const dateAt = src.indexOf('<span>날짜</span>');
  const typeAt = src.indexOf('<span>타입</span>');
  assert.ok(statusAt > 0 && dateAt > statusAt && typeAt > dateAt);
  assert.match(src, /새로고침/);
  assert.match(src, /type="date"/);
});

test('안내 문구와 가림·부분 조회·키 미설정 표시', () => {
  assert.match(src, /쏠라피 기록 기준/);
  assert.match(src, /0시~24시\(한국시간\)/);
  assert.match(src, /수신번호 가운데 가림/);
  assert.match(src, /쏠라피에 닿기 전에 멈춘 문자\(키 미설정·시험 기록·요청 실패\)는 이 탭에 없고/);
  assert.match(src, /고객 문자 관리/);
  assert.match(src, /직원 알림 관리/);
  assert.match(src, /1,500건까지만 표시합니다\(일부 누락\)/);
  assert.match(src, /쏠라피 키가 설정되지 않아 조회할 수 없습니다/);
  assert.match(src, /timeZone:\s*'Asia\/Seoul'/);
});

test('구분·날짜를 바꾸면 타입 필터를 전체로 되돌린다(안 보이는 필터가 남지 않게)', () => {
  assert.match(src, /function changeAudience\(value\) \{[^}]*setType\('all'\)/);
  assert.match(src, /function changeDate\(value\) \{[^}]*setType\('all'\)/);
});

test('펼침 버튼은 aria-expanded 를 쓰고 오래된 응답은 무시한다', () => {
  assert.match(src, /aria-expanded=/);
  assert.match(src, /aria-controls=/);
  assert.match(src, /requestIdRef/);
  assert.match(src, /다시 불러오기/);
  assert.match(src, /기타 \{otherTotal\}/);
});

test('스타일은 44px 이상 조작 영역과 769px 이상 표, 글자 넘침 방지', () => {
  assert.match(css, /--control-min-height\)/);
  assert.match(css, /min-height:\s*var\(--control-min-height\)/);
  assert.match(css, /@media \(min-width: 769px\)/);
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /word-break:\s*break-all/);
  assert.match(css, /\.solapi-log-table-wrap\s*\{\s*display:\s*none/);
});
