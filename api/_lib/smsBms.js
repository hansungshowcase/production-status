// 브랜드메시지(자유형, BMS_FREE) 수단 공용 규칙 (2026-11-17 설계_브랜드메시지_자유형).
// 수단 표시: 문구의 auto_ata_template 에 'BMS_FREE' 를 넣고(알림톡 갈래 안전장치를 그대로 쓴다), 채널·버튼·이미지는 auto_bms(JSON)에 둔다.
// 확인한 규격(solapi.com/guides/kakao-bms-guide · 솔라피 SDK 타입 정의 · 솔라피 파일 업로드 문서, 2026-11-17):
// - 자유형 텍스트 1,300자(줄바꿈 99), 이미지형 400자(줄바꿈 29). 버튼 이름 14자, 최대 5개. 이미지 jpg·png 5MB, 가로:세로 2:1~3:4, 권장 800×400.
// - 이미지 업로드: POST storage/v1/files, type 'BMS'. 반환 fileId(ST01FZ…)를 메시지의 kakaoOptions.bms.imageId 로 쓴다.
// - 버튼: { name, linkType:'WL', linkMobile, linkPc? }. targeting 'I' = 채널 친구에게만(M·N 은 카카오 인허가 채널만).
// - 광고성 메시지는 KST 20:50~익일 08:00 발송 제한이 있다. 이 프로그램은 더 좁게 08:00~20:00 사이에만 보낸다(설계).
import crypto from 'node:crypto';

import { BMS_LIMITS, BMS_TEMPLATE_ID, bmsButtonsCheck, bmsTextError } from '../../shared/smsBmsLimits.js';
export { BMS_LIMITS, BMS_TEMPLATE_ID, bmsTextError };
export const BMS_PF_ID = 'KA01PF241111145751437aCGtcFdsD2M';
export const BMS_SENDER = '0319862458';
export const BMS_WINDOW = Object.freeze({ from: 8, to: 20 }); // KST 08시 이상 20시 미만

export const isBmsTemplate = template => template?.auto_ata_template === BMS_TEMPLATE_ID;
export const isBmsId = value => value === BMS_TEMPLATE_ID;
export const bmsInWindow = nowMs => { const hour = new Date(nowMs + 9 * 3600000).getUTCHours(); return hour >= BMS_WINDOW.from && hour < BMS_WINDOW.to; };
// 시험 발송용: 카카오 실제 발송 가능 시간(KST 08:00 이상 20:50 미만). 이 밖에 보내면 카톡이 실패하고 문자로 대체된다.
export const bmsTestInWindow = nowMs => { const d = new Date(nowMs + 9 * 3600000); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 8 * 60 && m < 20 * 60 + 50; };

const clean = value => String(value ?? '').trim();

// 저장된 auto_bms(JSON 문자열) → { pfId, from, buttons:[{name,link}], imageId, imageSig }. 깨졌거나 비었으면 기본값.
export function parseBmsConfig(raw) {
  let value = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw); } catch { value = null; } }
  const src = value && typeof value === 'object' ? value : {};
  const buttons = (Array.isArray(src.buttons) ? src.buttons : [])
    .map(item => ({ name: clean(item?.name), link: clean(item?.link) })).filter(item => item.name && item.link).slice(0, BMS_LIMITS.buttons);
  return { pfId: clean(src.pfId) || BMS_PF_ID, from: String(src.from || '').replace(/\D/g, '') || BMS_SENDER, buttons, imageId: clean(src.imageId), imageSig: clean(src.imageSig) };
}

// 화면 입력(auto.bms = { buttons:[{name, link}] }) → { buttons } | { error, reason }
export const readBmsButtons = input => bmsButtonsCheck(input?.buttons);

export const bmsImageSig = base64 => crypto.createHash('sha256').update(String(base64 || '')).digest('hex').slice(0, 32);

// JPEG 가로·세로(SOF 마커). 읽지 못하면 null.
export function jpegSize(base64) {
  try {
    const buffer = Buffer.from(String(base64 || ''), 'base64');
    let at = 2;
    while (at + 9 < buffer.length) {
      if (buffer[at] !== 0xff) { at += 1; continue; }
      const marker = buffer[at + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: buffer.readUInt16BE(at + 5), width: buffer.readUInt16BE(at + 7) };
      at += 2 + buffer.readUInt16BE(at + 2);
    }
  } catch { /* 모르면 null */ }
  return null;
}
// 이미지 비율(가로/세로)이 자유형 이미지 규격(2:1 ~ 3:4) 안인지. 크기를 못 읽으면 막지 않는다.
export function bmsImageRatioError(base64) {
  const size = jpegSize(base64);
  if (!size || !size.width || !size.height) return '';
  const ratio = size.width / size.height;
  return ratio < BMS_LIMITS.ratioMin || ratio > BMS_LIMITS.ratioMax ? '브랜드메시지 이미지는 가로:세로가 2:1에서 3:4 사이여야 합니다(권장 800×400).' : '';
}

// 발송 준비 확인(쏠라피 호출 없음): 채널·발신번호·이미지(저장 때 올린 imageId 가 지금 사진과 같은지)·본문 길이.
// → { ok, reason, cfg } . reason: 'bms_not_ready'
export function bmsReady(template) {
  const cfg = parseBmsConfig(template?.auto_bms);
  const images = Array.isArray(template?.images) ? template.images : [];
  if (images.length > 1) return { ok: false, reason: 'bms_not_ready', cfg };
  if (images.length === 1 && (!cfg.imageId || cfg.imageSig !== bmsImageSig(images[0]))) return { ok: false, reason: 'bms_not_ready', cfg };
  if (!images.length && cfg.imageId) return { ok: false, reason: 'bms_not_ready', cfg };
  if (bmsTextError(template?.body, images.length === 1)) return { ok: false, reason: 'bms_not_ready', cfg };
  return { ok: true, reason: '', cfg };
}
