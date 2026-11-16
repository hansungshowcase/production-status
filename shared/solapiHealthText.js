// 쏠라피 연동 점검 상태 → 사람 말 이유 (화면 띠와 알림 문구가 같이 쓴다)
export const SOLAPI_HEALTH_REASONS = Object.freeze({
  not_configured: '연동 키가 비어 있습니다',
  auth_failed: '쏠라피가 키를 거절했습니다',
  ip_blocked: '쏠라피 허용 IP 설정에 막혔습니다',
  sender_inactive: '발신번호가 쏠라피에 등록돼 있지 않습니다',
  channel_missing: '카카오 채널을 찾지 못했습니다',
  unreachable: '쏠라피가 응답하지 않습니다',
  cron_stale: '자동 점검이 15분 넘게 돌지 않았습니다',
});

export const CRON_STALE_SECONDS = 900;
