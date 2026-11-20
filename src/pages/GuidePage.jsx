import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { getTrackInfo, TrackApiError } from '../api/track';
import { safeGet, safeSet } from '../utils/safeStorage';
import { resolveInquiryRoute } from './inquiryRouting';
import {
  DEFAULT_SHOWCASE_SETTING,
  GUIDE_SECTIONS,
  SHOWCASE_GUIDE_BRAND,
  SHOWCASE_GUIDE_PRESETS,
  SHOWCASE_REVIEW_EVENTS,
  calculateWarrantyEndDate,
  formatDotDate,
  getGuidePresetByKey,
  resolveGuidePresetKey,
} from '../../shared/showcaseGuide.js';
import './GuidePage.css';

const FONT_SCALE_STORAGE_KEY = 'hs_guide_font_scale_v1';

const FONT_SCALE_OPTIONS = [
  { key: 'normal', label: '보통 글씨', shortLabel: '보통' },
  { key: 'large', label: '큰 글씨', shortLabel: '크게' },
  { key: 'xlarge', label: '아주 큰 글씨', shortLabel: '아주 크게' },
];

const QUICK_PROBLEMS = [
  { href: '#sec-def', num: '01', label: '"def" 화면 떴어요', sub: '정상 제상 중 안내' },
  { href: '#sec-safety', num: '02', label: '전원 · 단독 코드', sub: '설치·보관 필수 수칙' },
  { href: '#sec-controller', num: '03', label: '온도 · 제상 버튼법', sub: '잠금 3초 해제' },
  { href: '#sec-table', num: '04', label: '10종 품목 온도표', sub: '권장 기준 비교' },
  { href: '#sec-radiator', num: '05', label: '라지에이터 청소', sub: '그림으로 쉬운 청소' },
  { href: '#sec-reviews', num: '06', label: '리뷰 14만원 받기', sub: '블로그 / 인스타 / 구글' },
];

const TOC_ITEMS = [
  { href: '#sec-def', num: '01', label: '"def" 표시 안내' },
  { href: '#sec-safety', num: '02', label: '필수 안전 · 설치 수칙' },
  { href: '#sec-controller', num: '03', label: '온도조절기 조작 · 설정' },
  { href: '#sec-table', num: '04', label: '품목별 온도·제상 기준표' },
  { href: '#sec-radiator', num: '05', label: '라지에이터 청소 방법' },
  { href: '#sec-leveling', num: '06', label: '쇼케이스 수평 조절' },
  { href: '#sec-reviews', num: '07', label: '리뷰 최대 14만원 참여' },
  { href: '#sec-support', num: '08', label: '무상 A/S · 카카오톡 문의' },
];

const REVIEW_HASH_CHANNEL_MAP = {
  '#sec-reviews': 'blog',
  '#review-blog': 'blog',
  '#review-sns': 'sns',
  '#review-google': 'google',
  '#review-store': 'smartstore',
};

function initialFontScale() {
  const saved = safeGet(FONT_SCALE_STORAGE_KEY);
  return FONT_SCALE_OPTIONS.some((opt) => opt.key === saved) ? saved : 'large';
}

function GuideSkeleton() {
  return (
    <div className="guide-sheet" aria-busy="true" aria-label="안내 정보를 불러오는 중">
      <div className="guide-skel" style={{ width: '44%', height: 18 }} />
      <div className="guide-skel" style={{ width: '72%', height: 28, marginTop: 12 }} />
      <div className="guide-skel" style={{ width: '100%', height: 84, marginTop: 14 }} />
    </div>
  );
}

function ControllerDiagramSvg() {
  return (
    <figure className="guide-diagram-box">
      <svg
        className="guide-diagram-svg"
        viewBox="0 0 420 220"
        role="img"
        aria-label="한성쇼케이스 온도조절기 버튼 배치 도면: 좌측 잠금(3초)과 전원, 중앙 -05c 표시창과 우측 3개 표시등(온도표시, 제상주기, 제상시간), 하단 내림 올림 설정 제상, 우측 조명과 결로팬"
      >
        <rect x="4" y="4" width="412" height="212" rx="8" fill="#F8FAFC" stroke="#0F294A" strokeWidth="3" />
        <rect x="14" y="14" width="392" height="192" rx="5" fill="#1E293B" stroke="#0F172A" strokeWidth="2" />

        {/* 좌측 버튼: 잠금 / 전원 */}
        <rect x="24" y="26" width="72" height="74" rx="5" fill="#FEF9C3" stroke="#0F172A" strokeWidth="2.5" />
        <text x="60" y="59" textAnchor="middle" fill="#111111" fontSize="19" fontWeight="900">잠금</text>
        <text x="60" y="84" textAnchor="middle" fill="#991B1B" fontSize="14.5" fontWeight="900">3초</text>

        <rect x="24" y="116" width="72" height="74" rx="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="2.5" />
        <text x="60" y="149" textAnchor="middle" fill="#111111" fontSize="19" fontWeight="900">전원</text>
        <text x="60" y="174" textAnchor="middle" fill="#1E293B" fontSize="13.5" fontWeight="800">켜기/끔</text>

        {/* 중앙 LED 창 */}
        <rect x="108" y="26" width="204" height="90" rx="5" fill="#090D16" stroke="#94A3B8" strokeWidth="2" />
        <text x="163" y="84" textAnchor="middle" fill="#FF3B30" fontSize="42" fontWeight="900" fontFamily="monospace">-05c</text>

        {/* 우측 3개 표시 LED */}
        <rect x="224" y="34" width="12" height="12" fill="#EF4444" stroke="#FFFFFF" strokeWidth="1.5" />
        <text x="242" y="45" fill="#FFFFFF" fontSize="14" fontWeight="900">온도표시</text>

        <rect x="224" y="64" width="12" height="12" fill="#334155" stroke="#E2E8F0" strokeWidth="1.5" />
        <text x="242" y="75" fill="#F8FAFC" fontSize="14" fontWeight="800">제상주기</text>

        <rect x="224" y="94" width="12" height="12" fill="#334155" stroke="#E2E8F0" strokeWidth="1.5" />
        <text x="242" y="105" fill="#F8FAFC" fontSize="14" fontWeight="800">제상시간</text>

        {/* 하단 4개 조작 버튼 */}
        <rect x="108" y="128" width="46" height="62" rx="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="2.5" />
        <text x="131" y="156" textAnchor="middle" fill="#111111" fontSize="20" fontWeight="900">▼</text>
        <text x="131" y="178" textAnchor="middle" fill="#111111" fontSize="13" fontWeight="900">내림</text>

        <rect x="160" y="128" width="46" height="62" rx="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="2.5" />
        <text x="183" y="156" textAnchor="middle" fill="#111111" fontSize="20" fontWeight="900">▲</text>
        <text x="183" y="178" textAnchor="middle" fill="#111111" fontSize="13" fontWeight="900">올림</text>

        <rect x="212" y="128" width="48" height="62" rx="5" fill="#FEF08A" stroke="#0F172A" strokeWidth="2.5" />
        <text x="236" y="165" textAnchor="middle" fill="#111111" fontSize="17" fontWeight="900">설정</text>

        <rect x="266" y="128" width="46" height="62" rx="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="2.5" />
        <text x="289" y="165" textAnchor="middle" fill="#111111" fontSize="17" fontWeight="900">제상</text>

        {/* 우측 버튼: 조명 / 결로팬 */}
        <rect x="324" y="26" width="72" height="74" rx="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="2.5" />
        <text x="360" y="59" textAnchor="middle" fill="#111111" fontSize="19" fontWeight="900">조명</text>
        <text x="360" y="84" textAnchor="middle" fill="#1E293B" fontSize="14" fontWeight="800">LED</text>

        <rect x="324" y="116" width="72" height="74" rx="5" fill="#FFFFFF" stroke="#0F172A" strokeWidth="2.5" />
        <text x="360" y="149" textAnchor="middle" fill="#111111" fontSize="18" fontWeight="900">결로팬</text>
        <text x="360" y="174" textAnchor="middle" fill="#1E293B" fontSize="13" fontWeight="800">습한날</text>
      </svg>
      <figcaption className="guide-diagram-caption">
        도면 1. 조절기 실물 배치 (잠금 3초 누름 → ▼▲ 조절 → 손 떼면 자동잠금)
      </figcaption>
    </figure>
  );
}

function RadiatorDiagramSvg() {
  return (
    <figure className="guide-diagram-box">
      <svg
        className="guide-diagram-svg"
        viewBox="0 0 360 192"
        role="img"
        aria-label="라지에이터 청소 방향 도면: 빗살 방열판 결을 따라 반드시 위아래 방향으로 쓸어야 핀이 휘지 않습니다"
      >
        <rect x="4" y="4" width="352" height="184" rx="6" fill="#FFFFFF" stroke="#1E293B" strokeWidth="2.5" />

        {/* 라지에이터 본체 */}
        <rect x="20" y="22" width="154" height="148" rx="4" fill="#E2E8F0" stroke="#0F172A" strokeWidth="2.5" />
        <g stroke="#1E293B" strokeWidth="2.5">
          <line x1="36" y1="30" x2="36" y2="162" />
          <line x1="50" y1="30" x2="50" y2="162" />
          <line x1="64" y1="30" x2="64" y2="162" />
          <line x1="78" y1="30" x2="78" y2="162" />
          <line x1="92" y1="30" x2="92" y2="162" />
          <line x1="106" y1="30" x2="106" y2="162" />
          <line x1="120" y1="30" x2="120" y2="162" />
          <line x1="134" y1="30" x2="134" y2="162" />
          <line x1="148" y1="30" x2="148" y2="162" />
          <line x1="162" y1="30" x2="162" y2="162" />
        </g>

        {/* 위-아래 굵은 양방향 화살표 */}
        <line x1="202" y1="40" x2="202" y2="152" stroke="#B91C1C" strokeWidth="6" />
        <polygon points="202,20 189,44 215,44" fill="#B91C1C" />
        <polygon points="202,172 189,148 215,148" fill="#B91C1C" />

        {/* 우측 안내 박스 */}
        <rect x="228" y="22" width="114" height="72" rx="5" fill="#FEF2F2" stroke="#B91C1C" strokeWidth="2.5" />
        <text x="285" y="54" textAnchor="middle" fill="#991B1B" fontSize="19" fontWeight="900">위 · 아래</text>
        <text x="285" y="80" textAnchor="middle" fill="#111111" fontSize="16" fontWeight="900">방향 청소</text>

        <rect x="228" y="106" width="114" height="64" rx="5" fill="#F8FAFC" stroke="#1E293B" strokeWidth="2" />
        <text x="285" y="134" textAnchor="middle" fill="#111111" fontSize="14.5" fontWeight="900">좌우 문지름</text>
        <text x="285" y="157" textAnchor="middle" fill="#B91C1C" fontSize="15.5" fontWeight="900">절대 금지</text>
      </svg>
      <figcaption className="guide-diagram-caption">
        도면 2. 전원 차단 · 장갑 착용 후 부드러운 솔로 위·아래 방향 쓸기
      </figcaption>
    </figure>
  );
}

function ReviewPosterBox({ event, onZoom }) {
  if (!event?.posterImage) return null;
  return (
    <div className="guide-rv-poster-col">
      <button
        type="button"
        className="guide-rv-poster-btn"
        onClick={() => onZoom({ src: event.posterImage, alt: event.posterAlt, title: event.title })}
      >
        <img
          className="guide-rv-poster-img"
          src={event.posterImage}
          alt={event.posterAlt}
          width={event.posterWidth}
          height={event.posterHeight}
          loading="eager"
          decoding="sync"
        />
        <span className="guide-rv-poster-zoom-hint">눌러서 이미지 크게 보기 +</span>
      </button>
    </div>
  );
}

function ReviewActionButtons({ event }) {
  return (
    <div className="guide-review-actions">
      <a
        className="guide-btn guide-btn--event"
        href={event.primaryCtaUrl}
        target={event.primaryCtaUrl.startsWith('http') ? '_blank' : undefined}
        rel={event.primaryCtaUrl.startsWith('http') ? 'noopener noreferrer' : undefined}
      >
        {event.primaryCtaLabel} {event.primaryCtaUrl.startsWith('http') ? '↗' : ''}
      </a>

      {event.secondaryCtaUrl && (
        <a
          className="guide-btn guide-btn--secondary"
          href={event.secondaryCtaUrl}
          target={event.secondaryCtaUrl.startsWith('http') ? '_blank' : undefined}
          rel={event.secondaryCtaUrl.startsWith('http') ? 'noopener noreferrer' : undefined}
        >
          {event.secondaryCtaLabel} {event.secondaryCtaUrl.startsWith('http') ? '↗' : ''}
        </a>
      )}

      {event.guideCtaUrl && (
        <a
          className="guide-text-link"
          href={event.guideCtaUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {event.guideCtaLabel} ↗
        </a>
      )}
    </div>
  );
}

function ReviewDetailBody({
  event,
  copiedMap,
  onCopyText,
  includeActions = true,
}) {
  return (
    <div className="guide-rv-detail-col">
      <div className="guide-review-card-head">
        <div>
          <span className="guide-review-channel">{event.channelBadge}</span>
          <h3 className="guide-review-title">{event.title}</h3>
        </div>
        <div className="guide-review-reward-pill mono">{event.maxReward}</div>
      </div>

      <div className="guide-review-timing">{event.payoutTiming}</div>

      <div className="guide-review-tier-list">
        {event.rewards.map((tier) => (
          <div key={tier.label} className="guide-review-tier-row">
            <span>{tier.label}</span>
            <strong className="mono">{tier.amount}</strong>
          </div>
        ))}
      </div>

      {event.titleTemplate && (
        <div className="guide-copy-box">
          <div className="guide-copy-k">필수 제목 양식 (그대로 복사해 바꾸세요)</div>
          <div className="guide-copy-v">{event.titleTemplate}</div>
          <div className="guide-copy-ex">{event.titleExample}</div>
          <button
            type="button"
            className="guide-btn guide-btn--copy"
            onClick={() => onCopyText('blog_title', event.titleTemplate)}
          >
            {copiedMap.blog_title ? '제목 양식이 복사되었습니다 ✓' : '제목 양식 복사하기'}
          </button>
        </div>
      )}

      {event.tagHandle && (
        <div className="guide-copy-box">
          <div className="guide-copy-k">게시물 필수 태그 아이디</div>
          <div className="guide-copy-v mono">{event.tagHandle}</div>
          <button
            type="button"
            className="guide-btn guide-btn--copy"
            onClick={() => onCopyText('sns_tag', event.tagHandle)}
          >
            {copiedMap.sns_tag ? '@hansungtech 복사 완료 ✓' : '@hansungtech 태그 복사하기'}
          </button>
        </div>
      )}

      <ul className="guide-ul guide-review-reqs">
        {event.requirements.map((req) => (
          <li key={req}>{req}</li>
        ))}
      </ul>

      {includeActions && <ReviewActionButtons event={event} />}

      {event.showPhotoTip && (
        <details className="guide-details guide-rv-tip-details">
          <summary className="guide-details-summary">리뷰 사진 잘 찍는 예시 보기</summary>
          <div className="guide-details-content">
            <figure className="guide-illus-box">
              <img
                className="guide-illus-img"
                src="/images/guide/review-photo-tip.webp"
                alt="리뷰 사진 잘 찍는 법 그림: 왼쪽은 매장 분위기와 쇼케이스 전체, 상단 HANSUNG 로고가 또렷하게 나온 좋은 예(O), 오른쪽은 어둡거나 일부만 찍은 나쁜 예(✕)"
                width="1200"
                height="670"
                loading="eager"
                decoding="sync"
              />
              <figcaption className="guide-illus-steps guide-illus-steps--2col">
                <span><strong>O 잘 찍은 사진:</strong> 매장 전체 분위기 + 쇼케이스 + 상단 HANSUNG 로고 보이게</span>
                <span><strong>✕ 피할 사진:</strong> 너무 어둡거나 유리 일부만 가까이 찍기</span>
              </figcaption>
            </figure>
          </div>
        </details>
      )}
    </div>
  );
}

function ReviewShowcaseView({
  activeReview,
  copiedMap,
  onCopyText,
  onSelectChannel,
  onOpenManual,
  onZoomPoster,
  onKakaoInquiry,
}) {
  const otherReviews = SHOWCASE_REVIEW_EVENTS.filter((ev) => ev.id !== activeReview.id);
  const isWideLayout = activeReview.posterLayout === 'wide-banner' || activeReview.posterLayout === 'text-only';

  return (
    <section id="sec-reviews" className="guide-sheet guide-review-view" aria-labelledby="heading-reviews">
      <div className="guide-rv-header">
        <div>
          <div className="guide-rv-kicker">중복 참여 가능 · 블로그 7만 + 인스타·쓰레드 4만 + 구글 3만</div>
          <h2 id="heading-reviews" className="guide-rv-heading">
            리뷰 남기고 현금 최대 140,000원 (+스토어 3만원)
          </h2>
        </div>
        <button type="button" className="guide-rv-back-btn" onClick={() => onOpenManual()}>
          ← 사용설명서 · 청소법
        </button>
      </div>

      <div className="guide-rv-tabs" role="tablist" aria-label="리뷰 채널 선택">
        {SHOWCASE_REVIEW_EVENTS.map((ev) => {
          const selected = ev.id === activeReview.id;
          return (
            <button
              key={ev.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`guide-rv-tab${selected ? ' is-active' : ''}`}
              onClick={() => onSelectChannel(ev.id)}
            >
              <span className="guide-rv-tab-name">{ev.shortLabel}</span>
              <strong className="guide-rv-tab-reward mono">{ev.shortReward}</strong>
            </button>
          );
        })}
      </div>

      <article
        id={activeReview.anchorId}
        className={`guide-rv-stage guide-rv-stage--${activeReview.posterLayout}`}
        role="tabpanel"
      >
        {isWideLayout ? (
          <>
            <ReviewPosterBox event={activeReview} onZoom={onZoomPoster} />
            <div className="guide-rv-wide-body">
              <ReviewDetailBody
                event={activeReview}
                copiedMap={copiedMap}
                onCopyText={onCopyText}
                includeActions={false}
              />
              <div className="guide-rv-action-col">
                <div className="guide-rv-action-card">
                  <div className="guide-rv-action-kicker">바로 작성 및 접수</div>
                  <ReviewActionButtons event={activeReview} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <ReviewPosterBox event={activeReview} onZoom={onZoomPoster} />
            <ReviewDetailBody
              event={activeReview}
              copiedMap={copiedMap}
              onCopyText={onCopyText}
              includeActions
            />
          </>
        )}
      </article>

      <div className="guide-rv-others">
        <div className="guide-rv-others-title">다른 리뷰도 함께 참여하면 현금 혜택이 커집니다</div>
        <div className="guide-rv-others-grid">
          {otherReviews.map((ev) => (
            <button
              key={ev.id}
              type="button"
              className="guide-rv-other-card"
              onClick={() => onSelectChannel(ev.id)}
            >
              <span className="guide-rv-other-ch">{ev.channelBadge}</span>
              <strong className="guide-rv-other-name">{ev.shortLabel} · {ev.shortReward}</strong>
              <span className="guide-rv-other-go">자세히 보기 →</span>
            </button>
          ))}
        </div>
      </div>

      <div className="guide-rv-footer-bar">
        <button type="button" className="guide-btn guide-btn--secondary" onClick={() => onOpenManual()}>
          ← 제품 사용설명서 · 라지에이터 청소법 보기
        </button>
        <a
          className="guide-btn guide-btn--kakao"
          href={SHOWCASE_GUIDE_BRAND.asKakaoChatUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={onKakaoInquiry}
        >
          {SHOWCASE_GUIDE_BRAND.asKakaoLabel} ↗
        </a>
      </div>
    </section>
  );
}

export default function GuidePage() {
  const { token } = useParams();
  const hasToken = Boolean(String(token || '').trim());
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const queryPresetKey = searchParams.get('p');

  const validReviewIds = useMemo(
    () => SHOWCASE_REVIEW_EVENTS.map((ev) => ev.id),
    [],
  );
  const viewMode = searchParams.get('tab') === 'review' ? 'review' : 'manual';
  const rawChannel = searchParams.get('ch');
  const activeReviewId = validReviewIds.includes(rawChannel) ? rawChannel : 'blog';
  const activeReview = useMemo(
    () => SHOWCASE_REVIEW_EVENTS.find((ev) => ev.id === activeReviewId) || SHOWCASE_REVIEW_EVENTS[0],
    [activeReviewId],
  );

  const [fontScale, setFontScale] = useState(initialFontScale);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(hasToken);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [inquiryCopied, setInquiryCopied] = useState(false);
  const [copiedMap, setCopiedMap] = useState({});
  const [zoomedPoster, setZoomedPoster] = useState(null);
  const mountedRef = useRef(true);
  const copyTimersRef = useRef({});
  const inquiryTimerRef = useRef(null);
  const loadRequestIdRef = useRef(0);
  const lastHashRef = useRef('');

  useEffect(() => {
    if (!location.hash || location.hash === lastHashRef.current) return;
    lastHashRef.current = location.hash;
    const mappedChannel = REVIEW_HASH_CHANNEL_MAP[location.hash];
    if (!mappedChannel) return;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'review');
      next.set('ch', mappedChannel);
      return next;
    }, { replace: true });
  }, [location.hash, setSearchParams]);

  useEffect(() => {
    if (viewMode !== 'review') {
      setZoomedPoster(null);
    }
  }, [viewMode]);

  useEffect(() => {
    if (!zoomedPoster) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        setZoomedPoster(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [zoomedPoster]);

  const openReviewView = useCallback((channelId = 'blog') => {
    const safeChannel = validReviewIds.includes(channelId) ? channelId : 'blog';
    const alreadyInReview = viewMode === 'review';
    setZoomedPoster(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'review');
      next.set('ch', safeChannel);
      return next;
    }, { replace: alreadyInReview });
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [setSearchParams, validReviewIds, viewMode]);

  const openManualView = useCallback((sectionId = null) => {
    setZoomedPoster(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('tab');
      next.delete('ch');
      return next;
    }, { replace: false });
    if (sectionId) {
      requestAnimationFrame(() => {
        const target = document.getElementById(sectionId);
        if (target) target.scrollIntoView({ behavior: 'auto', block: 'start' });
      });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [setSearchParams]);

  const selectReviewChannel = useCallback((channelId) => {
    const safeChannel = validReviewIds.includes(channelId) ? channelId : 'blog';
    setZoomedPoster(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'review');
      next.set('ch', safeChannel);
      return next;
    }, { replace: true });
    requestAnimationFrame(() => {
      const sec = document.getElementById('sec-reviews');
      if (sec) sec.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  }, [setSearchParams, validReviewIds]);

  const handleFontScaleChange = (nextKey) => {
    setFontScale(nextKey);
    safeSet(FONT_SCALE_STORAGE_KEY, nextKey);
  };

  const handleCopyText = (key, value) => {
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        Promise.resolve(navigator.clipboard.writeText(value))
          .then(() => {
            if (!mountedRef.current) return;
            if (copyTimersRef.current[key]) {
              clearTimeout(copyTimersRef.current[key]);
            }
            setCopiedMap((prev) => ({ ...prev, [key]: true }));
            copyTimersRef.current[key] = setTimeout(() => {
              delete copyTimersRef.current[key];
              if (mountedRef.current) {
                setCopiedMap((prev) => ({ ...prev, [key]: false }));
              }
            }, 2500);
          })
          .catch(() => {
            // 클립보드 권한 거부 시 무시
          });
      }
    } catch {
      // 클립보드 미지원 시 무시
    }
  };

  const load = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!hasToken) {
      setData(null);
      setNotFound(false);
      setError('');
      setLoading(false);
      return;
    }
    setData(null);
    setLoading(true);
    setNotFound(false);
    setError('');
    try {
      const res = await getTrackInfo(token);
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      setData(res);
    } catch (err) {
      if (!mountedRef.current || requestId !== loadRequestIdRef.current) return;
      if (err instanceof TrackApiError && err.status === 404) {
        setNotFound(true);
        setData(null);
      } else {
        setError(err?.message || '주문 정보를 불러오지 못했습니다.');
      }
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setLoading(false);
      }
    }
  }, [hasToken, token]);

  useEffect(() => {
    mountedRef.current = true;
    const copyTimers = copyTimersRef;
    const inquiryTimer = inquiryTimerRef;
    load();
    return () => {
      mountedRef.current = false;
      Object.values(copyTimers.current).forEach((id) => clearTimeout(id));
      copyTimers.current = {};
      if (inquiryTimer.current) {
        clearTimeout(inquiryTimer.current);
        inquiryTimer.current = null;
      }
    };
  }, [load]);

  const activePreset = useMemo(() => {
    if (queryPresetKey === DEFAULT_SHOWCASE_SETTING.key) return null;
    const fromQuery = getGuidePresetByKey(queryPresetKey);
    if (fromQuery) return fromQuery;
    const fromServer = getGuidePresetByKey(data?.guide_preset_key);
    if (fromServer) return fromServer;
    const fromDoor = getGuidePresetByKey(resolveGuidePresetKey('', data?.door_type));
    if (fromDoor) return fromDoor;
    return null;
  }, [queryPresetKey, data?.guide_preset_key, data?.door_type]);

  const setting = activePreset || DEFAULT_SHOWCASE_SETTING;
  const isShipped = Boolean(data?.ship_date);
  const warrantyEndDate = isShipped ? calculateWarrantyEndDate(data.ship_date) : null;
  const orderNo = data?.order_no
    ? `#${data.order_no}`
    : (token ? `#HS-${String(token).slice(0, 6).toUpperCase()}` : '');

  const sizeText = data
    ? [
        data.size?.width ?? data.width,
        data.size?.depth ?? data.depth,
        data.size?.height ?? data.height,
      ].filter(Boolean).join('×')
    : '';

  const inquiryRoute = resolveInquiryRoute(data?.manager_name || null);

  const handleKakaoInquiry = () => {
    const lines = ['[한성쇼케이스 A/S · 사용 문의]'];
    if (orderNo) lines.push(`· 주문번호: ${orderNo.replace(/^#/, '')}`);
    if (data?.door_type) lines.push(`· 문형: ${data.door_type}`);
    if (inquiryRoute.manager) lines.push(`· 담당: ${inquiryRoute.manager}`);
    lines.push('', '문의 내용: ');
    try {
      if (navigator.clipboard?.writeText) {
        Promise.resolve(navigator.clipboard.writeText(lines.join('\n')))
          .then(() => {
            if (!mountedRef.current) return;
            if (inquiryTimerRef.current) {
              clearTimeout(inquiryTimerRef.current);
            }
            setInquiryCopied(true);
            inquiryTimerRef.current = setTimeout(() => {
              inquiryTimerRef.current = null;
              if (mountedRef.current) setInquiryCopied(false);
            }, 2500);
          })
          .catch(() => {
            // 클립보드 권한 거부 시 링크 이동만 수행
          });
      }
    } catch {
      // 클립보드 미지원 시 링크 이동만 수행
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div id="guide-top" className={`guide-page guide-page--${fontScale}`}>
      <a className="guide-skip-link" href="#guide-main">본문 설명서로 바로가기</a>

      {/* 공식 문서 헤더 바 */}
      <header className="guide-masthead">
        <div className="guide-masthead-inner">
          <div className="guide-brand-block">
            <span className="guide-emblem" aria-hidden="true">HS</span>
            <div className="guide-brand-titles">
              <div className="guide-brand-kicker-row">
                <span className="guide-brand-kicker">(주){SHOWCASE_GUIDE_BRAND.name} 공식 사용안내서</span>
                {!loading && data && !notFound && orderNo && (
                  <span className="guide-order-badge mono">{orderNo}</span>
                )}
              </div>
              <h1 className="guide-page-title">제품 사용설명서 · 청소 · 리뷰 혜택</h1>
            </div>
          </div>

          <div className="guide-font-bar" role="group" aria-label="글자 크기 선택">
            <span className="guide-font-label">글자 크기</span>
            <div className="guide-font-buttons">
              {FONT_SCALE_OPTIONS.map((opt) => {
                const pressed = fontScale === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    aria-pressed={pressed}
                    className={`guide-font-btn${pressed ? ' is-active' : ''}`}
                    onClick={() => handleFontScaleChange(opt.key)}
                  >
                    {opt.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </header>

      {/* 전역 상단 화면 전환 바: 제품 사용설명서 ↔ 리뷰 혜택 전용 화면 */}
      <nav className="guide-mode-bar" aria-label="안내 화면 전환">
        <div className="guide-mode-inner" role="tablist" aria-label="설명서 및 리뷰 혜택 전환">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'manual'}
            className={`guide-mode-tab${viewMode === 'manual' ? ' is-active' : ''}`}
            onClick={() => openManualView()}
          >
            제품 사용설명서 · 청소법
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === 'review'}
            className={`guide-mode-tab guide-mode-tab--review${viewMode === 'review' ? ' is-active' : ''}`}
            onClick={() => openReviewView(activeReviewId)}
          >
            리뷰 혜택 · 최대 14만원
          </button>
        </div>
      </nav>

      <div className={`guide-shell${viewMode === 'review' ? ' guide-shell--review' : ''}`}>
        {viewMode === 'review' ? (
          <main id="guide-main" className="guide-main">
            <ReviewShowcaseView
              activeReview={activeReview}
              copiedMap={copiedMap}
              onCopyText={handleCopyText}
              onSelectChannel={selectReviewChannel}
              onOpenManual={openManualView}
              onZoomPoster={setZoomedPoster}
              onKakaoInquiry={handleKakaoInquiry}
            />
          </main>
        ) : (
          <>
            {/* PC 좌측 고정 목차 & A/S 사이드바 (>= 1024px) */}
            <aside className="guide-sidebar" aria-label="설명서 목차 및 빠른 A/S 안내">
              <div className="guide-side-box guide-side-box--as">
                <div className="guide-side-kicker">무상 A/S 출고일로부터 {SHOWCASE_GUIDE_BRAND.freeWarrantyMonths}개월</div>
                <p className="guide-side-as-desc">사진·증상을 보내주시면 빠르게 접수됩니다.</p>
                <a
                  className="guide-btn guide-btn--kakao"
                  href={SHOWCASE_GUIDE_BRAND.asKakaoChatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleKakaoInquiry}
                >
                  {SHOWCASE_GUIDE_BRAND.asKakaoLabel} ↗
                </a>
                {data && token && (
                  <Link className="guide-side-track-link" to={`/track/${encodeURIComponent(token)}`}>
                    주문 진행현황 보기 →
                  </Link>
                )}
              </div>

              <div className="guide-side-box guide-side-review-box">
                <div className="guide-side-review-kicker">중복 참여 현금 혜택</div>
                <div className="guide-side-review-title">블로그 7만 · SNS 4만 · 구글 3만</div>
                <button
                  type="button"
                  className="guide-btn guide-btn--event"
                  onClick={() => openReviewView('blog')}
                >
                  리뷰 혜택 크게 보기 (14만원) →
                </button>
              </div>

              <nav className="guide-side-box" aria-label="설명서 항목 목차">
                <div className="guide-side-toc-title">설명서 · 리뷰 목차</div>
                <ul className="guide-toc-list">
                  {TOC_ITEMS.map((item) => (
                    <li key={item.href}>
                      <a
                        className="guide-toc-link"
                        href={item.href}
                        onClick={
                          item.href === '#sec-reviews'
                            ? (e) => {
                                e.preventDefault();
                                openReviewView('blog');
                              }
                            : undefined
                        }
                      >
                        <span className="guide-toc-num mono">{item.num}</span>
                        <span>{item.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>

              <div className="guide-side-box guide-side-seal">
                <strong>정품 보증 라벨 임의 제거 금지</strong>
                <p>스티커 훼손 시 출고일 확인·A/S에 불이익이 있을 수 있습니다.</p>
              </div>
            </aside>

            {/* 본문 매뉴얼 영역 */}
            <main id="guide-main" className="guide-main">
              {/* 모바일·태블릿 전용: 상황별 큰 바로가기 버튼 */}
              <section className="guide-sheet guide-quick-sheet" aria-labelledby="guide-quick-heading">
                <h2 id="guide-quick-heading" className="guide-sheet-h2">무엇을 찾고 계신가요? (누르면 이동)</h2>
                <div className="guide-quick-grid">
                  {QUICK_PROBLEMS.map((item) => (
                    <a
                      key={item.href}
                      href={item.href}
                      className={`guide-quick-btn${item.href === '#sec-reviews' ? ' guide-quick-btn--event' : ''}`}
                      onClick={
                        item.href === '#sec-reviews'
                          ? (e) => {
                              e.preventDefault();
                              openReviewView('blog');
                            }
                          : undefined
                      }
                    >
                      <span className="guide-quick-num mono">{item.num}</span>
                      <span className="guide-quick-text">
                        <strong>{item.label}</strong>
                        <span>{item.sub}</span>
                      </span>
                    </a>
                  ))}
                </div>
              </section>

          {loading && <GuideSkeleton />}

          {!loading && notFound && (
            <div className="guide-sheet guide-callout guide-callout--danger" role="alert">
              <div className="guide-callout-title">주문별 상세 정보를 찾을 수 없습니다</div>
              <p>
                링크가 만료되었거나 올바르지 않을 수 있습니다. 아래 공통 사용설명서·청소 방법·리뷰 참여와
                카카오톡 A/S 문의는 그대로 이용하실 수 있습니다.
              </p>
            </div>
          )}

          {!loading && !notFound && error && !data && (
            <div className="guide-sheet guide-callout guide-callout--danger" role="alert">
              <div className="guide-callout-title">주문 정보를 잠시 불러오지 못했습니다</div>
              <p>{error}</p>
              <button type="button" className="guide-btn guide-btn--primary" onClick={load}>
                다시 시도
              </button>
            </div>
          )}

          {/* 상단 요약 그리드: 고객 주문·보증 정보 + 권장 온도 세팅 */}
          <div className="guide-summary-pair">
            {!loading && data && (
              <section className="guide-sheet guide-warranty-sheet" aria-labelledby="sec-order-info">
                <div className="guide-sheet-head">
                  <h2 id="sec-order-info" className="guide-sheet-h2">내 제품 · 무상 A/S 보증</h2>
                  <span className={`guide-warranty-tag${isShipped ? ' is-active' : ''}`}>
                    {isShipped ? '무상 A/S 적용 중' : '출고 확인 중'}
                  </span>
                </div>

                <div className="guide-client-line">
                  <strong className="guide-client-name">
                    {data.client_name_masked || data.client_name || '고객님'}
                  </strong>
                  {orderNo && <span className="guide-inline-order mono">{orderNo}</span>}
                </div>

                <div className="guide-kv-grid">
                  <div className="guide-kv-cell guide-kv-cell--em">
                    <div className="guide-kv-k">출고일자</div>
                    <div className="guide-kv-v mono">
                      {isShipped ? formatDotDate(data.ship_date) : '출고 처리 전'}
                    </div>
                  </div>
                  <div className="guide-kv-cell guide-kv-cell--em">
                    <div className="guide-kv-k">무상 A/S (12개월)</div>
                    <div className="guide-kv-v mono">
                      {warrantyEndDate ? `~ ${formatDotDate(warrantyEndDate)}` : '출고일로부터 12개월'}
                    </div>
                  </div>
                  {data.door_type && (
                    <div className="guide-kv-cell">
                      <div className="guide-kv-k">문형</div>
                      <div className="guide-kv-v">{data.door_type}</div>
                    </div>
                  )}
                  <div className="guide-kv-cell">
                    <div className="guide-kv-k">수량 / 색상</div>
                    <div className="guide-kv-v">
                      {data.quantity != null ? `${data.quantity}대` : '-'}
                      {data.color ? ` · ${data.color}` : ''}
                    </div>
                  </div>
                  {sizeText && (
                    <div className="guide-kv-cell guide-kv-cell--wide">
                      <div className="guide-kv-k">제품 규격 (가로×세로×높이)</div>
                      <div className="guide-kv-v guide-kv-v--nowrap mono">{sizeText} mm</div>
                    </div>
                  )}
                </div>

                <div className="guide-seal-note">
                  ※ 제품에 부착된 <strong>보증 라벨 스티커를 떼거나 훼손하면 사후관리 불이익</strong>을 받을 수 있습니다.
                </div>
              </section>
            )}

            <section
              className={`guide-sheet guide-setting-sheet${!data ? ' guide-setting-sheet--solo' : ''}`}
              aria-labelledby="sec-setting-summary"
            >
              <div className="guide-sheet-head">
                <h2 id="sec-setting-summary" className="guide-sheet-h2">권장 온도 · 제상 출하 세팅</h2>
                <span className="guide-setting-badge">{setting.label}</span>
              </div>

              <div className="guide-setting-range">
                설정 가능 온도 범위: <strong className="mono">{setting.tempRange}</strong>
              </div>

              <div className="guide-metric-grid">
                <div className="guide-metric-box">
                  <div className="guide-metric-k">출하 설정</div>
                  <div className="guide-metric-v mono">{setting.factoryTemp}</div>
                </div>
                <div className="guide-metric-box">
                  <div className="guide-metric-k">제상주기</div>
                  <div className="guide-metric-v mono">{setting.defrostCycle}</div>
                </div>
                <div className="guide-metric-box">
                  <div className="guide-metric-k">제상시간</div>
                  <div className="guide-metric-v mono">{setting.defrostTime}</div>
                </div>
              </div>

              <div className="guide-setting-tips">
                <div className="guide-setting-tips-title">기본 운영 3대 수칙</div>
                <ul className="guide-setting-tips-list">
                  <li><strong>반드시 벽면 단독 콘센트</strong> 연결 (멀티탭 금지)</li>
                  <li>설치 <strong>2~3시간 후 전원</strong> 연결 · 뒷벽면 15~20cm 띄움</li>
                  <li><strong>매장 마감 시</strong> 식품은 매장 냉장고에 별도 보관</li>
                </ul>
              </div>
            </section>
          </div>

          {/* 01. 긴급 "def" 표시 안내 */}
          <section id="sec-def" className="guide-sheet guide-def-sheet" aria-labelledby="heading-def">
            <div className="guide-def-layout">
              <div className="guide-def-led-box" aria-hidden="true">
                <div className="guide-def-led-digits mono">def</div>
                <div className="guide-def-led-cap">자동 성에 제거 표시등</div>
              </div>
              <div className="guide-def-text">
                <div className="guide-def-kicker">고장이 아닙니다 · 버튼 누르지 마세요</div>
                <h2 id="heading-def" className="guide-def-title">
                  화면에 &ldquo;def&rdquo; 글자가 떴을 때는 그대로 기다리세요
                </h2>
                <p className="guide-def-body">
                  {GUIDE_SECTIONS.defNotice}
                </p>
              </div>
            </div>
          </section>

          {/* 02. 필수 안전 · 설치 수칙 */}
          <section id="sec-safety" className="guide-sheet" aria-labelledby="heading-safety">
            <div className="guide-sec-header">
              <span className="guide-sec-num mono">02</span>
              <h2 id="heading-safety" className="guide-sec-heading">필수 안전 · 설치 수칙 (설치 직후 꼭 확인)</h2>
            </div>

            <div className="guide-safety-split">
              <figure className="guide-illus-box">
                <img
                  className="guide-illus-img"
                  src="/images/guide/installation-safety.webp"
                  alt="설치 필수 안전 그림 안내: 1. 벽면 단독 콘센트 연결(멀티탭 금지), 2. 뒷벽면 15~20cm 통풍 거리 확보, 3. 설치 2~3시간 대기 후 전원 연결"
                  width="1200"
                  height="670"
                  loading="eager"
                  decoding="async"
                />
                <figcaption className="guide-illus-steps">
                  <span><strong>① 단독 콘센트</strong> (멀티탭 금지 ✕)</span>
                  <span><strong>② 뒷벽 15~20cm</strong> 통풍 거리 확보</span>
                  <span><strong>③ 2~3시간 대기</strong> 후 전원 연결</span>
                </figcaption>
              </figure>

              <div className="guide-rule-grid">
                {GUIDE_SECTIONS.safetyRules.map((rule, index) => (
                  <article
                    key={rule.title}
                    className={`guide-rule-card${rule.emphasis ? ' guide-rule-card--danger' : ''}`}
                  >
                    <h3 className="guide-rule-title">
                      <span className="guide-rule-badge mono">{index + 1}</span>
                      <span>{rule.title}</span>
                    </h3>
                    <p className="guide-rule-body">{rule.body}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>

          {/* 03. 온도조절기 도면 & 조작법 */}
          <section id="sec-controller" className="guide-sheet" aria-labelledby="heading-controller">
            <div className="guide-sec-header">
              <span className="guide-sec-num mono">03</span>
              <h2 id="heading-controller" className="guide-sec-heading">온도조절기 조작 · 온도 · 제상 설정</h2>
            </div>

            <div className="guide-two-col">
              <div className="guide-col">
                <ControllerDiagramSvg />
                <div className="guide-diagram-tip">
                  <strong>버튼이 안 눌릴 때:</strong> 왼쪽 위 <b>「잠금」</b> 버튼을 <b>3~5초간 꾹</b> 누르시면 ‘삐’ 소리와 함께 풀립니다. 조절 뒤 손을 떼면 5초 후 자동 잠금됩니다.
                </div>
              </div>

              <div className="guide-col">
                <h3 className="guide-sub-h3">1) 각 버튼 역할</h3>
                <dl className="guide-dl">
                  {GUIDE_SECTIONS.buttons.map((btn) => (
                    <div key={btn.name} className="guide-dl-row">
                      <dt>{btn.name}</dt>
                      <dd>{btn.desc}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            <div className="guide-steps-pair">
              <div className="guide-step-panel">
                <h3 className="guide-sub-h3">2) 설정 온도 변경 (3단계)</h3>
                <ol className="guide-ol">
                  {GUIDE_SECTIONS.tempSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="guide-step-panel">
                <h3 className="guide-sub-h3">3) 제상 주기 · 시간 변경</h3>
                <ol className="guide-ol">
                  {GUIDE_SECTIONS.defrostSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="guide-callout guide-callout--warn">
              <div className="guide-callout-title">주의 · 과도한 저온 설정 금지</div>
              <p>{GUIDE_SECTIONS.controllerNote}</p>
            </div>
          </section>

          {/* 04. 품목별 평균 제상 주기 · 시간 · 온도 기준표 */}
          <section id="sec-table" className="guide-sheet" aria-labelledby="heading-table">
            <div className="guide-sec-header">
              <span className="guide-sec-num mono">04</span>
              <h2 id="heading-table" className="guide-sec-heading">10종 품목별 권장 온도 · 제상 기준표</h2>
            </div>
            <p className="guide-sec-lead">
              아래 표는 출하 시 맞추는 권장 기준입니다. 임의로 -10℃ 등 과도하게 낮추지 마세요.
            </p>

            {/* PC / 태블릿용 5열 정식 표 (>= 768px) */}
            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th scope="col" className="guide-col-type">제품 타입</th>
                    <th scope="col" className="guide-col-range">설정 가능 온도</th>
                    <th scope="col" className="guide-col-factory">출하 설정 온도</th>
                    <th scope="col" className="guide-col-cycle">제상주기</th>
                    <th scope="col" className="guide-col-time">제상시간</th>
                  </tr>
                </thead>
                <tbody>
                  {SHOWCASE_GUIDE_PRESETS.map((row) => {
                    const isActive = activePreset?.key === row.key;
                    return (
                      <tr key={row.key} className={isActive ? 'is-active' : ''}>
                        <th scope="row">
                          <span className="guide-row-name">{row.label}</span>
                          {isActive && <span className="guide-row-tag">적용중</span>}
                        </th>
                        <td className="mono guide-td-nowrap">{row.tempRange}</td>
                        <td className="mono guide-td-nowrap"><strong>{row.factoryTemp}</strong></td>
                        <td className="mono guide-td-nowrap">{row.defrostCycle}</td>
                        <td className="mono guide-td-nowrap">{row.defrostTime}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 모바일 전용 컴팩트 카드형 비교표 (< 768px) */}
            <div className="guide-preset-cards" aria-label="품목별 권장 온도 모바일 목록">
              {SHOWCASE_GUIDE_PRESETS.map((row) => {
                const isActive = activePreset?.key === row.key;
                return (
                  <div
                    key={row.key}
                    className={`guide-preset-card${isActive ? ' is-active' : ''}`}
                  >
                    <div className="guide-preset-card-head">
                      <div className="guide-preset-card-left">
                        <strong className="guide-preset-card-title">{row.label}</strong>
                        {isActive && <span className="guide-row-tag">적용중</span>}
                      </div>
                      <span className="guide-preset-factory-pill mono">출하 {row.factoryTemp}</span>
                    </div>
                    <div className="guide-preset-card-strip">
                      <div>
                        <span className="guide-preset-ck">설정가능</span>
                        <strong className="guide-preset-cv mono">{row.tempRange}</strong>
                      </div>
                      <div>
                        <span className="guide-preset-ck">제상주기</span>
                        <strong className="guide-preset-cv mono">{row.defrostCycle}</strong>
                      </div>
                      <div>
                        <span className="guide-preset-ck">제상시간</span>
                        <strong className="guide-preset-cv mono">{row.defrostTime}</strong>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 05. 라지에이터 청소 방법 (그림 + 도면 + 단계별 가이드) */}
          <section id="sec-radiator" className="guide-sheet" aria-labelledby="heading-radiator">
            <div className="guide-sec-header">
              <span className="guide-sec-num mono">05</span>
              <h2 id="heading-radiator" className="guide-sec-heading">라지에이터 청소 (월 1회 이상 · 그림대로 3단계)</h2>
            </div>

            <div className="guide-radiator-visuals">
              <figure className="guide-illus-box">
                <img
                  className="guide-illus-img"
                  src="/images/guide/radiator-cleaning-steps.webp"
                  alt="라지에이터 청소 3단계 그림: 1. 전원 플러그 뽑기(OFF), 2. 보호 장갑 착용, 3. 부드러운 솔로 방열판 위아래(↕) 방향 먼지 제거(좌우 금지 ✕)"
                  width="1200"
                  height="670"
                  loading="eager"
                  decoding="async"
                />
                <figcaption className="guide-illus-steps">
                  <span><strong>① 전원 끄기</strong> (플러그 뽑기)</span>
                  <span><strong>② 보호 장갑</strong> 착용하기</span>
                  <span><strong>③ 솔로 위·아래</strong> 먼지 털기</span>
                </figcaption>
              </figure>

              <RadiatorDiagramSvg />
            </div>

            <div className="guide-radiator-bottom">
              <div className="guide-col">
                <h3 className="guide-sub-h3">실제 청소 순서 3단계</h3>
                <ol className="guide-ol guide-ol--emphasis">
                  {GUIDE_SECTIONS.radiatorCleaning.steps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="guide-callout guide-callout--danger">
                <div className="guide-callout-title">중요 · 청소하지 않아 발생한 고장은 무상 보증기간(12개월) 내에도 유상 처리됩니다</div>
                <ul className="guide-ul">
                  {GUIDE_SECTIONS.radiatorCleaning.warnings.map((warn) => (
                    <li key={warn}>{warn}</li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* 06. 수평 맞추는 방법 */}
          <section id="sec-leveling" className="guide-sheet" aria-labelledby="heading-leveling">
            <div className="guide-sec-header">
              <span className="guide-sec-num mono">06</span>
              <h2 id="heading-leveling" className="guide-sec-heading">쇼케이스 수평 · 물빠짐 조절 방법</h2>
            </div>

            <details className="guide-details" open>
              <summary className="guide-details-summary">
                설치 시 수평 조절 · 물빠짐 확인 3단계 보기
              </summary>
              <div className="guide-details-content">
                <div className="guide-level-split">
                  <figure className="guide-illus-box">
                    <img
                      className="guide-illus-img"
                      src="/images/guide/leveling-guide.webp"
                      alt="수평 조절 및 물빠짐 3단계 그림: 1. 바퀴 옆 조절좌 볼트 4개 내려 바닥 고정, 2. 선반 위 휴대폰 수평계로 좌우 전후 확인, 3. 그릴에 물을 부어 물받이통 배수 확인"
                      width="1200"
                      height="670"
                      loading="eager"
                      decoding="async"
                    />
                    <figcaption className="guide-illus-steps">
                      <span><strong>① 조절볼트 4개</strong> 내려 고정</span>
                      <span><strong>② 휴대폰 수평계</strong> 좌우·전후 맞춤</span>
                      <span><strong>③ 물 부어 확인</strong> 물받이통 배수</span>
                    </figcaption>
                  </figure>
                  <ol className="guide-ol guide-details-body">
                    {GUIDE_SECTIONS.levelingSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </div>
              </div>
            </details>
          </section>

          {/* 07. 리뷰 이벤트 전용 화면 바로가기 */}
          <section className="guide-sheet guide-manual-review-promo" aria-labelledby="heading-manual-review">
            <div className="guide-sec-header">
              <span className="guide-sec-num guide-sec-num--green mono">07</span>
              <h2 id="heading-manual-review" className="guide-sec-heading">리뷰 남기고 현금 최대 14만원 받기</h2>
            </div>
            <p className="guide-manual-review-desc">
              블로그(7만) · 인스타·쓰레드(4만) · 구글 리뷰(3만) 중복 참여 가능 (+스마트스토어 3만원 별도)
            </p>
            <button
              type="button"
              className="guide-btn guide-btn--event"
              onClick={() => openReviewView('blog')}
            >
              리뷰 이벤트 크게 보고 참여하기 →
            </button>
          </section>

          {/* 08. 카카오톡 A/S & 담당자 문의 */}
          <section id="sec-support" className="guide-sheet guide-as-sheet" aria-labelledby="heading-as">
            <div className="guide-sec-header">
              <span className="guide-sec-num mono">08</span>
              <h2 id="heading-as" className="guide-sec-heading">무상 A/S · 카카오톡 바로 문의</h2>
            </div>
            <p className="guide-as-desc">
              무상 A/S 기간은 출고일로부터 <strong>{SHOWCASE_GUIDE_BRAND.freeWarrantyMonths}개월</strong>입니다.
              제품 이상이나 증상 사진이 있을 때 아래 카카오톡 채널로 바로 접수해 주세요.
            </p>

            <div className="guide-as-actions">
              <a
                className="guide-btn guide-btn--kakao"
                href={SHOWCASE_GUIDE_BRAND.asKakaoChatUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleKakaoInquiry}
              >
                {SHOWCASE_GUIDE_BRAND.asKakaoLabel} ↗
              </a>

              {inquiryRoute.kind === 'kakao' && (
                <a
                  className="guide-btn guide-btn--secondary"
                  href={inquiryRoute.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleKakaoInquiry}
                >
                  담당자 카카오톡 문의 ({inquiryRoute.manager}) ↗
                </a>
              )}

              {inquiryRoute.kind === 'sms' && (
                <a className="guide-btn guide-btn--secondary" href={inquiryRoute.href}>
                  담당자 문자 문의 ({inquiryRoute.manager} · {inquiryRoute.phone})
                </a>
              )}

              {orderNo && (
                <div className="guide-inquiry-hint" role="status">
                  {inquiryCopied
                    ? '주문번호가 복사되었습니다. 채팅창에 붙여넣어 주세요.'
                    : '버튼을 누르면 주문번호가 자동 복사됩니다.'}
                </div>
              )}
            </div>

            <div className="guide-sub-links">
              {data && token && (
                <Link className="guide-text-link" to={`/track/${encodeURIComponent(token)}`}>
                  내 주문 진행현황 보기 →
                </Link>
              )}
              <a
                className="guide-text-link"
                href={SHOWCASE_GUIDE_BRAND.legacyManualUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                기존 자주 묻는 질문 / 설명서 보기 ↗
              </a>
            </div>
          </section>
            </main>
          </>
        )}
      </div>

      <footer className="guide-foot">
        <strong>(주){SHOWCASE_GUIDE_BRAND.name} ({SHOWCASE_GUIDE_BRAND.en})</strong>
        <span> · 무상 A/S {SHOWCASE_GUIDE_BRAND.freeWarrantyMonths}개월 · {SHOWCASE_GUIDE_BRAND.asChannelShort}</span>
      </footer>

      {/* 이미지 크게 보기 확대 모달 */}
      {zoomedPoster && (
        <div
          className="guide-zoom-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${zoomedPoster.title} 이미지 크게 보기`}
          onClick={() => setZoomedPoster(null)}
        >
          <div className="guide-zoom-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="guide-zoom-bar">
              <strong className="guide-zoom-title">{zoomedPoster.title}</strong>
              <button
                type="button"
                className="guide-zoom-close"
                onClick={() => setZoomedPoster(null)}
              >
                닫기 ✕
              </button>
            </div>
            <div className="guide-zoom-img-wrap">
              <img
                className="guide-zoom-img"
                src={zoomedPoster.src}
                alt={zoomedPoster.alt}
              />
            </div>
          </div>
        </div>
      )}

      {/* 모바일·태블릿 하단 고정 A/S & 화면 복귀 바 (< 1024px) */}
      <div className="guide-mobile-dock" role="region" aria-label="빠른 도움 및 화면 이동">
        {viewMode === 'review' ? (
          <button
            type="button"
            className="guide-dock-top-btn"
            onClick={() => openManualView()}
          >
            ← 설명서
          </button>
        ) : (
          <button type="button" className="guide-dock-top-btn" onClick={scrollToTop}>
            맨 위로 ↑
          </button>
        )}
        <a
          className="guide-dock-call-btn guide-dock-call-btn--kakao"
          href={SHOWCASE_GUIDE_BRAND.asKakaoChatUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleKakaoInquiry}
        >
          {SHOWCASE_GUIDE_BRAND.asKakaoLabel}
        </a>
      </div>
    </div>
  );
}
