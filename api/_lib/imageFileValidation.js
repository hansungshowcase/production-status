const FORMAT_DETAILS = {
  jpeg: { mimeType: 'image/jpeg', extensions: new Set(['jpg', 'jpeg']), mimeTypes: new Set(['image/jpeg', 'image/jpg']) },
  png: { mimeType: 'image/png', extensions: new Set(['png']), mimeTypes: new Set(['image/png']) },
  gif: { mimeType: 'image/gif', extensions: new Set(['gif']), mimeTypes: new Set(['image/gif']) },
  webp: { mimeType: 'image/webp', extensions: new Set(['webp']), mimeTypes: new Set(['image/webp']) },
  heic: { mimeType: 'image/heic', extensions: new Set(['heic']), mimeTypes: new Set(['image/heic']) },
  heif: { mimeType: 'image/heif', extensions: new Set(['heif']), mimeTypes: new Set(['image/heif']) },
};

const DEFAULT_ALLOWED_FORMATS = Object.freeze(Object.keys(FORMAT_DETAILS));
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['heif', 'mif1', 'msf1']);

export class ImageFileValidationError extends Error {
  constructor(message, { status = 400, code = 'invalid_image_file' } = {}) {
    super(message);
    this.name = 'ImageFileValidationError';
    this.status = status;
    this.code = code;
  }
}

function detectIsoBmffImageFormats(data) {
  if (data.length < 12 || data.toString('ascii', 4, 8) !== 'ftyp') return [];

  const limit = Math.min(data.length, 64);
  let hasHeicBrand = false;
  let hasHeifBrand = false;
  for (let offset = 8; offset + 4 <= limit; offset += 4) {
    const brand = data.toString('ascii', offset, offset + 4).toLowerCase();
    if (HEIC_BRANDS.has(brand)) hasHeicBrand = true;
    if (HEIF_BRANDS.has(brand)) hasHeifBrand = true;
  }
  return [hasHeicBrand && 'heic', hasHeifBrand && 'heif'].filter(Boolean);
}

function detectImageFormats(data) {
  if (!Buffer.isBuffer(data)) return [];
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ['jpeg'];
  if (data.length >= 8
    && data[0] === 0x89
    && data.toString('ascii', 1, 4) === 'PNG'
    && data[4] === 0x0d
    && data[5] === 0x0a
    && data[6] === 0x1a
    && data[7] === 0x0a) return ['png'];
  if (data.length >= 6) {
    const signature = data.toString('ascii', 0, 6);
    if (signature === 'GIF87a' || signature === 'GIF89a') return ['gif'];
  }
  if (data.length >= 12
    && data.toString('ascii', 0, 4) === 'RIFF'
    && data.toString('ascii', 8, 12) === 'WEBP') return ['webp'];
  return detectIsoBmffImageFormats(data);
}

export function detectImageFormat(data) {
  return detectImageFormats(data)[0] || null;
}

export function validateImageFile(filePart, options = {}) {
  const {
    allowedFormats = DEFAULT_ALLOWED_FORMATS,
    unsupportedStatus = 400,
    invalidMessage = '파일 내용이 올바른 이미지 형식이 아닙니다.',
    unsupportedMessage = '지원하지 않는 이미지 형식입니다.',
  } = options;

  const detectedFormats = detectImageFormats(filePart?.data);
  if (detectedFormats.length === 0) {
    throw new ImageFileValidationError(invalidMessage);
  }

  const filename = String(filePart?.filename || '');
  const extensionMatch = filename.match(/\.([^.]+)$/);
  const extension = extensionMatch?.[1]?.toLowerCase() || '';
  let matchingFormats = detectedFormats.filter((format) => FORMAT_DETAILS[format].extensions.has(extension));
  if (matchingFormats.length === 0) {
    throw new ImageFileValidationError(invalidMessage);
  }

  const declaredMimeType = String(filePart?.contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (declaredMimeType
    && declaredMimeType !== 'application/octet-stream') {
    matchingFormats = matchingFormats.filter((format) => FORMAT_DETAILS[format].mimeTypes.has(declaredMimeType));
    if (matchingFormats.length === 0) {
      throw new ImageFileValidationError(invalidMessage);
    }
  }

  const format = matchingFormats[0];
  const details = FORMAT_DETAILS[format];
  if (!new Set(allowedFormats).has(format)) {
    throw new ImageFileValidationError(unsupportedMessage, {
      status: unsupportedStatus,
      code: 'unsupported_image_format',
    });
  }

  return { format, mimeType: details.mimeType, extension };
}
