import assert from 'node:assert/strict';
import test from 'node:test';

import { validateImageFile } from '../api/_lib/imageFileValidation.js';
import { storeImageFile } from '../api/_lib/storeImage.js';
import ocrHandler, { validateOcrImageFile } from '../api/ocr/work-order.js';
import { handlePost as handlePhotoPost } from '../api/photos/index.js';

const fixtures = {
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: Buffer.from('GIF89a', 'ascii'),
  webp: Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]),
  heic: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'ascii')]),
  heif: Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmif1', 'ascii')]),
};

test('image validation detects each allowed signature and canonical MIME', () => {
  for (const [format, data] of Object.entries(fixtures)) {
    const extension = format === 'jpeg' ? 'jpg' : format;
    const mimeType = format === 'jpeg' ? 'image/jpg' : `image/${format}`;
    const result = validateImageFile({ filename: `fixture.${extension}`, contentType: mimeType, data });
    assert.equal(result.format, format);
    assert.equal(result.mimeType, format === 'jpeg' ? 'image/jpeg' : `image/${format}`);
  }
});

test('HEIC-compatible brand takes precedence over a generic HEIF major brand', () => {
  const data = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from('ftypmif1', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('heic', 'ascii'),
  ]);
  const result = validateImageFile({ filename: 'fixture.heic', contentType: 'image/heic', data });
  assert.equal(result.format, 'heic');
});

test('a dual-brand HEIF container accepts its declared HEIF alias and MIME', async () => {
  const data = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('mif1heic', 'ascii'),
  ]);
  const filePart = { filename: 'fixture.heif', contentType: 'image/heif', data };

  const result = validateImageFile(filePart);
  assert.equal(result.format, 'heif');
  assert.equal(result.mimeType, 'image/heif');

  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const stored = await storeImageFile(filePart, 'fixture.heif');
    assert.match(stored.url, /^data:image\/heif;base64,/);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
  }
});

test('dual-brand aliases stay strict without widening HEIF, HIF, or OCR support', () => {
  const dualBrandData = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypheic', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('mif1heic', 'ascii'),
  ]);
  const heic = validateImageFile({ filename: 'fixture.heic', contentType: 'image/heic', data: dualBrandData });
  assert.deepEqual(heic, { format: 'heic', mimeType: 'image/heic', extension: 'heic' });

  for (const filePart of [
    { filename: 'fixture.heif', contentType: 'image/heic', data: dualBrandData },
    { filename: 'fixture.hif', contentType: 'image/heif', data: dualBrandData },
    { filename: 'fixture.heic', contentType: 'image/heic', data: fixtures.heif },
  ]) {
    assert.throws(
      () => validateImageFile(filePart),
      (error) => error.status === 400 && error.code === 'invalid_image_file',
    );
  }

  assert.throws(
    () => validateOcrImageFile({ filename: 'fixture.heif', contentType: 'image/heif', data: dualBrandData }),
    (error) => error.status === 415 && error.code === 'unsupported_image_format',
  );
});

test('image validation rejects empty, truncated, random, and mismatched input', () => {
  for (const filePart of [
    { filename: 'empty.jpg', contentType: 'image/jpeg', data: Buffer.alloc(0) },
    { filename: 'short.png', contentType: 'image/png', data: fixtures.png.subarray(0, 4) },
    { filename: 'text.jpg', contentType: 'image/jpeg', data: Buffer.from('not-an-image') },
    { filename: 'wrong.png', contentType: 'image/png', data: fixtures.jpeg },
    { filename: 'wrong.jpg', contentType: 'image/png', data: fixtures.png },
  ]) {
    assert.throws(
      () => validateImageFile(filePart),
      (error) => error.status === 400 && error.code === 'invalid_image_file',
    );
  }
});

test('octet-stream input uses the detected image MIME when the extension matches', async () => {
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const stored = await storeImageFile({
      filename: 'fixture.jpeg',
      contentType: 'application/octet-stream',
      data: fixtures.jpeg,
    }, 'fixture.jpeg');
    assert.match(stored.url, /^data:image\/jpeg;base64,/);

    const storedHeic = await storeImageFile({
      filename: 'fixture.heic',
      contentType: 'image/heic',
      data: fixtures.heic,
    }, 'fixture.heic');
    assert.match(storedHeic.url, /^data:image\/heic;base64,/);
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
  }
});

test('fallback storage keeps the existing 1.5MB size error ahead of signature validation', async () => {
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    await assert.rejects(
      () => storeImageFile({
        filename: 'oversize.jpg',
        contentType: 'image/jpeg',
        data: Buffer.alloc((1536 * 1024) + 1),
      }, 'oversize.jpg'),
      (error) => error.status === 413,
    );
  } finally {
    if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = previousToken;
  }
});

test('photo upload rejects fake bytes before DB or storage and allows supported signatures to the DB boundary', async () => {
  const createResponse = () => ({
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
  });
  const makeParts = (filename, contentType, data) => [
    { name: 'order_id', filename: null, data: Buffer.from('1') },
    { name: 'photo', filename, contentType, data },
  ];
  let dbCalls = 0;
  let storageCalls = 0;
  const dependencies = (parts) => ({
    parseMultipart: async () => parts,
    authorizePhotoUpload: () => true,
    db: { async execute() { dbCalls += 1; return { rows: [] }; } },
    storeImageFile: async () => { storageCalls += 1; return { url: 'unused', rollbackUrl: null }; },
  });

  const invalidRes = createResponse();
  await handlePhotoPost(
    { headers: {} },
    invalidRes,
    dependencies(makeParts('fixture.jpg', 'image/jpeg', Buffer.from('not-an-image'))),
  );
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(dbCalls, 0);
  assert.equal(storageCalls, 0);

  for (const format of ['jpeg', 'png', 'gif', 'webp']) {
    const extension = format === 'jpeg' ? 'jpg' : format;
    const mimeType = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
    const validRes = createResponse();
    await handlePhotoPost(
      { headers: {} },
      validRes,
      dependencies(makeParts(`fixture.${extension}`, mimeType, fixtures[format])),
    );
    assert.equal(validRes.statusCode, 404);
  }
  assert.equal(dbCalls, 4);
  assert.equal(storageCalls, 0);
});

test('unsupported real image formats can retain caller-owned 415 semantics', () => {
  assert.throws(
    () => validateOcrImageFile({ filename: 'fixture.heic', contentType: 'image/heic', data: fixtures.heic }),
    (error) => error.status === 415 && error.code === 'unsupported_image_format',
  );
});

test('OCR rejects fake image bytes before API configuration or provider calls', async () => {
  const boundary = 'image-test-boundary';
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="image"; filename="fixture.jpg"',
    'Content-Type: image/jpeg',
    '',
    'not-an-image',
    `--${boundary}--`,
    '',
  ].join('\r\n'));
  const req = {
    method: 'POST',
    url: '/api/ocr/work-order',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  };
  const res = {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
  };
  const previousFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => {
    providerCalls += 1;
    throw new Error('provider should not be called');
  };
  try {
    await ocrHandler(req, res);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.status, 400);
  assert.equal(providerCalls, 0);
});
