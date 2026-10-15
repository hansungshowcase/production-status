const STARTED_NOTIFICATION_OFF_REASON = '제작 시작 알림 사용 설정이 꺼져 있습니다.';

const STATUS_PRESENTATION = Object.freeze({
  paused: { key: 'paused', label: '보내지 않음' },
  off: { key: 'off', label: '알림 꺼짐' },
  test: { key: 'test', label: '시험 모드' },
  incomplete: { key: 'incomplete', label: '설정 필요' },
  ready: { key: 'ready', label: '자동 발송 설정됨' },
  conditional: { key: 'conditional', label: '추가 확인 필요' },
  unknown: { key: 'unknown', label: '상태 확인 필요' },
});

const CONFIGURATION_STATUS_KEYS = new Set([
  'test',
  'incomplete',
  'ready',
  'conditional',
  'unknown',
]);

const REASON_PRESENTATION = Object.freeze({
  '기록 DB 설정이 없어 발송 진입점을 실행할 수 없습니다.': '기록을 저장하는 설정이 없어 자동 알림을 시작할 수 없습니다.',
  [STARTED_NOTIFICATION_OFF_REASON]: '제작 시작 알림이 꺼져 있습니다.',
  '메시지 제공사 설정이 없어 실제 전송 없이 테스트 기록만 남습니다.': '문자 서비스 연결이 없어 실제 문자는 보내지 않고 시험 기록만 남깁니다.',
  '알림톡 조합 또는 LMS 발신번호 설정이 필요합니다.': '카카오 알림톡 설정 또는 장문문자 발신번호를 등록해야 합니다.',
  '이벤트 발송은 가능하지만 08:30 대기·재시도 실행 설정이 없습니다.': '조건이 생길 때 보내는 알림은 가능하지만, 매일 08:30 대기·재시도는 설정되지 않았습니다.',
  '이벤트 발송과 08:30 대기·재시도 실행 조건이 충족되었습니다.': '조건이 생길 때 보내는 알림과 매일 08:30 대기·재시도를 실행할 설정이 준비됐습니다.',
  '주기 실행 인증 설정이 없어 예약 알림을 실행할 수 없습니다.': '정해진 시간에 자동으로 확인하는 설정이 없어 예약 알림을 실행할 수 없습니다.',
  'LMS 발신번호 설정이 필요합니다.': '장문문자를 보낼 발신번호를 등록해야 합니다.',
  '이벤트 발송은 가능하지만 평일 08:40 일일 실행 설정이 없습니다.': '조립 착수 때 보내는 알림은 가능하지만, 평일 08:40 일일 점검은 설정되지 않았습니다.',
  '평일 예약 실행과 LMS 발송 조건이 충족되었습니다.': '평일 예약 확인과 장문문자 발송에 필요한 설정이 준비됐습니다.',
  '이벤트 발생 시 LMS 발송 조건이 충족되었습니다.': '조건이 생길 때 장문문자를 보낼 설정이 준비됐습니다.',
  '기록 DB 설정이 없어 감시 대상을 조회할 수 없습니다.': '기록을 저장하는 설정이 없어 차단 여부를 확인할 수 없습니다.',
  '제공사 전달 결과를 조회할 설정이 필요합니다.': '문자 서비스의 전달 결과를 확인할 연결 설정이 필요합니다.',
  '차단 감지 후 관리자 LMS를 보낼 발신번호 설정이 필요합니다.': '차단을 발견했을 때 관리자에게 장문문자를 보낼 발신번호가 필요합니다.',
  '5분 주기 실행 인증 설정이 없습니다.': '5분마다 자동으로 확인하는 설정이 필요합니다.',
  '평일 5분 주기 감시와 관리자 LMS 발송 조건이 충족되었습니다.': '평일 5분마다 차단 여부를 확인하고 관리자에게 장문문자를 보낼 설정이 준비됐습니다.',
  '등록된 영업담당자에게만 발송하며, 미매핑 담당자는 대체 수신번호가 없어 제외됩니다.': '연락처가 등록된 영업담당자에게만 보냅니다. 연락처가 등록되지 않은 담당자는 대신 받을 번호가 없어 제외됩니다.',
  '출고 완료 고객 알림은 정책으로 중단되어 실행 설정을 사용하지 않습니다.': '출고 완료 고객 알림은 보내지 않도록 정해져 있어 발송 설정을 사용하지 않습니다.',
});

const EXACT_TEXT_PRESENTATION = Object.freeze({
  '사내 internal_* 및 chonbe_alert의 수신거부·차단 결과 감지': '직원 알림과 분체 미착수 영업 알림에서 수신거부·차단 결과가 확인될 때',
  '출고 완료 처리 시 진입하지만 발송 전에 중단': '출고 완료로 처리되더라도 문자를 보내기 전에 멈춤',
  '신규·재시도·누락 복구 모두 제외': '새 알림·재시도·누락 복구 모두 보내지 않음',
});

const CHANNEL_PRESENTATION = Object.freeze({
  LMS: '장문문자',
  lms: '장문문자',
  alimtalk: '카카오 알림톡',
  '알림톡 우선 · 문자 대체': '카카오 알림톡 우선 · 문자로 대신 전송',
  '확인 불가': '보내는 방법 확인 필요',
  '발송 안 함': '보내지 않음',
});

const RECENT_LABEL_PRESENTATION = Object.freeze({
  '수신 확인': '수신 확인',
  '제공사 접수 성공': '발송 요청 완료',
  '전달 처리 중': '전달 확인 중',
  '발송·전달 실패': '발송·전달 실패',
  '테스트 기록': '시험 기록',
  '기타 처리': '상태 확인 필요',
});

export function notificationStatusPresentation(item) {
  if (item?.policy?.status === 'paused') return STATUS_PRESENTATION.paused;
  if (
    item?.id === 'customer_started'
    && item?.configuration?.reason === STARTED_NOTIFICATION_OFF_REASON
  ) {
    return STATUS_PRESENTATION.off;
  }
  if (item?.policy?.status !== 'active') return STATUS_PRESENTATION.unknown;
  const configurationStatus = item?.configuration?.status;
  return CONFIGURATION_STATUS_KEYS.has(configurationStatus)
    ? STATUS_PRESENTATION[configurationStatus]
    : STATUS_PRESENTATION.unknown;
}

export function notificationReasonPresentation(reason) {
  return REASON_PRESENTATION[String(reason || '')] || '자세한 이유는 확인이 필요합니다.';
}

export function notificationTextPresentation(value) {
  const text = String(value || '');
  const exact = EXACT_TEXT_PRESENTATION[text];
  if (exact) return exact;
  return text
    .replaceAll('KST', '한국시간')
    .replace('멱등 발송', '같은 안내를 중복해서 보내지 않음')
    .replaceAll('미매핑 담당자는 대체 수신번호', '연락처가 등록되지 않은 담당자는 대신 받을 번호')
    .replaceAll('미매핑 담당자는 제외', '연락처가 등록되지 않은 담당자는 제외');
}

export function notificationChannelPresentation(value) {
  return CHANNEL_PRESENTATION[String(value || '')] || '보내는 방법 확인 필요';
}

export function notificationRecentLabelPresentation(value) {
  const text = String(value || '');
  return RECENT_LABEL_PRESENTATION[text] || (text ? '처리 상태 확인 필요' : '기록 없음');
}

export function notificationLogMessagePresentation(value) {
  if (value === '정책과 설정은 확인했지만 최근 처리 기록은 조회할 수 없습니다.') {
    return '현재 알림 상태는 확인했지만 최근 처리 결과는 불러올 수 없습니다.';
  }
  return '최근 처리 결과를 불러올 수 없습니다.';
}
