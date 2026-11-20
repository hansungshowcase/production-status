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
  return saved && Object.hasOwn(LABEL_SIZES, saved) ? saved : '100x100';
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

  useEffect(() => {
    setPresetKey(autoPresetKey || '');
    setShipDate(initialShipDate(order));
    setCopiesInput(String(getDefaultLabelCopies(order)));
    setToken('');
    setTokenError('');
    setPrintError('');
  }, [order?.id, autoPresetKey]);

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
          setBaseOrigin(new URL(res.guide_url).origin);
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
  }, [active, loadToken]);

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
    const printWindow = window.open('', '_blank', 'width=540,height=720');
    if (!printWindow) {
      setPrintError('팝업이 차단되어 인쇄 창을 열 수 없습니다. 브라우저 팝업을 허용한 뒤 다시 시도해 주세요.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(buildShippingLabelPrintHtml(labelData));
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
      try {
        printWindow.print();
      } catch {
        // 사용자가 인쇄 창을 먼저 닫은 경우 무시
      }
    }, 250);
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
            <span className="slm-toolbar-sub">{order?.client_name || '주문'} · 감열식 흑백 출력</span>
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
                onClick={() => loadToken()}
              >
                다시 시도
              </button>
            </div>
          )}

          {!tokenLoading && !tokenError && labelData && (
            <div className="slm-preview-stage">
              <div
                className={`slm-sheet slm-sheet--${labelData.size.key}`}
                aria-label={`${labelData.size.label} 라벨 미리보기`}
              >
                <div className="slm-sheet-inner">
                  <div className="slm-sheet-head">
                    <div className="slm-sheet-brand">
                      <strong>{labelData.brand.en}</strong> <span>{labelData.brand.name}</span>
                    </div>
                    <div className="slm-sheet-as">A/S {labelData.brand.asPhone}</div>
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
                        <li>수평조절 · 무상 A/S · 후기 6만원 이벤트</li>
                      </ul>
                      <div className="slm-sheet-guide-note">
                        * 본 스티커 훼손 시 사후관리의 불이익이 있을 수 있습니다.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="slm-meta-bar">
                <span className="slm-meta-url" title={labelData.guideUrl}>
                  QR 연결 주소: <code>{labelData.guideUrl}</code>
                </span>
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
