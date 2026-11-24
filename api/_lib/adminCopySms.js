// 관리자 발송 완료 확인 단문(SMS 90바이트 이하 · 18원, 사진·제목 없음).
// 고객 발송이 1건 이상 성공한 날 해당 문구당 하루 1통만 보내어 어떤 문구가 오늘 누구에게 발송되었는지 알린다.
import { byteLength, SMS_MAX_BYTES } from './sendProvider.js';

const cleanText = value => String(value ?? '').replace(/#\{|\}/g, '').replace(/\s+/g, ' ').trim();

// EUC-KR 바이트 기준(한글·비ASCII 2바이트, ASCII 1바이트)으로 maxBytes 이하가 되게 자른다.
function trimToBytes(text, maxBytes) {
  const s = String(text ?? '');
  if (byteLength(s) <= maxBytes) return s;
  if (maxBytes <= 0) return '';
  const ellipsis = '…';
  const ellBytes = byteLength(ellipsis);
  if (maxBytes <= ellBytes) {
    let out = '';
    for (const ch of s) {
      if (byteLength(out + ch) > maxBytes) break;
      out += ch;
    }
    return out;
  }
  let out = '';
  for (const ch of s) {
    if (byteLength(out + ch + ellipsis) > maxBytes) break;
    out += ch;
  }
  return out ? `${out}${ellipsis}` : '';
}

const SUF_ALL = '님에게 발송 완료되었습니다.';
const sufMore = rest => ` 외 ${rest}명에게 발송 완료되었습니다.`;
const sufCount = count => `${count}명에게 발송 완료되었습니다.`;
const SUF_EMPTY = '발송 완료되었습니다.';
const prefixOf = tpl => `[${tpl}] 금일 `;

/**
 * Build a plain Korean SMS (<= 90 EUC-KR bytes, guaranteed 18 KRW SMS) summarizing daily deliveries.
 * Examples:
 * - `[소개 혜택 안내] 금일 류플로라님에게 발송 완료되었습니다.`
 * - `[소개 혜택 안내] 금일 류플로라, 예성떡집님에게 발송 완료되었습니다.`
 * - `[소개 혜택 안내] 금일 류플로라, 예성떡집 외 2명에게 발송 완료되었습니다.`
 */
export function buildAdminCopySms(templateName, recipientNames = []) {
  const tplFull = cleanText(templateName) || '자동문자';
  const list = (Array.isArray(recipientNames) ? recipientNames : [])
    .map(name => cleanText(name) || '고객');

  const tryWithTpl = tpl => {
    if (!tpl) return null;
    if (!list.length) {
      const candidate = `${prefixOf(tpl)}${SUF_EMPTY}`;
      return byteLength(candidate) <= SMS_MAX_BYTES ? candidate : null;
    }
    const all = `${prefixOf(tpl)}${list.join(', ')}${SUF_ALL}`;
    if (byteLength(all) <= SMS_MAX_BYTES) return all;
    for (let k = list.length - 1; k >= 1; k -= 1) {
      const part = `${prefixOf(tpl)}${list.slice(0, k).join(', ')}${sufMore(list.length - k)}`;
      if (byteLength(part) <= SMS_MAX_BYTES) return part;
    }
    return null;
  };

  // A: 전체 템플릿 이름 그대로 시도
  const exact = tryWithTpl(tplFull);
  if (exact) return exact;

  // B: 템플릿 이름을 단계적으로 줄여 1명 이상 성함이 들어가게 시도
  for (const cap of [36, 28, 20, 14]) {
    const shortTpl = trimToBytes(tplFull, cap);
    const hit = tryWithTpl(shortTpl);
    if (hit) return hit;
  }

  // C: 첫 고객 성함 자체가 매우 긴 경우에도 첫 성함 일부 + 외 N명 유지
  const tpl = trimToBytes(tplFull, 24) || '문자';
  const suf = list.length <= 1 ? SUF_ALL : sufMore(list.length - 1);
  const nameBudget = SMS_MAX_BYTES - byteLength(prefixOf(tpl)) - byteLength(suf);
  if (list.length >= 1 && nameBudget >= 6) {
    const shortName = trimToBytes(list[0], nameBudget);
    const candidate = `${prefixOf(tpl)}${shortName}${suf}`;
    if (shortName && byteLength(candidate) <= SMS_MAX_BYTES) return candidate;
  }

  // D: 최후 안전장치(항상 90바이트 이하 보장)
  const tail = list.length ? sufCount(list.length) : SUF_EMPTY;
  const tplBudget = Math.max(0, SMS_MAX_BYTES - byteLength('[] 금일 ') - byteLength(tail));
  if (tplBudget >= 4) return `[${trimToBytes(tplFull, tplBudget)}] 금일 ${tail}`;
  return trimToBytes(`금일 ${tail}`, SMS_MAX_BYTES);
}

/**
 * Claim today's daily admin summary slot on `sms_text_templates.auto_copy_date` and send 1 plain SMS (no fileId/subject).
 */
export async function sendAdminCopySms({ db, vendor, from, to, templateId, templateName, recipientNames, today, fetchImpl }) {
  if (!to || !from || typeof vendor?.sendEach !== 'function') return undefined;
  try {
    const claimed = await db.execute({
      sql: "UPDATE sms_text_templates SET auto_copy_date = ? WHERE id = ? AND COALESCE(auto_copy_date, '') <> ? RETURNING id",
      args: [today, templateId, today],
    });
    if (!claimed.rows?.[0]) return undefined;
    const text = buildAdminCopySms(templateName, recipientNames);
    const result = await vendor.sendEach({ from, messages: [{ to, text }] }, { fetchImpl });
    return result && !result.uncertain && result.failed === 0 ? 'sent' : 'failed';
  } catch (error) {
    console.error('관리자 확인 문자 발송 실패', error?.message || error);
    return 'failed';
  }
}
