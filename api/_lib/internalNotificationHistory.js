const EXECUTIVE_NAMES = {
  internal_vcut_completed: '이시아 부장',
  internal_design_due: '김보수 팀장',
  internal_laser_due: '이정섭 부장',
  internal_welding_due: '최우석 이사',
  internal_assembly_due: '박상규 공장장',
  internal_packing_due: '정영호 팀장',
};

const MEMBER_NAMES_BY_MASKED_PHONE = {
  '010****0873': '강종효',
  '010****2576': '카우사르',
  '010****9396': '나타왓',
  '010****8947': '마카라',
  '010****4464': '백승정',
  '010****4537': '까지',
};

const MEMBER_MASKED_PHONE_BY_NAME = Object.fromEntries(
  Object.entries(MEMBER_NAMES_BY_MASKED_PHONE).map(([phone, name]) => [name, phone]),
);

export const INTERNAL_MEMBER_NAMES = new Set(Object.keys(MEMBER_MASKED_PHONE_BY_NAME));

export function maskedPhoneForInternalMember(name) {
  return MEMBER_MASKED_PHONE_BY_NAME[name] || '';
}

const PUBLIC_STATUSES = new Set(['success', 'failed', 'dry_run']);

export function audienceForMilestone(milestone) {
  return milestone === 'internal_assembly_daily' ? 'member' : 'executive';
}

function maskedPhone(value) {
  const stored = String(value || '').trim();
  if (/^\d{3}\*{4}\d{4}$/.test(stored)) return stored;

  const digits = stored.replace(/\D/g, '');
  if (digits.length < 8) return '';
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

export function serializeInternalNotification(row) {
  const milestone = String(row?.milestone || '');
  const phone = maskedPhone(row?.to_phone);
  return {
    id: Number(row?.id),
    milestone,
    audience: audienceForMilestone(milestone),
    recipient_name: row?.recipient_name
      || EXECUTIVE_NAMES[milestone]
      || MEMBER_NAMES_BY_MASKED_PHONE[phone]
      || '팀원',
    phone,
    status: PUBLIC_STATUSES.has(row?.status) ? row.status : 'failed',
    subject: row?.message_subject || '',
    text: row?.message_text || null,
    sent_at: row?.created_at || null,
  };
}

export function summarizeInternalNotifications(items = []) {
  return {
    total: items.length,
    success: items.filter(item => item.status === 'success').length,
    failed: items.filter(item => item.status === 'failed').length,
    dry_run: items.filter(item => item.status === 'dry_run').length,
  };
}
