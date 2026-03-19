export function cors(handler) {
  return async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    try {
      return await handler(req, res);
    } catch (err) {
      console.error(`[API Error] ${req.method} ${req.url}:`, err);
      const status = err.status || 500;
      const message = status === 500 ? '서버 내부 오류가 발생했습니다.' : (err.message || '요청 처리 중 오류가 발생했습니다.');
      if (!res.headersSent) {
        return res.status(status).json({ error: { message, status } });
      }
    }
  };
}
