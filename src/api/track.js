// 고객용 공개 조회 API — 인증 헤더 없이 호출 (토큰이 곧 자격증명)
// src/api/client.js 의 fetch 패턴을 따르되, Authorization 첨부/401 토큰 클리어를 하지 않는다.

const BASE_URL = '/api';
const REQUEST_TIMEOUT = 15000;

export class TrackApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TrackApiError';
    this.status = status;
  }
}

export async function getTrackInfo(token, _retryCount = 0) {
  if (!token) throw new TrackApiError('조회 토큰이 필요합니다', 0);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${BASE_URL}/track/${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = errorData?.error?.message || `요청 실패 (${response.status})`;
      throw new TrackApiError(message, response.status);
    }

    return await response.json();
  } catch (err) {
    if (err instanceof TrackApiError) throw err;

    // 타임아웃/네트워크 오류는 1회 재시도
    if (_retryCount < 1) {
      return getTrackInfo(token, _retryCount + 1);
    }
    if (err.name === 'AbortError') {
      throw new TrackApiError('요청 시간이 초과되었습니다.', 0);
    }
    throw new TrackApiError('서버에 연결할 수 없습니다. 네트워크를 확인해주세요.', 0);
  } finally {
    clearTimeout(timeoutId);
  }
}
