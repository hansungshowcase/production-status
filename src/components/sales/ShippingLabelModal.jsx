import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTrackLink } from '../../api/orders';
import { getKstToday, isCanonicalCalendarDate } from '../../utils/dateUtils';
import { safeGet, safeSet } from '../../utils/safeStorage';
import { useDialogFocus } from '../../utils/useDialogFocus';
import {
  DEFAULT_SHOWCASE_SETTING,
  SHOWCASE_GUIDE_PRESETS,
  resolveGuidePresetKey,
} from '../../../shared/showcaseGuide.js';
import {
  DEFAULT_LABEL_SIZE_KEY,
  LABEL_SIZES,
  LABEL_SIZE_STORAGE_KEY,
  buildShippingLabelData,
  buildShippingLabelPrintHtml,
  getDefaultLabelCopies,
} from './shippingLabels';
import './ShippingLabelModal.css';

function initialShipDate(order) {
  const candidates = [order?.ship_date, order?.ship_scheduled_date, getKstToday()];
  for (const candidate of candidates) {
    const iso = String(candidate || '').trim().slice(0, 10);
    if (isCanonicalCalendarDate(iso)) return iso;
  }
  return getKstToday();
}

function initialSizeKey() {
  const saved = safeGet(LABEL_SIZE_STORAGE_KEY);
  return saved && Object.hasOwn(LABEL_SIZES, saved) ? saved : DEFAULT_LABEL_SIZE_KEY;
}

function parseCopiesForPrint(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(20, parsed));
}

export default function ShippingLabelModal({ active = true, order, onClose }) {
  const dialogRef = useRef(null);
  const closeButtonRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const autoPresetKey = useMemo(
    () => resolveGuidePresetKey(order?.product_type, order?.door_type),
    [order?.product_type, order?.door_type],
  );

  const [sizeKey, setSizeKey] = useState(initialSizeKey);
  const [presetKey, setPresetKey] = useState(() => autoPresetKey || '');
  const [shipDate, setShipDate] = useState(() => initialShipDate(order));
  const [copiesInput, setCopiesInput] = useState(() => String(getDefaultLabelCopies(order)));

  const [token, setToken] = useState('');
  const [baseOrigin, setBaseOrigin] = useState('https://production-status.vercel.app');
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [printError, setPrintError] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const prevInitRef = useRef({ active: false, id: null });
  const printTimersRef = useRef([]);

  const clearPrintTimers = useCallback(() => {
    printTimersRef.current.forEach((timerId) => clearTimeout(timerId));
    printTimersRef.current = [];
  }, []);

  useEffect(() => {
    if (!active) {
      prevInitRef.current = { active: false, id: null };
      clearPrintTimers();
      setToken('');
      setTokenError('');
      setPrintError('');
      setBaseOrigin('https://production-status.vercel.app');
      return;
    }
    const currentOrderId = order?.id ?? null;
    const prev = prevInitRef.current;
    if (!prev.active || prev.id !== currentOrderId) {
      prevInitRef.current = { active: true, id: currentOrderId };
      clearPrintTimers();
      setPresetKey(autoPresetKey || '');
      setShipDate(initialShipDate(order));
      setCopiesInput(String(getDefaultLabelCopies(order)));
      setToken('');
      setTokenError('');
      setPrintError('');
      setBaseOrigin('https://production-status.vercel.app');
    }
  }, [active, order, autoPresetKey, clearPrintTimers]);

  useEffect(() => () => {
    clearPrintTimers();
  }, [clearPrintTimers]);

  const handleEscape = useCallback(() => {
    onCloseRef.current?.();
  }, []);

  useDialogFocus({
    active,
    dialogRef,
    initialFocusRef: closeButtonRef,
    onEscape: handleEscape,
  });

  const loadToken = useCallback(async (cancelledRef) => {
    if (!order?.id) {
      setTokenError('주문 ID가 없어 QR 링크를 발급할 수 없습니다.');
      setTokenLoading(false);
      return;
    }
    setTokenLoading(true);
    setTokenError('');
    try {
      const res = await getTrackLink(order.id);
      if (cancelledRef?.current) return;
      if (!res?.token) {
        throw new Error('주문 조회 토큰을 발급받지 못했습니다.');
      }
      setToken(res.token);
      if (res.guide_url) {
        try {
          const parsedUrl = new URL(res.guide_url);
          if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
            setBaseOrigin(parsedUrl.origin);
          }
        } catch {
          // 기본 프로덕션 origin 유지
        }
      }
    } catch (err) {
      if (cancelledRef?.current) return;
      setTokenError(err?.message || '라벨 QR 링크를 불러오지 못했습니다.');
    } finally {
      if (!cancelledRef?.current) {
        setTokenLoading(false);
      }
    }
  }, [order?.id]);

  useEffect(() => {
    if (!active) return undefined;
    const cancelledRef = { current: false };
    loadToken(cancelledRef);
    return () => {
      cancelledRef.current = true;
    };
  }, [active, retryCount, loadToken]);

  const handleSizeChange = (nextKey) => {
    setSizeKey(nextKey);
    safeSet(LABEL_SIZE_STORAGE_KEY, nextKey);
  };

  const handleCopiesChange = (event) => {
    const digitsOnly = event.target.value.replace(/[^\d]/g, '').slice(0, 2);
    setCopiesInput(digitsOnly);
  };

  const effectiveCopies = useMemo(() => parseCopiesForPrint(copiesInput), [copiesInput]);

  const handleCopiesBlur = () => {
    setCopiesInput(String(effectiveCopies));
  };

  const labelData = useMemo(() => {
    if (!token) return null;
    return buildShippingLabelData(order, {
      sizeKey,
      presetKey,
      shipDate,
      copies: effectiveCopies,
      token,
      baseOrigin,
    });
  }, [order, sizeKey, presetKey, shipDate, effectiveCopies, token, baseOrigin]);

  const guidePreviewHref = useMemo(() => {
    if (!token) return '#';
    const cleanToken = encodeURIComponent(token);
    return labelData?.presetKey
      ? `/guide/${cleanToken}?p=${encodeURIComponent(labelData.presetKey)}`
      : `/guide/${cleanToken}`;
  }, [token, labelData?.presetKey]);

  const handlePrint = () => {
    if (!labelData) return;
    setPrintError('');
    clearPrintTimers();
    const popupSize = labelData.size.key === '180x100' ? 'width=860,height=640' : 'width=540,height=720';
    const printWindow = window.open('', '_blank', popupSize);
    if (!printWindow) {
      setPrintError('팝업이 차단되어 인쇄 창을 열 수 없습니다. 브라우저 팝업을 허용한 뒤 다시 시도해 주세요.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(buildShippingLabelPrintHtml(labelData));
    printWindow.document.close();
    let printed = false;
    const triggerPrint = () => {
      if (printed || printWindow.closed) return;
      printed = true;
      clearPrintTimers();
      try {
        printWindow.focus();
        printWindow.print();
      } catch {
        // 사용자가 인쇄 창을 먼저 닫은 경우 무시
      }
    };
    const fallbackTimer = setTimeout(triggerPrint, 1200);
    printTimersRef.current.push(fallbackTimer);

    const waitFontsThenPrint = () => {
      if (printed || printWindow.closed) return;
      if (printWindow.document.fonts?.ready) {
        printWindow.document.fonts.ready
          .then(() => {
            if (printed || printWindow.closed) return;
            const settleTimer = setTimeout(triggerPrint, 60);
            printTimersRef.current.push(settleTimer);
          })
          .catch(() => {});
      } else {
        const settleTimer = setTimeout(triggerPrint, 60);
        printTimersRef.current.push(settleTimer);
      }
    };

    if (printWindow.document.readyState === 'complete') {
      waitFontsThenPrint();
    } else {
      printWindow.addEventListener('load', waitFontsThenPrint, { once: true });
    }
  };

  if (!active) return null;

  const defaultOptionValue = autoPresetKey ? DEFAULT_SHOWCASE_SETTING.key : '';

  return createPortal(
    <div
      className="slm-backdrop"
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
        handleEscape();
      }}
    >
      <div
        ref={dialogRef}
        className="slm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="출고 라벨 스티커 출력"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="slm-toolbar">
          <div className="slm-toolbar-title">
            <strong>출고 라벨 스티커</strong>
            <span className="slm-toolbar-sub">
              {order?.client_name || '주문'} · {sizeKey === '180x100' ? '정품 보증 통합 명판 (명함 4장 크기)' : '감열식 흑백 출력'}
            </span>
          </div>
          <div className="slm-toolbar-actions">
            <button
              type="button"
              className="slm-btn slm-btn--primary"
              disabled={tokenLoading || !labelData}
              onClick={handlePrint}
            >
              라벨 인쇄하기 ({effectiveCopies}장)
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className="slm-btn slm-btn--ghost"
              onClick={handleEscape}
            >
              닫기
            </button>
          </div>
        </div>

        <div className="slm-controls">
          <div className="slm-control-group">
            <span className="slm-label">라벨 규격</span>
            <div className="slm-size-toggle" role="group" aria-label="라벨 규격 선택">
              {Object.values(LABEL_SIZES).map((item) => {
                const activeSize = item.key === sizeKey;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`slm-size-btn${activeSize ? ' slm-size-btn--active' : ''}`}
                    aria-pressed={activeSize}
                    onClick={() => handleSizeChange(item.key)}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="slm-control-group">
            <span className="slm-label">권장 세팅 (품목)</span>
            <select
              className="slm-input"
              value={presetKey}
              onChange={(e) => setPresetKey(e.target.value)}
            >
              <option value={defaultOptionValue}>
                {DEFAULT_SHOWCASE_SETTING.label} ({DEFAULT_SHOWCASE_SETTING.factoryTemp} / {DEFAULT_SHOWCASE_SETTING.defrostCycle} / {DEFAULT_SHOWCASE_SETTING.defrostTime})
              </option>
              {SHOWCASE_GUIDE_PRESETS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label} ({item.isDirectCooling ? 'OND 직냉' : `${item.factoryTemp} / ${item.defrostCycle} / ${item.defrostTime}`})
                </option>
              ))}
            </select>
          </label>

          <label className="slm-control-group slm-control-group--date">
            <span className="slm-label">출고일자</span>
            <input
              type="date"
              className="slm-input"
              value={shipDate}
              onChange={(e) => setShipDate(e.target.value)}
            />
          </label>

          <label className="slm-control-group slm-control-group--copies">
            <span className="slm-label">출력 매수</span>
            <input
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              className="slm-input"
              value={copiesInput}
              onChange={handleCopiesChange}
              onBlur={handleCopiesBlur}
            />
          </label>
        </div>

        {printError && (
          <div className="slm-alert slm-alert--error" role="alert">
            {printError}
          </div>
        )}

        <div className="slm-body">
          {tokenLoading && (
            <div className="slm-status">
              <div className="slm-spinner" aria-hidden="true" />
              <span>주문 전용 QR 안내 링크를 준비하고 있습니다...</span>
            </div>
          )}

          {!tokenLoading && tokenError && (
            <div className="slm-status slm-status--error" role="alert">
              <div>{tokenError}</div>
              <button
                type="button"
                className="slm-btn slm-btn--primary"
                onClick={() => setRetryCount((c) => c + 1)}
              >
                다시 시도
              </button>
            </div>
          )}

          {!tokenLoading && !tokenError && labelData && (
            <div className="slm-preview-stage">
              {labelData.size.key === '180x100' ? (
                <>
                  <div className="slm-scroll-hint">
                    좌우로 밀어 전체 명함 4장 규격(180×100mm)을 확인하세요
                  </div>
                  <div className="slm-plate-scroll">
                    <div className="slm-plate" aria-label="180 × 100 mm 명함 4장 정품 보증 통합 라벨 미리보기">
                      <div className="slm-plate-frame">
                        <div className="slm-plate-head">
                          <div className="slm-plate-brand-wrap">
                            <span className="slm-plate-emblem" aria-hidden="true">HS</span>
                            <div>
                              <div className="slm-plate-brand-title">
                                <strong>{labelData.brand.en}</strong> (주){labelData.brand.name}
                              </div>
                              <div className="slm-plate-brand-sub">정품 출고 보증 · 사용설명서 및 사후관리 통합 명판</div>
                            </div>
                          </div>
                          <div className="slm-plate-head-right">
                            <span className="slm-plate-seal-badge">절대 제거·훼손 금지</span>
                            <span className="slm-plate-as">카카오톡 A/S 접수 (QR)</span>
                          </div>
                        </div>

                        <div className="slm-plate-meta-strip">
                          <div className="slm-plate-meta-cell slm-plate-meta-cell--ship">
                            <div className="slm-plate-meta-k">출고일자</div>
                            <div className="slm-plate-meta-v slm-plate-meta-v--ship slm-mono">{labelData.shipDateDisplay}</div>
                          </div>
                          <div className="slm-plate-meta-cell">
                            <div className="slm-plate-meta-k">무상 A/S 보증 (출고일 기준)</div>
                            <div className="slm-plate-meta-v slm-mono">{labelData.warrantyDisplay}</div>
                          </div>
                          <div className="slm-plate-meta-cell">
                            <div className="slm-plate-meta-k">
                              <span>주문번호 · 사양/규격</span>
                              <span className="slm-mono">{labelData.orderNo}</span>
                            </div>
                            <div className="slm-plate-meta-v">{labelData.specText}</div>
                          </div>
                          <div className="slm-plate-meta-cell">
                            <div className="slm-plate-meta-k">출하 권장세팅</div>
                            <div className="slm-plate-meta-v">
                              <strong>{labelData.settingLabel}</strong> · {labelData.settingSummary}
                            </div>
                          </div>
                        </div>

                        <div className="slm-plate-power-banner">
                          <span className="slm-plate-power-lead">※ 반드시 단독 코드(콘센트) 사용 권장 ※</span>
                          <span className="slm-plate-power-desc">
                            멀티탭·문어발 연결 금지 · 불이행에 따른 문제는 당사가 책임을 지지 않습니다.
                          </span>
                        </div>

                        <div className="slm-plate-main">
                          <div className="slm-plate-left">
                            <div className="slm-plate-card">
                              <div className="slm-plate-card-title">필수 설치 · 사용 수칙</div>
                              <ol className="slm-plate-rules">
                                <li><strong>설치 후 2~3시간 뒤 전원 연결</strong> (운반 후 냉매 안정화)</li>
                                <li><strong>{labelData.settingLabel}({labelData.settingSummary}) 유지 · 매장 마감 시 매장 냉장고 별도 보관</strong> <span>(진열용 냉장고 · 보관 시 손상 책임 불가)</span></li>
                                <li><strong>통풍구(하부 옆·뒷면) 막힘 금지 · 앞문형은 뒷벽면 15~20cm 거리 확보 필수</strong></li>
                                <li><strong>냉장 전용 (냉동 사용 금지)</strong> · 과도한 저온 설정 시 결빙·콤프레샤 고장 원인</li>
                                <li><strong>물받이통 제자리·누수 확인 및 주기적 물 비우기</strong></li>
                              </ol>
                            </div>

                            <div className="slm-plate-subgrid">
                              <div className="slm-plate-card">
                                <div className="slm-plate-card-title">신형 일체형 온도조절기 · def 안내</div>
                                <div className="slm-plate-mini-list">
                                  <div><strong>버튼</strong> 전원(OFF 시 모든 출력 OFF) · 조명(LED) · 휀(결로팬, 평소 OFF·습한 날 ON) · 제상(수동)</div>
                                  <div><strong>잠금·온도</strong> 잠금 3초 해제 → ∧∨ 조절 (약 1분 후 자동잠금 · 잠금+조명+휀 3초 시 잠금 중 조명·휀 조작)</div>
                                  <div><strong>제상·에러</strong> 해제 후 설정 1회(제상주기)·2회(제상시간) → ∧∨ 조절 · E-1/E-2 에러 시 카톡 A/S</div>
                                  <div className="slm-plate-def-line"><strong>def 표시</strong> 정상 제상 중이므로 그대로 두면 자동 복구됩니다.</div>
                                </div>
                              </div>
                              <div className="slm-plate-card slm-plate-card--clean">
                                <div className="slm-plate-card-title slm-plate-card-title--red">라지에이터 청소 (월 1회 이상)</div>
                                <div className="slm-plate-mini-list">
                                  <div>① 청소 전 <strong>전원 반드시 차단</strong> · ② <strong>장갑 착용</strong> 필수</div>
                                  <div>③ 부드러운 브러시로 <strong>위·아래</strong> 방향 먼지 제거 <span>(핀 변형 주의)</span></div>
                                  <div className="slm-plate-clean-warn">먼지 막힘 시 온도상승·소음 · <strong>청소 불이행 고장은 보증기간(12개월) 내에도 유상 처리</strong>됩니다.</div>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="slm-plate-right">
                            <div className="slm-plate-qr-head">QR 스캔 · 통합 웹 안내</div>
                            <div
                              className="slm-plate-qr-box"
                              dangerouslySetInnerHTML={{ __html: labelData.qrSvg }}
                            />
                            <ul className="slm-plate-qr-list">
                              <li>10종 품목별 온도·제상 기준표</li>
                              <li>상세 설명서 · 수평조절 · 청소법</li>
                              <li>무상 A/S 조회 · 카카오톡 A/S 문의</li>
                            </ul>
                            <div className="slm-plate-event-badge">
                              <div className="slm-plate-event-main">리뷰 남기고 최대 14만원 받자!</div>
                              <div className="slm-plate-event-sub">블로그 7만 · 인스타·쓰레드 4만 · 구글 3만 (QR)</div>
                            </div>
                          </div>
                        </div>

                        <div className="slm-plate-seal-foot">
                          <strong>[정품 보증 라벨 · 임의 제거 금지]</strong>
                          <span>본 스티커는 출고일자 확인 및 무상 A/S(출고일로부터 12개월) 기준입니다. 무단 제거·훼손 시 사후관리의 불이익을 받을 수 있습니다.</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div
                  className={`slm-sheet slm-sheet--${labelData.size.key}`}
                  aria-label={`${labelData.size.label} 라벨 미리보기`}
                >
                  <div className="slm-sheet-inner">
                    <div className="slm-sheet-head">
                      <div className="slm-sheet-brand">
                        <strong>{labelData.brand.en}</strong> <span>{labelData.brand.name}</span>
                      </div>
                      <div className="slm-sheet-as">카카오톡 A/S (QR)</div>
                    </div>

                    <table className="slm-sheet-table">
                      <tbody>
                        <tr>
                          <th>주문번호</th>
                          <td className="slm-mono">{labelData.orderNo}</td>
                          <th className="slm-ship-date-head">출고일자</th>
                          <td className="slm-mono slm-ship-date-val">{labelData.shipDateDisplay}</td>
                        </tr>
                        <tr>
                          <th>사양·규격</th>
                          <td>{labelData.specText}</td>
                          <th>무상 A/S</th>
                          <td className="slm-mono">{labelData.warrantyDisplay}</td>
                        </tr>
                        <tr>
                          <th>권장세팅</th>
                          <td colSpan={3}>
                            <strong>{labelData.settingLabel}</strong> · {labelData.settingSummary}
                          </td>
                        </tr>
                      </tbody>
                    </table>

                    <div className="slm-sheet-warns">
                      {labelData.warnings.map((item) => (
                        <div
                          key={item.id}
                          className={item.highlight ? 'slm-sheet-warn-alert' : 'slm-sheet-warn-line'}
                        >
                          {item.labelText}
                        </div>
                      ))}
                    </div>

                    <div className="slm-sheet-foot">
                      <div
                        className="slm-sheet-qr"
                        dangerouslySetInnerHTML={{ __html: labelData.qrSvg }}
                      />
                      <div className="slm-sheet-guide">
                        <div className="slm-sheet-guide-title">QR 스캔 · 사용설명서 &amp; 관리안내</div>
                        <ul>
                          <li>온도·제상 설정법 · 라지에이터 청소</li>
                          <li>수평조절 · 무상 A/S · 리뷰 최대 14만원 이벤트</li>
                        </ul>
                        <div className="slm-sheet-guide-note">
                          * 본 스티커 훼손 시 사후관리의 불이익이 있을 수 있습니다.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="slm-meta-bar">
                <div className="slm-meta-info">
                  <span className="slm-meta-url" title={labelData.guideUrl}>
                    통합 링크: <code>{labelData.guideUrl}</code>
                  </span>
                  <span className="slm-print-tip">
                    인쇄 대화상자에서 배율 &apos;실제 크기(100%)&apos; · &apos;배경 그래픽&apos;을 선택해 주세요.
                  </span>
                </div>
                <a
                  className="slm-guide-link"
                  href={guidePreviewHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  웹 안내 페이지 열기 ↗
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
