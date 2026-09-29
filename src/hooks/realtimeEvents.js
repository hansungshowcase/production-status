const EVENT_TYPE_MAP = {
  '공정시작': 'PROCESS_STARTED',
  '공정완료': 'PROCESS_COMPLETED',
  '공정되돌리기': 'PROCESS_REVERTED',
  '이슈등록': 'ISSUE_REPORTED',
  '이슈해결': 'ISSUE_RESOLVED',
  '주문등록': 'ORDER_CREATED',
  '주문수정': 'ORDER_UPDATED',
  '주문삭제': 'ORDER_DELETED',
  '출고완료': 'ORDER_SHIPPED',
  '사전생산수정': 'PRE_PRODUCTION_UPDATED',
};

export function normalizeRealtimeEventType(type) {
  return EVENT_TYPE_MAP[type] || type;
}

export function toRealtimeMessage(data) {
  const events = Array.isArray(data?.events) ? data.events : [];
  if (events.length === 0) return null;

  const latest = events[0];
  return {
    type: normalizeRealtimeEventType(latest.action_type),
    types: events.map((event) => normalizeRealtimeEventType(event.action_type)),
    data: latest,
    timestamp: latest.created_at,
  };
}
