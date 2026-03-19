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

function isRetryable(err) {
  return !(err instanceof ApiError) || err.status === 0;
}

async function request(endpoint, options = {}, _retryCount = 0) {
  const { body, method = 'GET', headers: customHeaders = {} } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  const config = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...customHeaders,
    },
    signal: controller.signal,
  };

  if (body) {
    config.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, config);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const message = errorData?.error?.message || `요청 실패 (${response.status})`;
      throw new ApiError(message, response.status, errorData);
    }

    return await response.json();
  } catch (err) {
    if (err instanceof ApiError) {
      if (_retryCount < 1 && isRetryable(err)) {
        return request(endpoint, options, _retryCount + 1);
      }
      throw err;
    }

    if (err.name === 'AbortError') {
      const timeoutErr = new ApiError('요청 시간이 초과되었습니다.', 0, null);
      if (_retryCount < 1) {
        return request(endpoint, options, _retryCount + 1);
      }
      throw timeoutErr;
    }

    const networkErr = new ApiError('서버에 연결할 수 없습니다. 네트워크를 확인해주세요.', 0, null);
    if (_retryCount < 1) {
      return request(endpoint, options, _retryCount + 1);
    }
    throw networkErr;
  } finally {
    clearTimeout(timeoutId);
  }
}

export { ApiError };
export default request;
