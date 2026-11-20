import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  DEFAULT_SHOWCASE_SETTING,
  SHOWCASE_GUIDE_BRAND,
  SHOWCASE_GUIDE_PRESETS,
  SHOWCASE_REVIEW_EVENTS,
  buildGuideUrl,
  calculateWarrantyEndDate,
  getGuidePresetByKey,
  resolveGuidePresetKey,
} from '../shared/showcaseGuide.js';
import { generateQrSvg } from '../src/utils/qrSvg.js';
import {
  DEFAULT_LABEL_SIZE_KEY,
  LABEL_SIZES,
  buildShippingLabelData,
  buildShippingLabelPrintHtml,
} from '../src/components/sales/shippingLabels.js';
import { handleTrack } from '../api/track/[token].js';
import { handleTrackLink } from '../api/orders/[id]/track-link.js';

const sampleOrder = {
  id: 42,
  order_date: '2026-11-20',
  ship_date: '2026-11-21',
  client_name: '테스트 베이커리 <본점>',
  product_type: '알앤에프냉동덧방',
  door_type: '앞문',
  width: 1200,
  depth: 600,
  height: 900,
  quantity: 2,
  color: '올스텐',
  sales_person: '이준형',
  status: 'shipped',
};

test('resolveGuidePresetKey는 공식 10종만 매핑하고 내부 품명은 null로 가린다', () => {
  assert.equal(SHOWCASE_GUIDE_PRESETS.length, 10);
  assert.equal(resolveGuidePresetKey('제과', '앞문'), 'bakery');
  assert.equal(resolveGuidePresetKey('음료', '여닫이'), 'beverage');
  assert.equal(resolveGuidePresetKey('주류', '앞문'), 'beverage');
  assert.equal(resolveGuidePresetKey('와인', '여닫이'), 'wine');
  assert.equal(resolveGuidePresetKey('꽃', '앞문'), 'flower');
  assert.equal(resolveGuidePresetKey('진열', '오픈'), 'open');
  assert.equal(resolveGuidePresetKey('마카롱', '뒷문'), 'macaron');
  assert.equal(resolveGuidePresetKey('회진열', '앞문'), 'sashimi');
  assert.equal(resolveGuidePresetKey('양념육', '앞문'), 'butcher');
  assert.equal(resolveGuidePresetKey('반찬', '앞문'), 'banchan');
  assert.equal(resolveGuidePresetKey('상부쿨러 하부콤프 정육', '앞문'), 'top_butcher');

  // 내부 거래처·분류 표기는 절대 프리셋 키로 노출하지 않는다
  assert.equal(resolveGuidePresetKey('알앤에프냉동덧방', '앞문'), null);
  assert.equal(resolveGuidePresetKey('진열', '앞문'), null);
  assert.equal(getGuidePresetByKey('unknown'), null);
});

test('calculateWarrantyEndDate는 12개월 만료일과 윤년을 정확히 계산한다', () => {
  assert.equal(calculateWarrantyEndDate('2026-11-20'), '2027-11-20');
  assert.equal(calculateWarrantyEndDate('2024-02-29'), '2025-02-28');
  assert.equal(calculateWarrantyEndDate('2026-02-30'), null);
  assert.equal(calculateWarrantyEndDate(''), null);
});

test('generateQrSvg는 203dpi 흑백 감열 인쇄용 crispEdges SVG를 생성한다', () => {
  const url = buildGuideUrl('https://production-status.vercel.app', 'Token_1234567890', 'bakery');
  const genericUrl = buildGuideUrl('https://production-status.vercel.app', '', 'bakery');
  const bareGenericUrl = buildGuideUrl('https://production-status.vercel.app', '');
  const svg = generateQrSvg(url, { size: '25mm', margin: 2 });

  assert.equal(url, 'https://production-status.vercel.app/guide/Token_1234567890?p=bakery');
  assert.equal(genericUrl, 'https://production-status.vercel.app/guide?p=bakery');
  assert.equal(bareGenericUrl, 'https://production-status.vercel.app/guide');
  assert.match(svg, /^<svg[^>]*shape-rendering="crispEdges"/);
  assert.match(svg, /<rect[^>]*fill="#FFFFFF"/);
  assert.match(svg, /<path fill="#000000" d="M/);
  assert.throws(() => generateQrSvg(''));
});

test('buildShippingLabelData와 buildShippingLabelPrintHtml은 명함 4장 기본 규격·전체 내용·출고일자·제거금지·XSS 차단을 지킨다', () => {
  const xssOrder = {
    ...sampleOrder,
    door_type: '앞문<script>alert(1)</script>',
  };

  assert.equal(DEFAULT_LABEL_SIZE_KEY, '180x100');
  const defaultPlate = buildShippingLabelData(xssOrder, {
    presetKey: 'bakery',
    shipDate: '2026-11-21',
    copies: 2,
    token: 'AbCdEfGhIj1234567890',
  });
  const plateHtml = buildShippingLabelPrintHtml(defaultPlate);

  assert.equal(defaultPlate.size.key, '180x100');
  assert.equal(defaultPlate.size.widthMm, 180);
  assert.equal(defaultPlate.size.heightMm, 100);
  assert.match(plateHtml, /@page \{ size: 180mm 100mm; margin: 0; \}/);
  assert.equal((plateHtml.match(/class="plate-sheet/g) || []).length, 2);
  for (const requiredText of [
    '절대 제거·훼손 금지',
    '임의 제거 금지',
    '출고일자',
    '2026.11.21',
    '12개월 (~2027.11.21)',
    '반드시 단독 코드',
    '2~3시간',
    '별도 보관',
    '15~20cm',
    '냉장 전용',
    '물받이통',
    '전원',
    '조명',
    '결로팬',
    '잠금',
    '제상주기',
    '제상시간',
    'def',
    '라지에이터',
    '월 1회',
    '장갑',
    '위·아래',
    '유상 처리',
    '카카오톡 A/S',
  ]) {
    assert.ok(plateHtml.includes(requiredText), `180x100 인쇄 HTML에 '${requiredText}'가 빠졌습니다.`);
  }
  assert.doesNotMatch(plateHtml, /031-986-2458/);
  for (const reviewHint of ['최대 14만원', '블로그', '인스타', '구글']) {
    assert.ok(plateHtml.includes(reviewHint), `180x100 인쇄 HTML에 리뷰 키워드 '${reviewHint}'가 빠졌습니다.`);
  }
  assert.match(plateHtml, /<svg[^>]*shape-rendering="crispEdges"/);
  assert.match(plateHtml, /id="g1-0"/);
  assert.match(plateHtml, /id="g1-1"/);
  assert.match(plateHtml, /제과\(5℃ · 제상 3시간 \/ 15분\) 유지/);
  assert.doesNotMatch(plateHtml, /알앤에프냉동덧방/);
  assert.doesNotMatch(plateHtml, /<script>alert\(1\)<\/script>/);
  assert.match(plateHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const butcherPlate = buildShippingLabelData(xssOrder, {
    presetKey: 'butcher',
    shipDate: '2026-11-21',
    copies: 1,
    token: 'AbCdEfGhIj1234567890',
  });
  const butcherHtml = buildShippingLabelPrintHtml(butcherPlate);
  assert.match(butcherHtml, /정육\(-2℃ · 제상 3시간 \/ 10분\) 유지/);
  assert.doesNotMatch(butcherHtml, /기본세팅\(5℃\/2시간\/15분\) 유지/);

  for (const sizeKey of ['100x100', '100x80']) {
    const data = buildShippingLabelData(xssOrder, {
      sizeKey,
      presetKey: 'bakery',
      shipDate: '2026-11-21',
      copies: 3,
      token: 'AbCdEfGhIj1234567890',
    });
    const html = buildShippingLabelPrintHtml(data);

    assert.equal(data.warrantyEndDate, '2027-11-21');
    assert.equal(data.copies, 3);
    assert.match(html, new RegExp(`@page \\{ size: ${LABEL_SIZES[sizeKey].widthMm}mm ${LABEL_SIZES[sizeKey].heightMm}mm; margin: 0; \\}`));
    assert.equal((html.match(/class="label-sheet/g) || []).length, 3);
    assert.match(html, /출고일자/);
    assert.match(html, /2026\.11\.21/);
    assert.match(html, /반드시 단독 코드 사용/);
    assert.match(html, /2~3시간 뒤 전원 연결/);
    assert.match(html, /통풍구 15~20cm 확보/);
    assert.match(html, /라지에이터 월 1회 청소/);
    assert.match(html, /(?:&#39;|')def(?:&#39;|') 표시는 정상 제상 중/);
    assert.match(html, /카카오톡 A\/S/);
    assert.doesNotMatch(html, /031-986-2458/);
    assert.match(html, /12개월 \(~2027\.11\.21\)/);
    assert.match(html, /<svg[^>]*shape-rendering="crispEdges"/);
    assert.doesNotMatch(html, /알앤에프냉동덧방/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  }

  const genericSample = buildShippingLabelData(sampleOrder, {
    sizeKey: '100x100',
    presetKey: 'bakery',
    shipDate: '2026-11-20',
    allowGenericGuide: true,
  });
  assert.equal(genericSample.guideUrl, 'https://production-status.vercel.app/guide?p=bakery');

  const explicitDefault = buildShippingLabelData(
    { ...sampleOrder, product_type: '제과' },
    {
      sizeKey: '100x80',
      presetKey: 'default',
      shipDate: '2026-11-20',
      token: 'AbCdEfGhIj1234567890',
    },
  );
  const explicitDefaultHtml = buildShippingLabelPrintHtml(explicitDefault);
  assert.equal(explicitDefault.settingLabel, '기본세팅');
  assert.equal(explicitDefault.guideUrl, 'https://production-status.vercel.app/guide/AbCdEfGhIj1234567890?p=default');
  assert.match(explicitDefaultHtml, /height:\s*79\.5mm;/);
  assert.match(explicitDefaultHtml, /min-height:\s*24mm;/);
});

test('api/track/[token]은 guide_preset_key만 내려주고 product_type은 절대 노출하지 않는다', async () => {
  const order = {
    id: 55,
    order_date: '2026-11-20',
    client_name: '라벨 테스트 매장',
    sales_person: '이준형',
    product_type: '알앤에프냉동덧방',
    door_type: '앞문',
    width: 1500,
    depth: 700,
    height: 1200,
    quantity: 1,
    color: '화이트',
    status: 'shipped',
    due_date: '2026-11-20',
    ship_scheduled_date: null,
    ship_date: '2026-11-20',
  };
  const db = {
    async execute({ sql }) {
      if (sql === 'SELECT * FROM orders WHERE track_token = ?') return { rows: [order] };
      if (sql === 'SELECT step_name, status FROM processes WHERE order_id = ? ORDER BY id') {
        return { rows: [{ step_name: '포장', status: 'completed' }] };
      }
      if (/FROM photos ph/i.test(sql)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const res = {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };

  await handleTrack(
    { method: 'GET', query: { token: 'ValidToken1234567890' }, headers: {}, socket: {} },
    res,
    { db, rateLimitCheck: () => true },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.guide_preset_key, null);
  assert.equal(Object.hasOwn(res.body, 'product_type'), false);
});

test('api/orders/[id]/track-link는 guide_url도 함께 반환한다', async () => {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };

  await handleTrackLink(
    { method: 'POST', query: { id: '42' } },
    res,
    {
      rateLimitCheck: () => true,
      requireAuth: async () => ({ role: 'sales' }),
      db: {},
      ensureTrackToken: async () => 'TokenAbcdef1234567890',
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.token, 'TokenAbcdef1234567890');
  assert.match(res.body.url, /\/track\/TokenAbcdef1234567890$/);
  assert.match(res.body.guide_url, /\/guide\/TokenAbcdef1234567890$/);
});

test('SalesOrderCard와 App에 라벨 출력 버튼과 /guide/:token 공개 라우트가 연결되어 있다', () => {
  const cardSource = readFileSync(new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url), 'utf8');
  const modalSource = readFileSync(new URL('../src/components/sales/ShippingLabelModal.jsx', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const guideSource = readFileSync(new URL('../src/pages/GuidePage.jsx', import.meta.url), 'utf8');

  assert.match(cardSource, /import ShippingLabelModal from '\.\/ShippingLabelModal'/);
  assert.match(cardSource, /라벨 스티커 출력/);
  assert.match(cardSource, /<ShippingLabelModal[\s\S]*active=\{labelModalOpen\}[\s\S]*onClose=\{handleCloseLabelModal\}/);
  assert.match(modalSource, /onCloseRef\.current/);
  assert.match(appSource, /<Route path="\/guide" element=\{<GuidePage \/>\} \/>/);
  assert.match(appSource, /<Route path="\/guide\/:token" element=\{<GuidePage \/>\} \/>/);
  assert.match(appSource, /!isPublicGuideRoute && <InstallPrompt \/>/);
  assert.doesNotMatch(guideSource, /data\.product_type|data\?\.product_type/);
  assert.match(guideSource, /if \(!hasToken\)/);
  assert.match(guideSource, /queryPresetKey === DEFAULT_SHOWCASE_SETTING\.key/);
  assert.match(guideSource, /!notFound && orderNo/);
  assert.match(guideSource, /hs_guide_font_scale_v1/);
  assert.match(guideSource, /ControllerDiagramSvg/);
  assert.match(guideSource, /RadiatorDiagramSvg/);
  assert.match(guideSource, /id="sec-reviews"/);
  assert.match(guideSource, /tab=review|searchParams\.get\('tab'\)/);
  assert.match(guideSource, /guide-zoom-backdrop/);
  assert.doesNotMatch(guideSource, /031-986-2458|asPhone/);
  assert.equal(SHOWCASE_GUIDE_BRAND.asKakaoChatUrl, 'http://pf.kakao.com/_LxgyRxj/chat');
  assert.equal(SHOWCASE_GUIDE_BRAND.asKakaoLabel, '카카오톡 A/S 문의 바로가기');
  assert.match(guideSource, /asKakaoChatUrl/);
  assert.match(guideSource, /asKakaoLabel/);
  assert.doesNotMatch(guideSource, /guide-shell--review/);
  assert.match(guideSource, /className="guide-shell"[\s\S]*className="guide-sidebar"[\s\S]*viewMode === 'review'/);
  assert.match(guideSource, /\/images\/guide\/installation-safety\.webp/);
  assert.match(guideSource, /\/images\/guide\/radiator-cleaning-steps\.webp/);
  assert.match(guideSource, /\/images\/guide\/leveling-guide\.webp/);
  assert.match(guideSource, /\/images\/guide\/review-photo-tip\.webp/);
  const blogEv = SHOWCASE_REVIEW_EVENTS.find((e) => e.id === 'blog');
  const snsEv = SHOWCASE_REVIEW_EVENTS.find((e) => e.id === 'sns');
  const googleEv = SHOWCASE_REVIEW_EVENTS.find((e) => e.id === 'google');
  const storeEv = SHOWCASE_REVIEW_EVENTS.find((e) => e.id === 'smartstore');
  assert.equal(blogEv?.posterImage, '/sms-templates/review_blog.jpg');
  assert.equal(snsEv?.posterImage, '/sms-templates/review_sns.jpg');
  assert.equal(googleEv?.posterImage, '/sms-templates/review_google.jpg');
  assert.equal(storeEv?.posterImage, null);
  for (const poster of ['review_blog.jpg', 'review_sns.jpg', 'review_google.jpg']) {
    const absPath = new URL(`../public/sms-templates/${poster}`, import.meta.url);
    assert.ok(readFileSync(absPath).byteLength > 10000, `${poster} file missing`);
  }
  assert.equal(SHOWCASE_GUIDE_BRAND.blogReviewFormUrl, 'https://forms.gle/LnxodxFTxWjcVwx37');
});
