import { cors } from '../_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  return res.json({
    enabled: false,
    lastSync: null,
    recentSyncs: [],
    message: 'Google Sheets 동기화 모듈이 비활성화 상태입니다.',
  });
});
