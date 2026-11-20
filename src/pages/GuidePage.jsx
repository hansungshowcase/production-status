import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { getTrackInfo, TrackApiError } from '../api/track';
import { resolveInquiryRoute } from './inquiryRouting';
import {
  DEFAULT_SHOWCASE_SETTING,
  GUIDE_SECTIONS,
  SHOWCASE_GUIDE_BRAND,
  SHOWCASE_GUIDE_PRESETS,
  calculateWarrantyEndDate,
  formatDotDate,
  getGuidePresetByKey,
  resolveGuidePresetKey,
} from '../../shared/showcaseGuide.js';
import './GuidePage.css';

function GuideSkeleton() {
  return (
    <div className="guide-card" aria-busy="true" aria-label="안내 정보를 불러오는 중">
      <div className="guide-skel" style={{ width: '42%', height: 14 }} />
      <div className="guide-skel" style={{ width: '68%', height: 24, marginTop: 10 }} />
      <div className="guide-skel" style={{ width: '100%', height: 74, marginTop: 14 }} />
    </div>
  );
}

export default function GuidePage() {
  const { token } = useParams();
  const hasToken = Boolean(String(token || '').trim());
  const [searchParams] = useSearchParams();
  const queryPresetKey = searchParams.get('p');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(hasToken);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState('');
  const [inquiryCopied, setInquiryCopied] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    if (!hasToken) {
      setData(null);
      setNotFound(false);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setNotFound(false);
    setError('');
    try {
      const res = await getTrackInfo(token);
      if (!mountedRef.current) return;
      setData(res);
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof TrackApiError && err.status === 404) {
        setNotFound(true);
        setData(null);
      } else {
        setError(err?.message || '주문 정보를 불러오지 못했습니다.');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [hasToken, token]);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
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
            setInquiryCopied(true);
            setTimeout(() => {
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

  return (
    <div className="guide-page">
      <div className="guide-wrap">
        <header className="guide-header">
          <div className="guide-logo">HS</div>
          <div className="guide-header-text">
            <div className="guide-brand">{SHOWCASE_GUIDE_BRAND.name}</div>
            <div className="guide-sub">제품 사용설명서 &amp; 사후관리 안내</div>
          </div>
          {!notFound && orderNo && <span className="guide-order-badge">{orderNo}</span>}
        </header>

        <nav className="guide-nav" aria-label="안내 바로가기">
          <a href="#sec-safety" className="guide-nav-chip">필수주의</a>
          <a href="#sec-controller" className="guide-nav-chip">온도·제상</a>
          <a href="#sec-radiator" className="guide-nav-chip">라지에이터 청소</a>
          <a href="#sec-leveling" className="guide-nav-chip">수평조절</a>
          <a href="#sec-support" className="guide-nav-chip">후기·A/S</a>
        </nav>

        <main>
          {loading && <GuideSkeleton />}

          {!loading && notFound && (
            <div className="guide-card guide-alert-card" role="alert">
              <div className="guide-alert-title">주문별 상세 정보를 찾을 수 없습니다</div>
              <p className="guide-alert-desc">
                링크가 만료되었거나 올바르지 않을 수 있습니다. 아래 공통 사용설명서·청소 방법과
                A/S 연락처({SHOWCASE_GUIDE_BRAND.asPhone})는 그대로 이용하실 수 있습니다.
              </p>
            </div>
          )}

          {!loading && !notFound && error && !data && (
            <div className="guide-card guide-alert-card" role="alert">
              <div className="guide-alert-title">주문 정보를 잠시 불러오지 못했습니다</div>
              <p className="guide-alert-desc">{error}</p>
              <button type="button" className="guide-btn guide-btn--primary" onClick={load}>
                다시 시도
              </button>
            </div>
          )}

          {!loading && data && (
            <section className="guide-card guide-hero-card">
              <div className="guide-sec-title">내 제품 &amp; 무상 A/S 보증 정보</div>
              <div className="guide-client-row">
                <div className="guide-client-name">
                  {data.client_name_masked || data.client_name || '고객님'}
                </div>
                <span className={`guide-warranty-pill${isShipped ? ' guide-warranty-pill--active' : ''}`}>
                  {isShipped ? '무상 A/S 적용 중' : '출고 확인 중'}
                </span>
              </div>

              <div className="guide-spec-grid">
                <div className="guide-spec-cell">
                  <div className="guide-spec-k">출고일자</div>
                  <div className="guide-spec-v mono">
                    {isShipped ? formatDotDate(data.ship_date) : '출고 처리 전'}
                  </div>
                </div>
                <div className="guide-spec-cell">
                  <div className="guide-spec-k">무상 A/S (12개월)</div>
                  <div className="guide-spec-v mono">
                    {warrantyEndDate ? `~ ${formatDotDate(warrantyEndDate)}` : '출고일로부터 12개월'}
                  </div>
                </div>
                {data.door_type && (
                  <div className="guide-spec-cell">
                    <div className="guide-spec-k">문형</div>
                    <div className="guide-spec-v">{data.door_type}</div>
                  </div>
                )}
                {sizeText && (
                  <div className="guide-spec-cell">
                    <div className="guide-spec-k">규격 (가로×세로×높이)</div>
                    <div className="guide-spec-v mono">{sizeText} mm</div>
                  </div>
                )}
                <div className="guide-spec-cell">
                  <div className="guide-spec-k">수량</div>
                  <div className="guide-spec-v">{data.quantity != null ? `${data.quantity} 대` : '-'}</div>
                </div>
                <div className="guide-spec-cell">
                  <div className="guide-spec-k">색상</div>
                  <div className="guide-spec-v">{data.color || '-'}</div>
                </div>
              </div>
              <div className="guide-sticker-warn">
                * 제품에 부착된 라벨 스티커 훼손 시 사후관리의 불이익을 받을 수 있습니다.
              </div>
            </section>
          )}

          {/* 맞춤 권장 온도 & 제상 세팅 */}
          <section className="guide-card guide-preset-card">
            <div className="guide-sec-title">권장 온도 · 제상 세팅</div>
            <div className="guide-preset-head">
              <span className="guide-preset-badge">{setting.label}</span>
              <span className="guide-preset-range">설정 가능 {setting.tempRange}</span>
            </div>
            <div className="guide-preset-metrics">
              <div className="guide-metric">
                <div className="guide-metric-k">출하 설정 온도</div>
                <div className="guide-metric-v">{setting.factoryTemp}</div>
              </div>
              <div className="guide-metric">
                <div className="guide-metric-k">제상주기</div>
                <div className="guide-metric-v">{setting.defrostCycle}</div>
              </div>
              <div className="guide-metric">
                <div className="guide-metric-k">제상시간</div>
                <div className="guide-metric-v">{setting.defrostTime}</div>
              </div>
            </div>
          </section>

          {/* 1. 필수 안전·설치 수칙 */}
          <section id="sec-safety" className="guide-card">
            <div className="guide-sec-title">필수 안전 · 설치 수칙</div>
            <div className="guide-rule-list">
              {GUIDE_SECTIONS.safetyRules.map((rule, index) => (
                <div
                  key={rule.title}
                  className={`guide-rule${rule.emphasis ? ' guide-rule--danger' : ''}`}
                >
                  <div className="guide-rule-title">
                    <span className="guide-rule-num">{index + 1}</span>
                    {rule.title}
                  </div>
                  <p className="guide-rule-body">{rule.body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* 2. 온도조절기 조작 & 제상 안내 */}
          <section id="sec-controller" className="guide-card">
            <div className="guide-sec-title">온도조절기 조작 &amp; 제상 설정</div>

            <div className="guide-callout guide-callout--info">
              <strong>&ldquo;def&rdquo; 표시 안내</strong>
              <p>{GUIDE_SECTIONS.defNotice}</p>
            </div>

            <div className="guide-subsec">
              <h3 className="guide-subsec-title">버튼 조작 방법</h3>
              <dl className="guide-dl">
                {GUIDE_SECTIONS.buttons.map((btn) => (
                  <div key={btn.name} className="guide-dl-row">
                    <dt>{btn.name}</dt>
                    <dd>{btn.desc}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="guide-subsec">
              <h3 className="guide-subsec-title">설정 온도 변경 방법</h3>
              <ol className="guide-ol">
                {GUIDE_SECTIONS.tempSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            <div className="guide-subsec">
              <h3 className="guide-subsec-title">제상 주기 · 시간 설정 방법</h3>
              <ol className="guide-ol">
                {GUIDE_SECTIONS.defrostSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>

            <div className="guide-callout guide-callout--warn">
              <strong>과도한 저온 설정 주의</strong>
              <p>{GUIDE_SECTIONS.controllerNote}</p>
            </div>

            <div className="guide-subsec">
              <h3 className="guide-subsec-title">품목별 평균 제상 주기 · 시간 · 온도 표</h3>
              <div className="guide-table-wrap">
                <table className="guide-table">
                  <thead>
                    <tr>
                      <th>제품타입</th>
                      <th>설정 가능</th>
                      <th>출하 온도</th>
                      <th>제상주기</th>
                      <th>제상시간</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SHOWCASE_GUIDE_PRESETS.map((row) => {
                      const isActive = activePreset?.key === row.key;
                      return (
                        <tr key={row.key} className={isActive ? 'guide-table-row--active' : ''}>
                          <td>
                            {row.label}
                            {isActive && <span className="guide-row-tag">적용중</span>}
                          </td>
                          <td>{row.tempRange}</td>
                          <td>{row.factoryTemp}</td>
                          <td>{row.defrostCycle}</td>
                          <td>{row.defrostTime}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* 3. 라지에이터 청소 방법 */}
          <section id="sec-radiator" className="guide-card">
            <div className="guide-sec-title">라지에이터 청소 방법 (월 1회 이상)</div>
            <ol className="guide-ol">
              {GUIDE_SECTIONS.radiatorCleaning.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className="guide-callout guide-callout--danger">
              <strong>청소 미이행 시 유의사항</strong>
              <ul className="guide-ul">
                {GUIDE_SECTIONS.radiatorCleaning.warnings.map((warn) => (
                  <li key={warn}>{warn}</li>
                ))}
              </ul>
            </div>
          </section>

          {/* 4. 수평 맞추는 방법 */}
          <section id="sec-leveling" className="guide-card">
            <div className="guide-sec-title">쇼케이스 수평 맞추는 방법</div>
            <details className="guide-details">
              <summary className="guide-details-summary">
                설치 시 수평 조절 · 배수 확인 3단계 보기
              </summary>
              <ol className="guide-ol guide-details-body">
                {GUIDE_SECTIONS.levelingSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          </section>

          {/* 5. 블로그 후기 이벤트 & A/S 문의 */}
          <section id="sec-support" className="guide-card guide-event-card">
            <div className="guide-event-badge">고객 감사 이벤트</div>
            <h2 className="guide-event-title">블로그 후기 남기고 현금 6만원 받자!</h2>
            <p className="guide-event-desc">
              제품 설치 사진과 사용 후기를 블로그에 남겨주시면 확인 후 현금 6만원 혜택을 드립니다.
            </p>
            <a
              className="guide-btn guide-btn--event"
              href={SHOWCASE_GUIDE_BRAND.blogReviewUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              후기 이벤트 안내 바로가기 ↗
            </a>
          </section>

          <section className="guide-card guide-support-card">
            <div className="guide-sec-title">A/S 및 고객 문의</div>
            <p className="guide-support-desc">
              무상 A/S 기간은 출고일로부터 {SHOWCASE_GUIDE_BRAND.freeWarrantyMonths}개월입니다.
              제품 이상 시 아래 A/S 센터 또는 담당자에게 연락해 주세요.
            </p>

            <div className="guide-support-actions">
              <a className="guide-btn guide-btn--primary" href={SHOWCASE_GUIDE_BRAND.asPhoneHref}>
                A/S 전화 연결 ({SHOWCASE_GUIDE_BRAND.asPhone})
              </a>

              {inquiryRoute.kind === 'kakao' && (
                <>
                  <a
                    className="guide-btn guide-btn--kakao"
                    href={inquiryRoute.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={handleKakaoInquiry}
                  >
                    카카오톡으로 문의하기 ({inquiryRoute.manager})
                  </a>
                  <div className="guide-inquiry-hint">
                    {inquiryCopied
                      ? '주문번호가 복사되었습니다. 채팅창에 붙여넣어 주세요 ✓'
                      : '버튼을 누르면 주문번호가 자동 복사됩니다'}
                  </div>
                </>
              )}

              {inquiryRoute.kind === 'sms' && (
                <a className="guide-btn guide-btn--secondary" href={inquiryRoute.href}>
                  담당자에게 문자 문의 ({inquiryRoute.manager} · {inquiryRoute.phone})
                </a>
              )}

              {!hasToken && (
                <a
                  className="guide-btn guide-btn--kakao"
                  href={SHOWCASE_GUIDE_BRAND.kakaoChatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  카카오톡 채널 문의하기
                </a>
              )}
            </div>

            <div className="guide-sub-links">
              {data && token && (
                <Link className="guide-text-link" to={`/track/${encodeURIComponent(token)}`}>
                  주문 진행현황 보기 →
                </Link>
              )}
              <a
                className="guide-text-link"
                href={SHOWCASE_GUIDE_BRAND.legacyManualUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                자주 묻는 질문 / 기존 설명서 보기 ↗
              </a>
            </div>
          </section>
        </main>

        <footer className="guide-foot">
          <strong>{SHOWCASE_GUIDE_BRAND.name}</strong> · A/S {SHOWCASE_GUIDE_BRAND.asPhone}
        </footer>
      </div>
    </div>
  );
}
