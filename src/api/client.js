import { getToken, clearToken } from '../utils/authClient';
import { parseResponseBody, shouldRetryRequest } from './clientCore';

const BASE_URL = '/api';

const REQUEST_TIMEOUT = 15000;

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request(endpoint, options = {}, _retryCount = 0) {
  const { body, method = 'GET', headers: customHeaders = {}, cache } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  const isFormData = body instanceof FormData;
  const token = getToken();

  const config = {
    method,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...customHeaders,
    },
    ...(cache ? { cache } : {}),
    signal: controller.signal,
  };

  if (body) {
    config.body = isFormData ? body : JSON.stringify(body);
  }

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, config);

    if (!response.ok) {
      const errorData = await parseResponseBody(response).catch(() => ({})) || {};
      const message = errorData?.error?.message || `요청 실패 (${response.status})`;
      // 401: 토큰 만료/무효 → 클리어해서 다음 진입 시 재로그인
      if (response.status === 401) clearToken();
      throw new ApiError(message, response.status, errorData);
    }

    return await parseResponseBody(response);
  } catch (err) {
    if (err instanceof ApiError) {
      if (shouldRetryRequest({ method, status: err.status, retryCount: _retryCount })) {
        return request(endpoint, options, _retryCount + 1);
      }
      throw err;
    }

    if (err.name === 'AbortError') {
      const timeoutErr = new ApiError('요청 시간이 초과되었습니다.', 0, null);
      if (shouldRetryRequest({ method, status: timeoutErr.status, retryCount: _retryCount })) {
        return request(endpoint, options, _retryCount + 1);
      }
      throw timeoutErr;
    }

    const networkErr = new ApiError('서버에 연결할 수 없습니다. 네트워크를 확인해주세요.', 0, null);
    if (shouldRetryRequest({ method, status: networkErr.status, retryCount: _retryCount })) {
      return request(endpoint, options, _retryCount + 1);
    }
    throw networkErr;
  } finally {
    clearTimeout(timeoutId);
  }
}

export { ApiError };
export default request;
