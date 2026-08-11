import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stationSource = readFileSync(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');
const stationCss = readFileSync(new URL('../src/pages/WorkerStationViewPage.css', import.meta.url), 'utf8');

// 지연이 22건까지 늘면서 알림 목록이 화면을 다 덮어 정작 아래 작업현황이 안 보였다(2026-08-11 요청).
test('납기초과·금일출고 알림은 접힌 채로 시작한다', () => {
  assert.match(stationSource, /const \[dueTodayAlertOpen, setDueTodayAlertOpen\] = useState\(false\)/);
  assert.match(stationSource, /const \[delayedAlertOpen, setDelayedAlertOpen\] = useState\(false\)/);
});

test('제목 줄을 누르면 알림 목록이 펼쳐진다', () => {
  for (const setter of ['setDueTodayAlertOpen', 'setDelayedAlertOpen']) {
    assert.match(
      stationSource,
      new RegExp(`onClick=\\{\\(\\) => ${setter}\\(open => !open\\)\\}`),
      `${setter} 로 펼침 상태를 뒤집어야 한다`,
    );
  }
  // 접힌 상태에서는 목록을 실제로 감춰야 한다. 빈 껍데기만 두면 화면이 그대로 길다.
  assert.match(stationSource, /factory-delay-alert__list--collapsed/);
  assert.match(stationCss, /\.factory-delay-alert__list--collapsed\s*\{[^}]*display:\s*none/);
  // 무엇을 눌러야 하는지 화면에 보여야 한다.
  assert.match(stationSource, /전체 보기/);
  assert.match(stationSource, /접기/);
});

test('작업현황은 10건씩 나눠 보여준다', () => {
  assert.match(stationSource, /const PAGE_SIZE = 10/);
  assert.match(stationSource, /const pagedItems = sorted\.slice\(pageStart, pageStart \+ PAGE_SIZE\)/);
  // 목록을 그릴 때 전체가 아니라 현재 페이지만 그려야 한다.
  assert.match(stationSource, /pagedItems\.map\(\(item\) => \{/);
  assert.doesNotMatch(stationSource, /sorted\.map\(\(item\) => \{/, '전체 목록을 그대로 그리면 페이지 나눔이 무의미하다');
});

test('페이지 버튼은 10건을 넘을 때만 나온다', () => {
  assert.match(stationSource, /pageCount > 1 && \(/);
  assert.match(stationSource, /const pageCount = Math\.max\(1, Math\.ceil\(sorted\.length \/ PAGE_SIZE\)\)/);
});

// 3페이지를 보다가 검색하면 결과가 2건일 수 있다. 그 페이지는 존재하지 않아 빈 화면이 된다.
test('검색하거나 공정을 옮기면 1페이지로 돌아간다', () => {
  assert.match(stationSource, /setPage\(1\);\s*\n\s*\}, \[searchQuery, decodedStep\]\)/);
});

// 완료 처리로 목록이 줄어드는 순간에도 없는 페이지를 가리키면 안 된다.
test('현재 페이지가 마지막 페이지를 넘지 않도록 맞춘다', () => {
  assert.match(stationSource, /const currentPage = Math\.min\(page, pageCount\)/);
});

// 검색 결과를 눌러 특정 주문으로 이동할 때, 그 주문이 다른 페이지에 있으면
// 스크롤만 해서는 카드가 없어 아무 일도 일어나지 않는다.
test('주문으로 이동할 때 그 주문이 있는 페이지로 넘어간다', () => {
  assert.match(stationSource, /if \(targetIndex >= 0\) setPage\(Math\.floor\(targetIndex \/ PAGE_SIZE\) \+ 1\)/);
  // 페이지를 넘기면 카드가 다음 렌더에 생기므로 한 프레임만 기다려서는 놓친다.
  assert.match(stationSource, /framesLeft/);
});
