import crypto from 'node:crypto';
import { decryptPrivateConfigRow, encryptPrivateConfigValue } from './privateConfig.js';

const PREFIX = 'sms.campaign.';
const INPUT_FIELDS = new Set(['audience', 'name', 'subject', 'text', 'trigger', 'delayDays', 'revision']);
export const CAMPAIGN_VARIABLES = Object.freeze([
  { key: '고객명', example: '홍길동' },
  { key: '거래처명', example: '한성카페' },
  { key: '납기일', example: '2026-11-10' },
]);
const VARIABLE_KEYS = new Set(CAMPAIGN_VARIABLES.map(item => item.key));
export function campaignError(message, status = 400) {
  const error = new Error(message); error.status = status; error.publicMessage = message; return error;
}
export function validCampaignId(id) { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String(id || '')); }
export function validateCampaignInput(input, { updating = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw campaignError('문자 등록 내용을 확인해 주세요.');
  if (Object.keys(input).some(key => !INPUT_FIELDS.has(key))) throw campaignError('지원하지 않는 등록 항목이 있습니다.');
  const { audience, trigger, delayDays } = input;
  if (!['customer', 'employee'].includes(audience)) throw campaignError('고객 또는 직원을 선택해 주세요.');
  const result = { audience };
  for (const [key, label, limit] of [['name', '문자 이름', 80], ['subject', '문자 제목', 40], ['text', '문자 본문', 2000]]) {
    if (typeof input[key] !== 'string' || !input[key].trim() || [...input[key].trim()].length > limit) throw campaignError(`${label}은 1~${limit}자로 입력해 주세요.`);
    result[key] = input[key].trim();
  }
  if (!['manual', 'packing_completed'].includes(trigger) || (audience === 'employee' && trigger !== 'manual')) throw campaignError('지원하는 발송 조건을 선택해 주세요.');
  if (!Number.isInteger(delayDays) || delayDays < 0 || delayDays > 30 || (trigger === 'manual' && delayDays !== 0)) throw campaignError('대기일은 포장 완료 후 0~30일로 입력해 주세요.');
  for (const text of [result.subject, result.text]) {
    const withoutVariables = text.replace(/\{([^{}]*)\}/g, (_match, key) => {
      if (!VARIABLE_KEYS.has(key)) throw campaignError('변수는 {고객명}, {거래처명}, {납기일}만 사용할 수 있습니다.');
      return '';
    });
    if (/[{}]/.test(withoutVariables)) throw campaignError('문구에 닫히지 않은 변수가 있습니다.');
  }
  if (updating && (!Number.isInteger(input.revision) || input.revision < 1)) throw campaignError('문자 수정 버전을 확인해 주세요.');
  if (!updating && input.revision !== undefined) throw campaignError('신규 등록에는 수정 버전을 지정할 수 없습니다.');
  return { ...result, trigger, delayDays };
}
function readCampaign(row) {
  let item;
  try { item = JSON.parse(decryptPrivateConfigRow(row)); } catch { throw campaignError('등록한 문자를 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.', 503); }
  if (!validCampaignId(item?.id) || row.key !== PREFIX + item.id || item.status !== 'draft' || !Number.isInteger(item.revision) || item.revision < 1) throw campaignError('문자 등록 기록을 확인할 수 없습니다.', 503);
  try {
    const fields = validateCampaignInput({ audience: item.audience, name: item.name, subject: item.subject, text: item.text, trigger: item.trigger, delayDays: item.delayDays });
    return { ...fields, id: item.id, revision: item.revision, status: 'draft', createdAt: item.createdAt, updatedAt: item.updatedAt };
  } catch { throw campaignError('문자 등록 기록을 확인할 수 없습니다.', 503); }
}
export async function listNotificationCampaigns(db, audience = '') {
  const result = await db.execute({ sql: `SELECT key, ciphertext, iv, auth_tag, key_version FROM app_private_config WHERE key LIKE ? ORDER BY updated_at DESC, key DESC`, args: [PREFIX + '%'] });
  return (result.rows || []).map(readCampaign).filter(item => !audience || item.audience === audience);
}
export async function saveNotificationCampaign(db, input, { id = null, now = new Date().toISOString() } = {}) {
  const fields = validateCampaignInput(input, { updating: id !== null });
  let existing = null;
  let previous = null;
  if (id !== null) {
    if (!validCampaignId(id)) throw campaignError('등록한 문자 ID가 올바르지 않습니다.');
    const found = await db.execute({ sql: 'SELECT key, ciphertext, iv, auth_tag, key_version FROM app_private_config WHERE key = ?', args: [PREFIX + id] });
    existing = found.rows?.[0];
    if (!existing) throw campaignError('등록한 문자를 찾을 수 없습니다.', 404);
    previous = readCampaign(existing);
    if (previous.revision !== input.revision) throw campaignError('다른 화면에서 수정된 문자입니다. 목록을 다시 불러온 뒤 수정해 주세요.', 409);
  }
  const item = { ...fields, id: id || crypto.randomUUID(), revision: previous ? previous.revision + 1 : 1, status: 'draft', createdAt: previous?.createdAt || now, updatedAt: now };
  const encoded = encryptPrivateConfigValue(PREFIX + item.id, JSON.stringify(item));
  const args = [encoded.ciphertext, encoded.iv, encoded.authTag, encoded.keyVersion];
  const saved = existing
    ? await db.execute({ sql: 'UPDATE app_private_config SET ciphertext = ?, iv = ?, auth_tag = ?, key_version = ?, updated_at = NOW() WHERE key = ? AND ciphertext = ? RETURNING key', args: [...args, encoded.key, existing.ciphertext] })
    : await db.execute({ sql: 'INSERT INTO app_private_config (key, ciphertext, iv, auth_tag, key_version) VALUES (?, ?, ?, ?, ?) RETURNING key', args: [encoded.key, ...args] });
  if (!saved.rows?.length) throw campaignError('다른 화면에서 수정된 문자입니다. 목록을 다시 불러온 뒤 수정해 주세요.', 409);
  return item;
}
