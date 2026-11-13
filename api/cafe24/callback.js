// 카페24 앱 설치(OAuth) 콜백(설계 18절). 환경 변수가 없으면 503. 토큰·코드는 응답·로그에 남기지 않는다.
// 로그인 정책(cors 래퍼)을 거치지 않는다 — 카페24 가 사장님 브라우저를 돌려보내는 주소이며, state 서명으로 확인한다.
import { getDb } from '../_lib/db.js';
import { baseUrl, cafe24Env, cafe24LinkFresh, checkState, exchangeCode, makeState, stateNonce, timingSafeMatch } from '../_lib/cafe24.js';

// 보충 조회(customersprivacy)는 개인정보 읽기 권한이 있어야 한다 — 앱에 등록한 3개와 같게 요청한다(카페24 scope 는 쉼표로 잇는다).
const SCOPE = 'mall.read_customer,mall.read_personal,mall.read_privacy';
const COOKIE = 'cafe24_oauth';
// state 를 이 브라우저에 묶는 쿠키(10분). 값은 state 안의 난수이며 토큰·코드가 아니다.
const cookieLine = (value, maxAge) => `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/cafe24; Max-Age=${maxAge}`;
const readCookie = req => {
  const hit = String(req.headers?.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`));
  return hit ? hit.slice(COOKIE.length + 1) : '';
};

export async function handleCafe24Callback(req, res, dependencies = {}) {
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  const env = dependencies.env || process.env;
  const config = cafe24Env(env);
  if (!config) return res.status(503).json({ error: { message: '연결되지 않았습니다.', status: 503 } });
  const nowMs = dependencies.nowMs ?? Date.now();
  const query = req.query || {};
  const code = typeof query.code === 'string' ? query.code : '';
  if (!code) {
    const db = dependencies.db || getDb();
    if (await cafe24LinkFresh(db, nowMs)) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.status(200).send('이미 연결됨'); }
    const state = makeState(config, nowMs);
    res.setHeader('Set-Cookie', cookieLine(stateNonce(state), 600));
    const params = new URLSearchParams({ response_type: 'code', client_id: config.clientId, state, redirect_uri: `${baseUrl(env)}/api/cafe24/callback`, scope: SCOPE });
    res.setHeader('Location', `https://${config.mallId}.cafe24api.com/api/v2/oauth/authorize?${params.toString()}`);
    return res.status(302).end();
  }
  const cookieNonce = readCookie(req);
  if (!checkState(config, query.state, nowMs) || !cookieNonce || !timingSafeMatch(cookieNonce, stateNonce(query.state))) {
    res.setHeader('Set-Cookie', cookieLine('', 0));
    return res.status(400).json({ error: { message: '요청을 확인할 수 없습니다. 처음부터 다시 시도해 주세요.', status: 400 } });
  }
  res.setHeader('Set-Cookie', cookieLine('', 0));
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
