import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listTemplates, listDirectory, scopeOf, getTemplateFresh, createTemplate, updateTemplate,
  SolapiKakaoError, _resetKakaoCachesForTest, getBalance, listCategories,
} from '../api/_lib/kakaoTemplates.js';

process.env.SOLAPI_API_KEY = 'testkey';
process.env.SOLAPI_API_SECRET = 'testsecret';

beforeEach(() => {
  _resetKakaoCachesForTest();
  delete process.env.SMS_CONSOLE_KAKAO_IDS;
});

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

function makeFetch({ groups = 404, templates, calls = [] } = {}) {
  const fn = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname === '/kakao/v2/channels') {
      return json(200, { channelList: [
        { channelId: 'CH_HS', searchId: '@한성쇼케이스', accountId: 'ACC1' },
        { channelId: 'CH_SAFE', searchId: '@세이프마케팅', accountId: 'ACC1' },
      ] });
    }
    if (u.pathname === '/kakao/v2/channel-groups') {
      if (groups === 404) return json(404, { errorMessage: 'not found' });
      return json(200, { channelGroupList: groups });
    }
    if (u.pathname === '/kakao/v2/templates' && (init.method || 'GET') === 'GET') {
      return json(200, { templateList: templates });
    }
    return json(200, { templateId: 'T9' });
  };
  fn.calls = calls;
  return fn;
}

const tpl = (id, extra = {}) => ({
  templateId: id, name: `이름${id}`, channelId: 'CH_HS', content: '안녕 #{이름}', status: 'APPROVED',
  accountId: 'ACC1', memberId: 'MEM1', isHidden: false, messageType: 'BA', emphasizeType: 'NONE',
  buttons: [], comments: [{ content: '의견', memberId: 'MEM2', isAdmin: true, dateCreated: 'd' }],
  dateCreated: '2026-01-01', dateUpdated: '2026-01-02', ...extra,
});

test('세이프 채널·숨김 제외, 그룹 404 여도 한성 채널 템플릿 보임, 내부 ID 미노출', async () => {
  const fetchImpl = makeFetch({ templates: [
    tpl('A'), tpl('B', { channelId: 'CH_SAFE' }), tpl('C', { isHidden: true }),
    tpl('D', { channelId: undefined, channelGroupId: 'G1' }),
  ] });
  const result = await listTemplates({ fetchImpl, nowMs: 1000 });
  assert.deepEqual(result.items.map(i => i.id), ['A']);
  assert.equal(result.unresolved_groups, 1);
  assert.deepEqual(result.counts, { total: 1, APPROVED: 1, INSPECTING: 0, PENDING: 0, REJECTED: 0 });
  assert.deepEqual(result.targets, [{ kind: 'channel', id: 'CH_HS', name: '한성쇼케이스' }]);
  const text = JSON.stringify(result);
  assert.ok(!text.includes('ACC1') && !text.includes('MEM1') && !text.includes('MEM2'));
  assert.equal(result.items[0].comments[0].content, '의견');
  assert.deepEqual(result.items[0].variables, ['이름']);
});

test('그룹: 이름이 한성이면 허용, 이름 못 얻으면 불허, 환경값이 우선', async () => {
  const groups = [{ channelGroupId: 'G1', name: '한성 그룹' }];
  const directory = await listDirectory({ fetchImpl: makeFetch({ groups }), nowMs: 1 });
  assert.equal(directory.groupsResolved, true);
  assert.equal(scopeOf({ channelGroupId: 'G1' }, directory, []).allowed, true);
  assert.equal(scopeOf({ channelGroupId: 'G2' }, directory, []).allowed, false);
  assert.equal(scopeOf({ channelId: 'CH_SAFE' }, directory, []).allowed, false);
  // 환경값이 있으면 그것만
  assert.equal(scopeOf({ channelId: 'CH_SAFE' }, directory, ['CH_SAFE']).allowed, true);
  assert.equal(scopeOf({ channelId: 'CH_HS' }, directory, ['CH_SAFE']).allowed, false);
  assert.equal(scopeOf({ channelGroupId: 'G2' }, directory, ['G2']).allowed, true);
});

test('템플릿 캐시 60초', async () => {
  const fetchImpl = makeFetch({ templates: [tpl('A')] });
  const count = () => fetchImpl.calls.filter(c => c.path === '/kakao/v2/templates').length;
  await listTemplates({ fetchImpl, nowMs: 0 });
  assert.equal(count(), 1);
  await listTemplates({ fetchImpl, nowMs: 59_000 });
  assert.equal(count(), 1);
  await listTemplates({ fetchImpl, nowMs: 61_000 });
  assert.equal(count(), 2);
  // fresh 면 60초 안이어도 새로 받는다(서버가 여러 대라 다른 서버에서 등록·삭제한 뒤 옛 목록을 주지 않게)
  await listTemplates({ fetchImpl, nowMs: 62_000, fresh: true });
  assert.equal(count(), 3);
});

test('쏠라피 500 → SolapiKakaoError 502, 4xx 는 상태 유지·문구 정리', async () => {
  const fail500 = async () => json(500, { errorMessage: 'boom' });
  await assert.rejects(() => listTemplates({ fetchImpl: fail500, nowMs: 0 }), error => {
    assert.ok(error instanceof SolapiKakaoError);
    assert.equal(error.status, 502);
    assert.equal(error.publicMessage, '쏠라피에서 불러오지 못했습니다');
    return true;
  });
  const net = async () => { throw new Error('network'); };
  await assert.rejects(() => getTemplateFresh('X', { fetchImpl: net }), error => error.status === 502);
  const fail400 = async () => json(400, { errorMessage: '잘못됨\n줄 https://x.example/a ' + 'k'.repeat(40) });
  await assert.rejects(() => createTemplate({ name: 'n', content: 'c', target: { kind: 'channel', id: 'CH_HS' } }, { fetchImpl: fail400 }), error => {
    assert.equal(error.status, 400);
    assert.equal(error.publicMessage, '잘못됨 줄');
    return true;
  });
});

test('create 본문은 channelId/channelGroupId 중 하나만, update 본문엔 채널 칸 없음', async () => {
  const fetchImpl = makeFetch({ templates: [] });
  const base = { name: 'n', content: 'c', categoryCode: '999999', messageType: 'BA', emphasizeType: 'NONE', buttons: [] };
  await createTemplate({ ...base, target: { kind: 'group', id: 'G1' } }, { fetchImpl });
  await createTemplate({ ...base, target: { kind: 'channel', id: 'CH_HS' } }, { fetchImpl });
  await updateTemplate('T1', { ...base, target: { kind: 'channel', id: 'CH_HS' } }, { fetchImpl });
  const [g, c, u] = fetchImpl.calls;
  assert.equal(g.method, 'POST');
  assert.deepEqual([g.body.channelGroupId, g.body.channelId], ['G1', undefined]);
  assert.deepEqual([c.body.channelGroupId, c.body.channelId], [undefined, 'CH_HS']);
  assert.equal(u.method, 'PUT');
  assert.ok(!('channelId' in u.body) && !('channelGroupId' in u.body));
});

test('getTemplateFresh: 404 면 null, 있으면 범위 포함, 캐시 안 씀', async () => {
  const fetchImpl = async (url) => {
    const p = new URL(String(url)).pathname;
    if (p === '/kakao/v2/templates/NONE') return json(404, { errorMessage: 'x' });
    if (p === '/kakao/v2/channels') return json(200, { channelList: [{ channelId: 'CH_HS', searchId: '@한성' }] });
    if (p === '/kakao/v2/channel-groups') return json(404, {});
    return json(200, tpl('A'));
  };
  assert.equal(await getTemplateFresh('NONE', { fetchImpl }), null);
  const found = await getTemplateFresh('A', { fetchImpl });
  assert.equal(found.scope.allowed, true);
  assert.equal(found.template.id, 'A');
});

test('잔액·분류', async () => {
  let n = 0;
  const fetchImpl = async (url) => {
    n += 1;
    const p = new URL(String(url)).pathname;
    if (p === '/cash/v1/balance') return json(200, { balance: 9679, point: 0 });
    return json(200, [{ code: '001', name: '배송', categories: [{ code: '001001', name: '배송안내' }] }]);
  };
  assert.equal(await getBalance({ fetchImpl, nowMs: 0 }), 9679);
  assert.equal(await getBalance({ fetchImpl, nowMs: 1000 }), 9679);
  assert.equal(n, 1);
  const cats = await listCategories({ fetchImpl, nowMs: 0 });
  assert.deepEqual(cats.map(c => c.code), ['001', '001001']);
});
