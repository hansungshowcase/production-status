// 자동 발송 문구의 '실제로 나가는 상태' 판정. 서버(api/)와 화면(src/)이 같이 import 한다(순수 함수만, 브라우저 전용 코드 금지).
// status = resource=auto_status 응답. 켜져 있어도 발송 업체 설정이 없거나 켜기 차단·건너뜀·연속 실패가 있으면 '막힘'으로 본다.
// 반환: { tone: 'on'|'part'|'blocked'|'off'|'unknown', text, blocked }

const reasonText = (value) => String(value ?? '').trim();

// 켜기 막힘 코드(enable_blocked_reason) → 한국어 문장. 문장은 화면의 toggleRejectText 와 같다. 표에 없는 코드는 '설정 확인 필요'.
const BLOCKED_TEXT = {
  no_ad_prefix: '본문이 (광고)로 시작해야 켤 수 있습니다.',
  no_optout_080: '본문에 무료수신거부 080 번호 줄이 있어야 켤 수 있습니다.',
  cafe24_not_connected: '카페24 연결이 아직 안 됐습니다',
  lead_source_not_connected: '가입·문의 정보 연결이 아직 안 됐습니다.',
  ata_not_ready: '선택한 알림톡 템플릿이 아직 쓸 수 없는 상태입니다.',
  bms_not_ready: '브랜드메시지 설정(사진·글자 수)이 맞지 않습니다. 문구를 다시 저장해 주세요.',
  lead_overlap: '가입 당일에 나가는 문구가 이미 켜져 있습니다.',
  no_step: '공정을 골라 주세요',
  no_staff: '받을 직원을 한 명 이상 골라 주세요',
  ata_customer_only: '알림톡은 고객에게만 보낼 수 있습니다',
  info_has_ad_words: '안내 문구에는 할인·이벤트 같은 광고 낱말을 쓸 수 없습니다',
  info_needs_order_var: '안내 문구에는 주문 변수가 하나 이상 있어야 합니다',
  info_unknown_var: '이 문구에서 쓸 수 없는 변수가 들어 있습니다',
};
const blockedText = (code) => { const key = reasonText(code); return key ? (BLOCKED_TEXT[key] || '설정 확인 필요') : ''; };

// 크론이 멈췄는지(2026-11-18): 5분 크론의 마지막 실행(cron_last_run, ISO)이 30분을 넘게 지났으면 '실행이 멈춤'. 값이 없거나 읽을 수 없으면 판단하지 않는다.
const CRON_STALE_MS = 30 * 60000;
const staleCronText = (status, nowMs) => {
  const last = Date.parse(status?.cron_last_run || '');
  if (!Number.isFinite(last) || !Number.isFinite(nowMs) || nowMs - last <= CRON_STALE_MS) return '';
  return `자동 발송 실행이 멈춤(마지막 ${new Date(last + 9 * 3600000).toISOString().slice(11, 16)})`;
};

export function autoEffective(status, nowMs = Date.now()) {
  if (!status || typeof status !== 'object') return { tone: 'unknown', text: '확인 중', blocked: false };
  if (!status.enabled) return { tone: 'off', text: '꺼짐', blocked: false };
  const sent7 = Number(status.sent_7d) || 0;
  const failed7 = Number(status.failed_7d) || 0;
  const no080 = reasonText(status.enable_blocked_reason) === 'no_optout_080'; // 080 줄이 없어도 발송은 멈추지 않는다 → 막힘이 아니라 '켜짐(주의)'
  const why = status.no_provider ? '발송 업체 설정 없음'
    : blockedText(no080 ? '' : status.enable_blocked_reason)
    || reasonText(status.auto_skip_reason)
    || (status.ata_backoff ? '알림톡 연속 실패로 잠시 쉼' : '')
    || staleCronText(status, nowMs)
    || (failed7 > sent7 ? '최근 7일 실패가 성공보다 많음' : '');
  if (why) return { tone: 'blocked', text: `켜짐(막힘: ${why})`, blocked: true };
  if (no080) return { tone: 'part', text: '켜짐 · 080 수신거부 줄 필요(발송은 계속)', blocked: false };
  if (status.catchup_paused) {
    const detail = reasonText(status.catchup_error) || '사유를 알 수 없습니다';
    return { tone: 'part', text: `켜짐 · 일괄 발송 멈춤(${detail})`, blocked: false };
  }
  return { tone: 'on', text: '켜짐', blocked: false };
}

// 화면 신호등 색 이름(기존 stl-light 클래스): on 초록 · part·blocked 노랑 · off 빨강 · unknown 회색
export const autoLightClass = (effective) => (effective.tone === 'on' ? 'on' : (effective.tone === 'part' || effective.tone === 'blocked' ? 'part' : (effective.tone === 'off' ? 'off' : 'unknown')));
