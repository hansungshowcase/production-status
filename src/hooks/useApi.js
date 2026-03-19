import { useState, useEffect, useCallback } from 'react';

export default function useApi(apiFn, { immediate = true, params = [] } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState(null);

  const execute = useCallback(
    async (...args) => {
      setLoading(true);
      setError(null);
      try {
        const result = await apiFn(...args);
        setData(result);
        return result;
      } catch (err) {
        setError(err.message || '알 수 없는 오류가 발생했습니다.');
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [apiFn]
  );

  useEffect(() => {
    if (immediate) {
      execute(...params).catch(() => {});
    }
  }, []);

  return { data, loading, error, execute, setData };
}
