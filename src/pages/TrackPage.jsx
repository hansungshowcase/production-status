import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { getTrackInfo, TrackApiError } from '../api/track';
import './TrackPage.css';

/* ── 상수 ─────────────────────────────────────────── */
const STAGES = ['접수', '제작중', '포장완료', '출고완료'];
const REFRESH_INTERVAL = 5 * 60 * 1000; // 5분

/* ── 인라인 아이콘 (목업과 동일) ───────────────────── */
const IconTruck = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 6h11v9H3zM14 9h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.6" /><circle cx="17" cy="18" r="1.6" />
  </svg>
);
const IconCal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v3M16 3v3" />
  </svg>
);
const IconCam = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" /><circle cx="12" cy="13" r="3.2" />
  </svg>
);

/* ── 헬퍼 ─────────────────────────────────────────── */
function dateOnly(s) {
  if (!s) return null;
  return String(s).slice(0, 10);
}

function fmtDate(s) {
  const d = dateOnly(s);
  if (!d) return '-';
  const p = d.split('-');
  if (p.length !== 3) return d;
  return `${p[0]}년 ${parseInt(p[1], 10)}월 ${parseInt(p[2], 10)}일`;
}

function weekday(s) {
  const ds = dateOnly(s);
  if (!ds) return '';
  const d = new Date(`${ds}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return `${['일', '월', '화', '수', '목', '금', '토'][d.getDay()]}요일`;
}

function dday(s) {
  const ds = dateOnly(s);
  if (!ds) return null;
  const t = new Date(`${ds}T00:00:00`);
  if (Number.isNaN(t.getTime())) return null;
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  const diff = Math.round((t - n) / 86400000);
  if (diff > 0) return `D-${diff}`;
  if (diff === 0) return 'D-DAY';
  return null;
}

function isStepDone(status) {
  return status === 'done' || status === 'completed';
}

/** 응답에서 완료/전체 공정 수 파생 (progress 우선, steps 폴백) */
function deriveProgress(data) {
  if (data.progress && data.progress.total) {
    return {
      completed: Number(data.progress.completed) || 0,
      total: Number(data.progress.total) || 10,
    };
  }
  if (Array.isArray(data.steps) && data.steps.length > 0) {
    return {
      completed: data.steps.filter((s) => isStepDone(s.status)).length,
      total: data.steps.length,
    };
  }
  return { completed: 0, total: 10 };
}

/** 10개 공정 → 고객친화적 4단계 (접수/제작중/포장완료/출고완료) */
function customerStage(data, completed, total) {
  if (data.status === 'shipped' || (total > 0 && completed >= total)) return 3;
  if (total > 0 && completed >= total - 1) return 2;
  if (completed >= 1) return 1;
  return 0;
}

/** delivery_status — 응답값 우선, 없으면 프론트 폴백 파생 (확률·리스크 등급은 절대 노출 안 함) */
function deriveDeliveryStatus(data) {
  if (data.delivery_status) return data.delivery_status;
  if (data.status === 'shipped') return 'shipped';
  if (data.ship_scheduled_date) return 'rescheduled';
  const due = dateOnly(data.due_date);
  if (due) {
    // KST 오늘 날짜 = UTC epoch + 9시간의 ISO 날짜부
    const kstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    if (due < kstToday) return 'adjusting';
  }
  return 'on_track';
}

/* ── 서브 컴포넌트 ─────────────────────────────────── */
function Stepper({ stage, shipped }) {
  return (
    <div className="track-stepper">
      {STAGES.map((name, i) => {
        let cls = 'track-step';
        if (i < stage) cls += ' done';
        else if (i === stage) cls += ' current';
        if (i === 3 && stage === 3) cls += ' done ship';
        const barCls = `track-step-bar${i <= stage ? ' filled' : ''}`;
        const inner = i < stage || (i === 3 && shipped) ? '✓' : i + 1;
        return (
          <div className={cls} key={name}>
            <span className={barCls} />
            <div className="track-step-node">{inner}</div>
            <div className="track-step-name">{name}</div>
          </div>
        );
      })}
    </div>
  );
}

function ShipBox({ data, deliveryStatus }) {
  if (data.status === 'shipped') {
    return (
      <div className="track-hero track-hero--done">
        <div className="track-dstat resch">출고 완료</div>
        <div className="track-hero-lbl">출고 완료일</div>
        <div className="track-hero-date">{fmtDate(data.ship_date)}</div>
        <div className="track-hero-sub">{weekday(data.ship_date)}</div>
      </div>
    );
  }
  if (deliveryStatus === 'adjusting') {
    // 조정 중: 기존 납기(due_date)·D-day를 숨기고 재안내 예정만 표시
    return (
      <div className="track-hero">
        <div className="track-dstat adj">출고일 조정 중</div>
        <div className="track-hero-lbl">예상 출고일</div>
        <div className="track-hero-date track-hero-date--sm">확인 후 다시 안내드립니다</div>
      </div>
    );
  }
  if (deliveryStatus === 'rescheduled') {
    // 조정 확정: 새 출고예정일만 크게 표시, 원래 due_date는 비노출
    const nd = dday(data.ship_scheduled_date);
    return (
      <div className="track-hero">
        <div className="track-dstat resch">새 출고예정일</div>
        <div className="track-hero-date">{fmtDate(data.ship_scheduled_date)}</div>
        <div className="track-hero-sub">
          {weekday(data.ship_scheduled_date)}{nd ? <span className="track-dday">{nd}</span> : null}
        </div>
        <div className="track-hero-note">일정이 조정되어 문자·카카오톡으로 안내드렸습니다. 양해 감사드립니다.</div>
      </div>
    );
  }
  // on_track
  const dd = dday(data.due_date);
  return (
    <div className="track-hero">
      <div className="track-dstat ok">예정대로 진행 중</div>
      <div className="track-hero-lbl">예상 출고(납기)일</div>
      <div className="track-hero-date">{fmtDate(data.due_date)}</div>
      <div className="track-hero-sub">
        {weekday(data.due_date)}{dd ? <span className="track-dday">{dd}</span> : null}
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div aria-busy="true" aria-label="불러오는 중">
      <div className="track-card">
        <div className="track-skel" style={{ width: '38%', height: 13 }} />
        <div className="track-skel" style={{ width: '62%', height: 24, marginTop: 10 }} />
        <div className="track-skel" style={{ width: '45%', height: 12, marginTop: 8 }} />
        <div className="track-skel" style={{ width: '100%', height: 64, marginTop: 22 }} />
        <div className="track-skel" style={{ width: '100%', height: 9, marginTop: 18, borderRadius: 999 }} />
      </div>
      <div className="track-card">
        <div className="track-skel" style={{ width: '30%', height: 13 }} />
        <div className="track-skel" style={{ width: '100%', height: 90, marginTop: 12 }} />
      </div>
    </div>
  );
}

function NotFoundCard() {
  return (
    <div className="track-card track-notfound" role="alert">
      <div className="track-notfound-emoji" aria-hidden="true">🔍</div>
      <div className="track-notfound-title">주문을 찾을 수 없습니다</div>
      <div className="track-notfound-sub">링크를 다시 확인해 주세요</div>
    </div>
  );
}

function ErrorCard({ message, onRetry }) {
  return (
    <div className="track-card track-notfound" role="alert">
      <div className="track-notfound-emoji" aria-hidden="true">⚠️</div>
      <div className="track-notfound-title">일시적인 오류가 발생했습니다</div>
      <div className="track-notfound-sub">{message}</div>
      <button type="button" className="track-retry-btn" onClick={onRetry}>다시 시도</button>
    </div>
  );
}

/* ── 메인 페이지 ───────────────────────────────────── */
export default function TrackPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const mountedRef = useRef(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setNotFound(false);
      setError(null);
    }
    try {
      const res = await getTrackInfo(token);
      if (!mountedRef.current) return;
      setData(res);
      setNotFound(false);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof TrackApiError && err.status === 404) {
        setNotFound(true);
        setData(null);
      } else if (!silent) {
        // 자동 새로고침(silent) 실패 시엔 기존 데이터를 그대로 유지
        setError(err.message || '오류가 발생했습니다');
      }
    } finally {
      if (mountedRef.current && !silent) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    mountedRef.current = true;
    load(false);
    const intervalId = setInterval(() => load(true), REFRESH_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [load]);

  const { completed, total } = data ? deriveProgress(data) : { completed: 0, total: 10 };
  const shipped = data?.status === 'shipped';
  const stage = data ? customerStage(data, completed, total) : 0;
  const deliveryStatus = data ? deriveDeliveryStatus(data) : 'on_track';
  const clientName = data ? (data.client_name_masked || data.client_name || '고객님') : '';
  const currentStep = data?.current_step || (shipped ? '출고' : '');
  // 주문번호: API 의 정식 표시번호(order_no) 우선, 없으면 토큰 축약 표기
  const orderNo = data?.order_no
    ? `#${data.order_no}`
    : (token ? `#HS-${String(token).slice(0, 6).toUpperCase()}` : '');
  const managerName = data?.manager_name || null;

  // 카카오 문의 클릭 → 주문번호·담당자가 담긴 문의 문구를 클립보드에 복사 (채팅방에 붙여넣기용)
  // 복사 실패해도 채팅방 이동은 그대로 진행
  const [inquiryCopied, setInquiryCopied] = useState(false);
  // 카카오 문의 클릭 → 주문정보+담당자를 클립보드에 자동 복사 (채널 채팅에 붙여넣기)
  // ※ 카카오톡 채팅은 링크로 메시지 자동입력을 지원하지 않아 '복사→붙여넣기'가 최선
  const buildInquiryText = () => {
    const product = [data?.product_type, data?.door_type].filter(Boolean).join(' ');
    const lines = [
      '[한성쇼케이스 주문 문의]',
      `· 주문번호: ${orderNo.replace(/^#/, '')}`,
    ];
    if (product) lines.push(`· 제품: ${product}`);
    if (managerName) lines.push(`· 담당: ${managerName}`);
    lines.push('', '문의 내용: ');
    return lines.join('\n');
  };
  const handleKakaoInquiry = () => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(buildInquiryText());
        setInquiryCopied(true);
        setTimeout(() => setInquiryCopied(false), 2500);
      }
    } catch { /* 복사 불가 브라우저 — 링크 이동만 수행 */ }
  };

  let hint = null;
  if (data) {
    if (shipped) hint = <>출고가 완료되었습니다. 배송 관련 안내를 확인해 주세요.</>;
    else if (stage === 2) hint = <>포장이 완료되어 곧 출고 예정입니다.</>;
    else if (currentStep) hint = <>현재 <b>{currentStep}</b> 공정을 진행하고 있습니다.</>;
    else hint = <>주문이 접수되어 제작 준비 중입니다.</>;
  }

  return (
    <div className="track-page">
      <div className="track-wrap">
        <header className="track-header">
          <div className="track-logo">HS</div>
          <div>
            <div className="track-brand-name">한성쇼케이스</div>
            <div className="track-brand-sub">주문제작 진행현황 안내</div>
          </div>
        </header>

        <main>
          {loading && <LoadingSkeleton />}
          {!loading && notFound && <NotFoundCard />}
          {!loading && !notFound && error && !data && (
            <ErrorCard message={error} onRetry={() => load(false)} />
          )}

          {!loading && !notFound && data && (
            <>
              {/* 출고일 / 납기 상태 — 가장 크게 (고객이 제일 궁금한 정보) */}
              <ShipBox data={data} deliveryStatus={deliveryStatus} />

              {/* 진행 카드 */}
              <div className="track-card">
                <div className="track-status-line">
                  <span className={`track-dot${shipped ? ' ship' : ''}`} />
                  <span className="track-status-label">{shipped ? '출고 완료' : '제작 진행중'}</span>
                  <span className="track-order-no">{orderNo}</span>
                </div>
                <div className="track-client">{clientName}</div>

                <Stepper stage={stage} shipped={shipped} />

                <div className="track-now">
                  <span className="track-now-hint">{hint}</span>
                  {!shipped && (
                    <span className="track-now-frac">{completed}/{total} 공정</span>
                  )}
                </div>

                {Array.isArray(data.steps) && data.steps.length > 0 && (
                  <div className="track-steps">
                    <div className="track-steps-title">상세 제작 공정</div>
                    {data.steps.map((s, i) => {
                      const done = isStepDone(s.status);
                      const inprog = s.status === 'in_progress';
                      return (
                        <div
                          className={`track-steps-row${done ? ' done' : inprog ? ' cur' : ''}`}
                          key={`${s.name}-${i}`}
                        >
                          <span className="track-steps-dot">{done ? '✓' : i + 1}</span>
                          <span className="track-steps-name">{s.name}</span>
                          <span className="track-steps-stat">
                            {done ? '완료' : inprog ? '진행중' : '대기'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 제품 정보 */}
              <div className="track-card">
                <div className="track-sec-title">제품 정보</div>
                <div className="track-spec">
                  <div className="track-spec-cell full">
                    <div className="track-spec-k">제품</div>
                    <div className="track-spec-v">
                      {[data.product_type, data.door_type].filter(Boolean).join(' · ') || '-'}
                    </div>
                  </div>
                  <div className="track-spec-cell">
                    <div className="track-spec-k">규격 (가로×세로×높이)</div>
                    <div className="track-spec-v mono">
                      {(data.size?.width ?? data.width) || '-'}×{(data.size?.depth ?? data.depth) || '-'}×{(data.size?.height ?? data.height) || '-'} mm
                    </div>
                  </div>
                  <div className="track-spec-cell">
                    <div className="track-spec-k">수량</div>
                    <div className="track-spec-v">{data.quantity != null ? `${data.quantity} 대` : '-'}</div>
                  </div>
                  <div className="track-spec-cell full">
                    <div className="track-spec-k">색상</div>
                    <div className="track-spec-v">
                      {data.color_hex && <span className="track-swatch" style={{ background: data.color_hex }} />}
                      {data.color || '-'}
                    </div>
                  </div>
                </div>
              </div>

              {/* 포장 완료 사진 */}
              {data.packing_photo_url ? (
                <div className="track-card">
                  <div className="track-sec-title">포장 완료 사진</div>
                  <div className="track-photo">
                    <img alt="포장 완료 사진" src={data.packing_photo_url} loading="lazy" />
                    <div className="track-photo-cap"><IconCam /> 실제 출고 제품의 포장 상태입니다</div>
                  </div>
                </div>
              ) : stage >= 1 && !shipped ? (
                <div className="track-card">
                  <div className="track-sec-title">포장 완료 사진</div>
                  <div className="track-photo-empty">
                    <IconCam />
                    <div className="track-photo-empty-t">아직 준비 전이에요</div>
                    <div className="track-photo-empty-s">포장이 완료되면 이 곳에 사진이 올라옵니다</div>
                  </div>
                </div>
              ) : null}

              {/* 문의 안내 — 카카오톡 채널 채팅으로만 접수 (전화 문의 없음).
                  클릭 시 주문번호·담당자 문구 자동 복사 → 채널 채팅에서 담당자 즉시 식별 */}
              <div className="track-notice">
                <b>궁금하신 점이 있으신가요?</b><br />
                제작·출고 일정은 이 페이지에서 실시간으로 안내됩니다. 추가 문의는 카카오톡으로 편하게 남겨주세요.
                {managerName ? (
                  <div className="track-manager">담당 영업: <b>{managerName}</b></div>
                ) : null}
                <a
                  className="track-btn-kakao"
                  href="http://pf.kakao.com/_vxmpfn/chat"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleKakaoInquiry}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
                    <path d="M12 3C6.48 3 2 6.58 2 10.5c0 2.52 1.65 4.73 4.13 6.01l-.98 3.62c-.09.32.28.58.56.4l4.34-2.86c.63.09 1.28.13 1.95.13 5.52 0 10-3.58 10-7.5S17.52 3 12 3z" />
                  </svg>
                  카카오톡으로 문의하기
                </a>
                <div className="track-inquiry-hint">
                  {inquiryCopied
                    ? '주문번호가 복사되었습니다. 채팅창에 붙여넣어 주세요 ✓'
                    : '버튼을 누르면 주문번호가 자동 복사됩니다'}
                </div>
              </div>
            </>
          )}
        </main>

        <div className="track-refresh">
          <span className="track-live" />
          <span>약 5분마다 자동으로 새로고침됩니다</span>
        </div>

        <div className="track-foot">
          <div className="track-foot-co">한성쇼케이스</div>
          <div>업소용 냉장·냉동 쇼케이스 주문제작</div>
          {updatedAt && (
            <div className="track-foot-updated">
              마지막 업데이트 {String(updatedAt.getHours()).padStart(2, '0')}:{String(updatedAt.getMinutes()).padStart(2, '0')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
