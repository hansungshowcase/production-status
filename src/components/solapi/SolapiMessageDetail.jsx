import { useEffect, useRef, useState } from 'react';
import { fmtFull, fmtRelative, typeKey, SOURCE_BADGE, AUDIENCE_LABEL, STATUS_COLOR } from './solapiFormat.js';
import './SolapiMessageDetail.css';

const TABS = ['메시지 정보', '메시지 내용', '그룹 정보', '메시지 이력'];
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function yesNo(value) {
  if (value === true) return '예';
  if (value === false) return '아니오';
  return '-';
}

function Field({ label, children, wide }) {
  const empty = children === undefined || children === null || children === '';
  return (
    <div className={`smd-field${wide ? ' smd-field-wide' : ''}`}>
      <dt className="smd-label">{label}</dt>
      <dd className="smd-value">{empty ? '-' : children}</dd>
    </div>
  );
}

function CopyId({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      const result = navigator.clipboard.writeText(String(value || ''));
      if (result && typeof result.then === 'function') {
        result.then(() => setCopied(true)).catch(() => {});
      } else setCopied(true);
    } catch {
      /* 복사 실패는 조용히 */
    }
  };
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="smd-idbox">
      <div className="smd-label">{label}</div>
      <div className="smd-id">
        <span className="smd-id-text">{value || '-'}</span>
        {value ? (
          <button type="button" className="smd-copy" onClick={copy} aria-label={`${label} 복사`}>
            {copied ? '복사됨' : '복사'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default function SolapiMessageDetail({ item, group, checkedAt, onClose }) {
  const [tab, setTab] = useState(0);
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  const open = Boolean(item);

  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (closeRef.current) closeRef.current.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (closeFn.current) closeFn.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const nodes = Array.from(dialogRef.current.querySelectorAll(FOCUSABLE));
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!dialogRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!item) return null;

  const statusColor = STATUS_COLOR[item.status] || STATUS_COLOR.pending;
  const source = item.source ? SOURCE_BADGE[item.source] : null;
  const audience = AUDIENCE_LABEL[item.audience] || '-';
  const typeLabel = item.type_label || item.type || '-';
  // 서버 type_label 에 이미 'BMS FREE → LMS' 처럼 화살표가 들어 있으면 그대로 쓴다(겹침 방지)
  const replacedType = item.replaced_from && !String(typeLabel).includes('→') ? `${item.replaced_from} → ${typeLabel}` : typeLabel;
  const log = Array.isArray(item.log) ? item.log : [];
  const counts = [
    ['접수 건수', group && group.total], ['발송 건수', group && group.sent_total], ['성공', group && group.success],
    ['실패', group && group.failed], ['발송중', group && group.pending], ['대체발송', group && group.replacement],
    ['환급', group && group.refund],
  ];

  return (
    <div className="smd-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && onClose) onClose(); }}>
      <div className="smd-dialog" role="dialog" aria-modal="true" aria-labelledby="smd-title" ref={dialogRef}>
        <header className="smd-head">
          <h2 id="smd-title" className="smd-title">메시지 정보</h2>
          <button type="button" className="smd-x" ref={closeRef} aria-label="닫기" onClick={onClose}>✕</button>
        </header>
        <div className="smd-tabs" role="tablist" aria-label="메시지 정보 구분">
          {TABS.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`smd-tab-${index}`}
              aria-selected={tab === index}
              aria-controls="smd-panel"
              className={`smd-tab${tab === index ? ' is-active' : ''}`}
              onClick={() => setTab(index)}
            >{name}</button>
          ))}
        </div>
        <div className="smd-body" role="tabpanel" id="smd-panel" aria-labelledby={`smd-tab-${tab}`}>
          <div className="smd-notice">수신번호 가운데와 본문 속 링크·전화번호는 가려져 있습니다</div>

          {tab === 0 ? (
            <>
              <div className="smd-main">
                <section className="smd-phone" aria-label="문자 미리보기">
                  <div className="smd-phone-top">
                    <div><div className="smd-label">발신번호</div><div className="smd-num">{item.from || '-'}</div></div>
                    <div><div className="smd-label">수신번호</div><div className="smd-num">{item.to || '-'}</div></div>
                    <div className="smd-phone-meta">
                      <span className="smd-typeline">{item.type_name || typeLabel} / {item.bytes ?? 0} Bytes</span>
                      <span className="smd-when">{fmtFull(item.created_at)}</span>
                    </div>
                  </div>
                  <div className="smd-bubble">
                    {item.subject ? <div className="smd-subject">{item.subject}</div> : null}
                    <div className="smd-text">{item.text || '(본문 없음)'}</div>
                  </div>
                </section>
                <dl className="smd-grid">
                  <Field label="발신번호">{item.from}</Field>
                  <Field label="수신번호">{item.to}</Field>
                  <Field label="상태 (상태코드)" wide>
                    <span style={{ color: statusColor, fontWeight: 600 }}>
                      {item.status_text || item.status_label || '-'}{item.status_code ? ` (${item.status_code})` : ''}
                    </span>
                  </Field>
                  <Field label="비고" wide>{item.reason}</Field>
                  <Field label="문자 타입">{replacedType}</Field>
                  <Field label="국가코드">{item.country}</Field>
                  <Field label="통신사">{item.network_name}</Field>
                  <Field label="자동타입감지">{yesNo(item.auto_type_detect)}</Field>
                  <Field label="메시지등록일">{fmtFull(item.created_at)}</Field>
                  <Field label="최근업데이트">{fmtFull(item.updated_at || item.processed_at)}</Field>
                  <Field label="이동사리포트수신">{fmtFull(item.reported_at)}</Field>
                  <Field label="단말기문자도착">{fmtFull(item.received_at)}</Field>
                  <Field label="문자대체발송">{item.disable_sms === true ? '불가' : '허용'}</Field>
                  <Field label="대체발송된 메시지 여부">{item.replacement ? '예' : '아니오'}</Field>
                  <Field label="구분"><span className={`smd-aud smd-aud-${item.audience || 'other'}`}>{audience}</span></Field>
                  <Field label="종류">{item.category}</Field>
                  <Field label="받는 사람">{item.recipient_name}</Field>
                  <Field label="발송 출처">
                    {source ? <span className="smd-source" style={{ background: source.bg, color: source.fg }} title={source.title}>{item.source}</span> : '-'}
                  </Field>
                </dl>
              </div>
              <div className="smd-ids">
                <CopyId label="메시지아이디" value={item.message_id} />
                <CopyId label="그룹아이디" value={item.group_id} />
              </div>
            </>
          ) : null}

          {tab === 1 ? (
            <section className="smd-content" aria-label="메시지 내용">
              {item.subject ? <h3 className="smd-content-subject">{item.subject}</h3> : null}
              <div className="smd-content-text">{item.text || '(본문 없음)'}</div>
              <div className="smd-content-meta">{item.type_name || typeLabel} / {item.bytes ?? 0} Bytes · {typeKey(item.type)}</div>
            </section>
          ) : null}

          {tab === 2 ? (
            group ? (
              <dl className="smd-grid smd-grid-group">
                <Field label="그룹 ID" wide>{group.group_id}</Field>
                <Field label="상태">{group.status_label}</Field>
                <Field label="발송 출처">{group.source || '-'}</Field>
                {counts.map(([label, value]) => <Field key={label} label={label}>{value ?? '-'}</Field>)}
                <Field label="생성 시각">{fmtFull(group.created_at)}</Field>
                <Field label="발송 시각">{fmtFull(group.sent_at)}</Field>
                <Field label="완료 시각">{fmtFull(group.completed_at)}</Field>
                <Field label="최근 기록" wide>
                  {group.last_log ? `(${fmtRelative(group.last_log.at, checkedAt)}) ${group.last_log.message}` : '-'}
                </Field>
              </dl>
            ) : <p className="smd-empty">이 날짜 요청 목록에 없는 그룹입니다(전날 만든 요청이거나 요청 목록을 일부만 불러온 경우). 그룹 ID {item.group_id || '-'}</p>
          ) : null}

          {tab === 3 ? (
            log.length ? (
              <ol className="smd-log">
                {log.map((row, index) => (
                  <li key={`${row.at}-${index}`} className="smd-log-row">
                    <time className="smd-log-at">{fmtFull(row.at)}</time>
                    <span className="smd-log-msg">{row.message}</span>
                  </li>
                ))}
              </ol>
            ) : <p className="smd-empty">기록 없음</p>
          ) : null}
        </div>
        <footer className="smd-foot">
          <button type="button" className="smd-close" onClick={onClose}>닫기 <kbd>ESC</kbd></button>
        </footer>
      </div>
    </div>
  );
}
