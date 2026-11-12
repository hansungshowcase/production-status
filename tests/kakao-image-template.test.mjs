import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSmsConsole, _resetConsoleCacheForTest, imageSize } from '../api/sms-console.js';
import { getSendProvider } from '../api/_lib/sendProvider.js';
import { validateTemplateInput } from '../shared/smsConsole.js';
import {
  bannerCrop, emptyFormValues, formValuesFromTemplate, toValidationInput, previewTemplate, missingFieldsText,
} from '../src/components/smsconsole/templateFormModel.js';

const T1 = { kind: 'channel', id: 'KA01', name: '한성 채널' };

function png(width, height, pad = 0) {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8); head.write('IHDR', 12, 'ascii');
  head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(pad)]);
}
const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const request = body => ({
  method: 'POST', body, query: {}, url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' },
  headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' },
});
function deps(uploads, over = {}) {
  return {
    kakao: { clearTemplateCache() {} }, guard: { writeStatus: async () => ({ enabled: true }) }, rateLimitCheck: () => true,
    hasCredentials: () => true, nowMs: Date.now(),
    sendProvider: { async uploadImage(input) { uploads.push(input); return { fileId: 'FILE-K1' }; } },
    ...over,
  };
}
const run = async (body, d) => { _resetConsoleCacheForTest(); const res = response(); await handleSmsConsole(request(body), res, d); return res; };

test('imageSize: PNG 머리에서 가로·세로를 읽는다', () => {
  assert.deepEqual(imageSize(png(800, 400)), { width: 800, height: 400, type: 'png' });
  assert.equal(imageSize(Buffer.from('hello world, not an image at all')), null);
});

test('kakao_image_upload: 2:1 이미지는 type ATA 로 올려 imageId 를 돌려준다', async () => {
  const uploads = [];
  const res = await run({ action: 'kakao_image_upload', image: { data: png(800, 400, 1000).toString('base64') } }, deps(uploads));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { imageId: 'FILE-K1' });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, 'ATA');
});

test('kakao_image_upload: 용량·비율·가로·형식 거절은 올리지 않는다', async () => {
  const uploads = [];
  const cases = [
    png(800, 400, 520 * 1024),
    png(800, 600, 100),
    png(400, 200, 100),
    Buffer.from('plain text file content that is not an image'),
  ];
  for (const buf of cases) {
    const res = await run({ action: 'kakao_image_upload', image: { data: buf.toString('base64') } }, deps(uploads));
    assert.equal(res.statusCode, 400);
  }
  const empty = await run({ action: 'kakao_image_upload' }, deps(uploads));
  assert.equal(empty.statusCode, 400);
  assert.equal(uploads.length, 0);
});

test('kakao_image_upload: 쓰기 꺼짐이면 거절', async () => {
  const uploads = [];
  const res = await run({ action: 'kakao_image_upload', image: { data: png(800, 400).toString('base64') } },
    deps(uploads, { guard: { writeStatus: async () => ({ enabled: false }) } }));
  assert.equal(res.statusCode, 503);
  assert.equal(uploads.length, 0);
});

test('uploadImage: type 을 안 주면 MMS(기존 그대로), ATA 를 주면 ATA', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ fileId: 'F1' }) }; };
    const provider = getSendProvider('solapi');
    await provider.uploadImage({ base64: 'AAAA', name: 'a.jpg' }, { fetchImpl });
    await provider.uploadImage({ base64: 'AAAA', name: 'a.jpg', type: 'ATA' }, { fetchImpl });
    assert.equal(seen[0].type, 'MMS');
    assert.equal(seen[1].type, 'ATA');
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});

test('양식: 이미지형 값이 검증 입력·미리보기까지 가고, 수정 때 imageId 가 유지된다', () => {
  const form = { ...emptyFormValues([T1]), name: '시험', content: '내용', emphasizeType: 'IMAGE', imageId: 'F1', imageUrl: 'blob:x' };
  const ok = validateTemplateInput(toValidationInput(form));
  assert.equal(ok.ok, true);
  assert.equal(ok.value.imageId, 'F1');
  assert.equal(previewTemplate(form, [T1]).imageUrl, 'blob:x');
  const back = formValuesFromTemplate({ name: 'a', content: 'b', target: T1, emphasizeType: 'IMAGE', imageId: 'F9', imageUrl: 'https://x/y.jpg' });
  assert.equal(back.emphasizeType, 'IMAGE');
  assert.equal(validateTemplateInput(toValidationInput(back), { requireTarget: false }).value.imageId, 'F9');
  const none = validateTemplateInput(toValidationInput({ ...form, imageId: '' }));
  assert.equal(none.ok, false);
  assert.match(missingFieldsText(none.errors), /이미지를 넣어 주세요/);
  const plain = toValidationInput({ ...form, emphasizeType: 'NONE' });
  assert.equal(plain.imageId, '');
  assert.equal(previewTemplate({ ...form, emphasizeType: 'NONE' }, [T1]).imageUrl, '');
});

test('bannerCrop: 가운데 기준 2:1', () => {
  assert.deepEqual(bannerCrop(1000, 500), { sx: 0, sy: 0, sw: 1000, sh: 500 });
  assert.deepEqual(bannerCrop(1000, 1000), { sx: 0, sy: 250, sw: 1000, sh: 500 });
  assert.deepEqual(bannerCrop(2000, 500), { sx: 500, sy: 0, sw: 1000, sh: 500 });
  assert.deepEqual(bannerCrop(0, 10), { sx: 0, sy: 0, sw: 0, sh: 0 });
});
