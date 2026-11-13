// 카페24 앱 설치(OAuth) 콜백(설계 18절). 환경 변수가 없으면 503. 토큰·코드는 응답·로그에 남기지 않는다.
// 로그인 정책(cors 래퍼)을 거치지 않는다 — 카페24 가 사장님 브라우저를 돌려보내는 주소이며, state 서명으로 확인한다.
import { getDb } from '../_lib/db.js';
import { baseUrl, cafe24Env, checkState, exchangeCode, makeState } from '../_lib/cafe24.js';

const SCOPE = 'mall.read_customer';

export async function handleCafe24Callback(req, res, dependencies = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  const env = dependencies.env || process.env;
  const config = cafe24Env(env);
  if (!config) return res.status(503).json({ error: { message: '연결되지 않았습니다.', status: 503 } });
  const nowMs = dependencies.nowMs ?? Date.now();
  const query = req.query || {};
  const code = typeof query.code === 'string' ? query.code : '';
  if (!code) {
    const params = new URLSearchParams({ response_type: 'code', client_id: config.clientId, state: makeState(config, nowMs), redirect_uri: `${baseUrl(env)}/api/cafe24/callback`, scope: SCOPE });
    res.setHeader('Location', `https://${config.mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`);
    return res.status(302).end();
  }
  if (!checkState(config, query.state, nowMs)) return res.status(400).json({ error: { message: '요청을 확인할 수 없습니다. 처음부터 다시 시도해 주세요.', status: 400 } });
  try {
    await exchangeCode(dependencies.db || getDb(), { env, code, fetchImpl: dependencies.fetchImpl || fetch, nowMs });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send('카페24 연결 완료');
  } catch {
    (dependencies.warn || console.warn)('[cafe24-callback] 연결 실패');
    return res.status(502).json({ error: { message: '카페24 연결에 실패했습니다.', status: 502 } });
  }
}

export default handleCafe24Callback;
