import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const src = readFileSync(new URL('../src/components/SolapiMessageLog.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/components/SolapiMessageLog.css', import.meta.url), 'utf8');
const api = readFileSync(new URL('../src/api/solapiMessages.js', import.meta.url), 'utf8');

test('쏠라피 API 호출은 읽기 전용 GET 이고 캐시하지 않으며 모든 파라미터를 보낸다', () => {
  assert.match(api, /new URLSearchParams/);
  assert.match(api, /cache:\s*'no-store'/);
  assert.match(api, /\/solapi-messages/);
  assert.doesNotMatch(api, /POST|PUT|DELETE|PATCH/);
  assert.doesNotMatch(src, /method:\s*'(POST|PUT|DELETE|PATCH)'/);
  for (const key of ['view', 'audience', 'page_size', 'status', 'type', 'to4', 'from', 'message_id', 'group_id', 'template_id', 'group_status', 'min_total', 'min_sent']) {
    assert.ok(api.includes(`'${key}'`) || api.includes(key), `${key} 파라미터`);
  }
});

test('알약 탭: 요청별 내역이 기본이고 구분은 전체·고객·직원·기타', () => {
  assert.match(src, /label:\s*'요청별 내역'/);
  assert.match(src, /label:\s*'건별 내역'/);
  assert.match(src, /useState\('groups'\)/);
  assert.match(src, /label:\s*'전체'/);
  assert.match(src, /label:\s*'고객'/);
  assert.match(src, /label:\s*'직원'/);
  assert.match(src, /label:\s*'기타'/);
  assert.match(src, /role="tab"/);
});

test('필터 칩 이름이 보기마다 쏠라피와 같다', () => {
  for (const name of ['생성일', '그룹상태', 'Group ID', '접수건수', '발송건수',
    '발송 상태', '메시지종류', '수신번호', '발신번호', 'Message ID', '알림톡 템플릿 ID']) {
    assert.ok(src.includes(`'${name}'`), `칩 ${name}`);
  }
  assert.match(src, /aria-haspopup="dialog"/);
  assert.match(src, /key === 'Escape'/);
  assert.match(src, /mousedown/);
  assert.match(src, /필터 해제/);
});

test('안내 문구와 가림·부분 조회·키 미설정 표시(잠긴 결정)', () => {
  assert.match(src, /수신번호 가운데/);
  assert.match(src, /쏠라피에 닿기 전에 멈춘 문자\(키 미설정·시험 기록·요청 실패\)는 이 탭에 없고/);
  assert.match(src, /고객 문자 관리/);
  assert.match(src, /직원 알림 관리/);
  assert.match(src, /1,500건까지만 표시합니다\(일부 누락\)/);
  assert.match(src, /쏠라피 키가 설정되지 않아 조회할 수 없습니다/);
  assert.match(src, /하루\(한국시간\)/);
  assert.match(src, /timeZone:\s*'Asia\/Seoul'/);
  assert.match(src, /수신번호·본문 일부가 가려져 있습니다/);
});

test('도구줄: 새로고침, 성공·발송중·실패 요약, 쪽 크기 20/50/100 기본 50', () => {
  assert.match(src, /새로고침/);
  assert.match(src, /성공 \{summary\.success\}/);
  assert.match(src, /발송중 \{summary\.pending\}/);
  assert.match(src, /실패 \{summary\.failed\}/);
  assert.match(src, /PAGE_SIZES = \[20, 50, 100\]/);
  assert.match(src, /useState\(50\)/);
  assert.match(src, /total_pages/);
});

test('세 컴포넌트를 연결하고 행 누름 동작을 한다', () => {
  assert.match(src, /import SolapiGroupTable from '\.\/solapi\/SolapiGroupTable'/);
  assert.match(src, /import SolapiMessageTable from '\.\/solapi\/SolapiMessageTable'/);
  assert.match(src, /import SolapiMessageDetail from '\.\/solapi\/SolapiMessageDetail'/);
  assert.match(src, /onOpenGroup=\{openGroup\}/);
  assert.match(src, /onOpen=\{openMessage\}/);
  assert.match(src, /group_map\?\.\[selected\.group_id\]/);
  assert.match(src, /function openGroup\(groupId\) \{[^}]*setView\('messages'\)[^}]*group_id: groupId/);
  assert.match(src, /el\.focus\(\)/);
});

test('보기·구분·날짜를 바꾸면 그 보기에 없는 필터를 지우고 1쪽으로', () => {
  assert.match(src, /function keepFor/);
  assert.match(src, /function changeView\(next\) \{[\s\S]*?keepFor\(next[\s\S]*?setPage\(1\)/);
  assert.match(src, /function changeAudience\(next\) \{[\s\S]*?keepFor\(view, f, true\)[\s\S]*?setPage\(1\)/);
  assert.match(src, /function changeDate\(value\) \{[\s\S]*?keepFor\(view, f, true\)[\s\S]*?setPage\(1\)/);
});

test('점검 반영: ID 칸은 문자 자판, 건수 상한은 서버와 같음, 요청 목록 일부 안내, 하루 합계 표시', () => {
  assert.match(src, /inputMode=\{chip\.key === 'to4' \|\| chip\.kind === 'number' \? 'numeric' : undefined\}/);
  const m = src.match(/const COUNT_RE = (\/.+\/);/);
  assert.ok(m, 'COUNT_RE 정의');
  const re = new Function(`return ${m[1]}`)();
  assert.ok(re.test('100000') && re.test('0') && re.test('99999'));
  assert.ok(!re.test('100001') && !re.test('999999'));
  assert.match(src, /data\?\.groups_partial \?/);
  assert.match(src, /요청 목록을 일부만 불러왔습니다/);
  assert.match(src, /하루 합계 · 성공 \{summary\.success\}/);
});

test('상태 표시와 오래된 응답 무시', () => {
  assert.match(src, /requestIdRef/);
  assert.match(src, /requestId !== requestIdRef\.current/);
  assert.match(src, /불러오는 중/);
  assert.match(src, /다시 불러오기/);
  assert.match(src, /조회된 내역이 없습니다/);
});

test('스타일은 44px 이상 조작 영역과 769px 이상/768px 이하 구분, 글자 넘침 방지', () => {
  assert.match(css, /--control-min-height\)/);
  assert.match(css, /min-height:\s*var\(--control-min-height\)/);
  assert.match(css, /--sl-ctl:\s*36px/);
  assert.match(css, /@media \(min-width: 769px\)/);
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /word-break:\s*break-all/);
});
