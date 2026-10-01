import { parseMaterialsCsv } from '../../src/utils/materials.js';

const MATERIALS_CSV_URL = 'https://docs.google.com/spreadsheets/d/1Lk7uF_rAh43UL5jpum7udQqKAMrHrC7qExkr3BgbQbM/export?format=csv&gid=0';
const MATERIALS_TIMEOUT_MS = 10_000;
const MATERIALS_CACHE_TTL_MS = 60_000;
export const MATERIALS_MAX_BYTES = 3 * 1024 * 1024;

export class MaterialsSourceError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'MaterialsSourceError';
    this.status = status;
    this.publicMessage = message;
  }
}

function sourceError(error) {
  if (error instanceof MaterialsSourceError) return error;
  if (error?.name === 'AbortError') {
    return new MaterialsSourceError('Google 시트 조회 시간이 초과되었습니다.', 504);
  }
  if (error instanceof Error && /CSV 형식|원본 시트/.test(error.message)) {
    return new MaterialsSourceError(error.message, 502);
  }
  return new MaterialsSourceError('Google 시트 자료를 불러오지 못했습니다.', 502);
}

function declaredLength(response) {
  const value = Number(response.headers?.get?.('content-length'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function readLimitedText(response, maxBytes, controller) {
  const length = declaredLength(response);
  if (length !== null && length > maxBytes) {
    controller.abort();
    throw new MaterialsSourceError('Google 시트 CSV가 크기 제한을 초과했습니다.', 413);
  }

  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      controller.abort();
      throw new MaterialsSourceError('Google 시트 CSV가 크기 제한을 초과했습니다.', 413);
    }
    return new TextDecoder().decode(bytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      controller.abort();
      throw new MaterialsSourceError('Google 시트 CSV가 크기 제한을 초과했습니다.', 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function looksLikeHtml(text) {
  const start = text.trimStart().slice(0, 512).toLocaleLowerCase('en-US');
  return start.startsWith('<!doctype html')
    || start.startsWith('<html')
    || start.includes('<form')
    || start.includes('accounts.google.com');
}

async function fetchMaterialsCsv({ fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new MaterialsSourceError('Google 시트 조회 시간이 초과되었습니다.', 504));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(MATERIALS_CSV_URL, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: 'text/csv' },
      }),
      timeout,
    ]);

    if (!response?.ok) {
      throw new MaterialsSourceError(`Google 시트 응답 오류 (${response?.status ?? 'unknown'})`, 502);
    }

    const contentType = String(response.headers?.get?.('content-type') ?? '').toLocaleLowerCase('en-US');
    if (contentType.includes('text/html')) {
      throw new MaterialsSourceError('Google 시트에서 CSV가 아닌 응답을 받았습니다.', 502);
    }

    const csv = await Promise.race([
      readLimitedText(response, maxBytes, controller),
      timeout,
    ]);
    if (looksLikeHtml(csv)) {
      throw new MaterialsSourceError('Google 시트에서 CSV가 아닌 응답을 받았습니다.', 502);
    }
    return csv;
  } catch (error) {
    throw sourceError(error);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createMaterialsDataSource({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = MATERIALS_TIMEOUT_MS,
  maxBytes = MATERIALS_MAX_BYTES,
  cacheTtlMs = MATERIALS_CACHE_TTL_MS,
} = {}) {
  let cached = null;
  let inFlight = null;

  const readFresh = async () => {
    const csv = await fetchMaterialsCsv({ fetchImpl, timeoutMs, maxBytes });
    let parsed;
    try {
      parsed = parseMaterialsCsv(csv);
    } catch (error) {
      throw sourceError(error);
    }

    const completedAt = now();
    const result = {
      fetched_at: new Date(completedAt).toISOString(),
      source: {
        title: '작업일보',
        tab: '문자전송',
      },
      orders: parsed.orders,
    };
    cached = { completedAt, result };
    return result;
  };

  return {
    async load({ refresh = false } = {}) {
      if (inFlight) return inFlight;
      if (!refresh && cached && now() - cached.completedAt <= cacheTtlMs) return cached.result;

      inFlight = readFresh();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}

const materialsDataSource = createMaterialsDataSource();

export function loadMaterialsData(options) {
  return materialsDataSource.load(options);
}
