import './SolapiMessageTable.css';
import { fmtShort, typeKey, TYPE_DOT, AUDIENCE_LABEL, STATUS_COLOR } from './solapiFormat.js';

const COLUMNS = ['생성일', '구분', '타입', '발신번호', '수신번호', '상태코드', '비고', '종류', '내용'];
const COL_CLASS = ['c-date', 'c-aud', 'c-type', 'c-from', 'c-to', 'c-status', 'c-reason', 'c-cat', 'c-text'];

function Lock() {
  return (
    <svg className="smt-lock" width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M17 9h-1V7a4 4 0 0 0-8 0v2H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-7-2a2 2 0 0 1 4 0v2h-4z" />
    </svg>
  );
}

function Audience({ item }) {
  const label = AUDIENCE_LABEL[item.audience] || '기타';
  return (
    <>
      <span className={`smt-badge smt-badge-${item.audience || 'other'}`}>{label}</span>
      {item.recipient_name ? <span className="smt-name">{item.recipient_name}</span> : null}
    </>
  );
}

function TypeCell({ item }) {
  const color = TYPE_DOT[typeKey(item.type)] || '#94a3b8';
  return (
    <>
      <span className="smt-dot" style={{ background: color }} aria-hidden="true" />
      <span>{item.type_label || item.type || '-'}</span>
    </>
  );
}

function StatusCell({ item }) {
  const color = STATUS_COLOR[item.status] || STATUS_COLOR.pending;
  return (
    <>
      {item.status_text || item.status_label || '-'}
      {item.status_code ? <> (<span style={{ color }}>{item.status_code}</span>)</> : null}
    </>
  );
}

function ToCell({ item }) {
  return item.to ? <><Lock />{item.to}</> : null;
}

function TextCell({ item }) {
  // 쏠라피 건별 내역처럼 본문을 보여 준다(제목은 상세 창에)
  const body = item.text || item.subject || '';
  return <><Lock /><span>{body}</span></>;
}

export default function SolapiMessageTable({ items, onOpen }) {
  const rows = Array.isArray(items) ? items : [];
  const open = (item, el) => { if (onOpen) onOpen(item, el); };
  const onKeyDown = (event, item) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(item, event.currentTarget);
    }
  };
  const rowKey = (item, index) => item.message_id || `${item.group_id || 'g'}-${index}`;

  return (
    <div className="smt-wrap">
      <table className="smt-table">
        <thead>
          <tr>{COLUMNS.map((name, i) => <th key={name} className={`smt-${COL_CLASS[i]}`} scope="col">{name}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((item, index) => (
            <tr
              key={rowKey(item, index)}
              className="smt-row"
              tabIndex={0}
              onClick={(event) => open(item, event.currentTarget)}
              onKeyDown={(event) => onKeyDown(event, item)}
            >
              <td className="smt-c-date" data-label="생성일">{fmtShort(item.created_at)}</td>
              <td className="smt-c-aud" data-label="구분"><Audience item={item} /></td>
              <td className="smt-c-type" data-label="타입"><TypeCell item={item} /></td>
              <td className="smt-c-from" data-label="발신번호">{item.from}</td>
              <td className="smt-c-to" data-label="수신번호"><ToCell item={item} /></td>
              <td className="smt-c-status" data-label="상태코드"><StatusCell item={item} /></td>
              <td className="smt-c-reason" data-label="비고" title={item.reason || ''}>{item.reason}</td>
              <td className="smt-c-cat" data-label="종류" title={item.category || ''}>{item.category}</td>
              <td className="smt-c-text" data-label="내용"><TextCell item={item} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
