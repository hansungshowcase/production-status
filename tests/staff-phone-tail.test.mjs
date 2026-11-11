import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { phoneTail, recipientWithPhoneTail, shortenPhonesInText } from '../src/utils/phoneTail.js';

// 2026-11-11 사장님 "직원문자 관리에서 받는사람은 성함 (4237) 이렇게 뒷번호만 보이게해"
const staffSource = readFileSync(new URL('../src/components/StaffSmsPanel.jsx', import.meta.url), 'utf8');
const overviewSource = readFileSync(new URL('../src/components/NotificationOverview.jsx', import.meta.url), 'utf8');

test('받는 사람은 이름 (끝 4자리)로 보인다', () => {
  assert.equal(phoneTail('010****4237'), '4237');
  assert.equal(phoneTail('010-4221-4237'), '4237');
  assert.equal(phoneTail('번호 형식 오류'), '');
  assert.equal(recipientWithPhoneTail('이시아 부장', '010****4237'), '이시아 부장 (4237)');
  assert.equal(recipientWithPhoneTail('김보수 팀장', ''), '김보수 팀장');
  assert.equal(recipientWithPhoneTail(null, '010****0220'), '이름 미확인 (0220)');
});

test('등록 현황 글 속 번호도 끝 4자리만 남는다', () => {
  assert.equal(shortenPhonesInText('이시아 부장 (010****4237)'), '이시아 부장 (4237)');
  assert.equal(
    shortenPhonesInText('신은철 (010****7407), 이준형 (010****4237) · 연락처가 등록되지 않은 담당자는 대신 받을 번호 (010****4237)'),
    '신은철 (7407), 이준형 (4237) · 연락처가 등록되지 않은 담당자는 대신 받을 번호 (4237)',
  );
  assert.equal(shortenPhonesInText('해당 주문의 영업담당자 (등록 라우팅: 신은철 (010-1234-7407))'), '해당 주문의 영업담당자 (등록 라우팅: 신은철 (7407))');
  assert.equal(shortenPhonesInText('평일 08:30 (한국시간)'), '평일 08:30 (한국시간)');
});

test('직원 문자 관리 화면이 줄인 표시를 쓴다(가린 번호 줄은 따로 없음)', () => {
  assert.match(staffSource, /<strong>\{recipientWithPhoneTail\(item\.recipient_name, item\.phone\)\}<\/strong>/);
  assert.doesNotMatch(staffSource, /item\.phone \|\| '번호 정보 없음'/);
  assert.match(overviewSource, /shortPhones=\{onlyGroup === 'internal'\}/);
  assert.match(overviewSource, /<dd>\{text\(item\.target\)\}<\/dd>/);
});
