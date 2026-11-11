import './SolapiGroupTable.css';
import {
  fmtShort, fmtRelative, typeKey, SOURCE_BADGE, TYPE_BADGE, AUDIENCE_LABEL, BAR_COLOR,
} from './solapiFormat.js';

function pct(part, total) {
  return total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0;
}

function StatusCell({ group }) {
  const done = group.status === 'COMPLETE';
  return (
    <span className="sgt-status">
      <span className="sgt-status-total">총 {group.total || 0}건</span>
      <strong className="sgt-status-label">{group.status_label || group.status || '-'}</strong>
      {done ? <span className="sgt-check" aria-hidden="true">✓</span> : null}
    </span>
  );
}

function TypeCell({ group }) {
  const src = SOURCE_BADGE[group.source];
  const types = Array.isArray(group.types) ? group.types : [];
  return (
    <span className="sgt-types">
      {src ? (
        <span className="sgt-badge" style={{ background: src.bg, color: src.fg }} title={src.title}>{group.source}</span>
      ) : null}
      {types.map((t) => {
        const key = typeKey(t);
        const b = TYPE_BADGE[key] || { bg: '#94a3b8', fg: '#ffffff' };
        return <span key={t} className="sgt-badge" style={{ background: b.bg, color: b.fg }}>{key}</span>;
      })}
    </span>
  );
}

function StateCell({ group }) {
  const total = (group.failed || 0) + (group.success || 0) + (group.pending || 0);
  return (
    <span className="sgt-state">
      <span className="sgt-bar" role="img" aria-label="현황 비율">
        <span className="sgt-bar-seg" style={{ width: `${pct(group.failed || 0, total)}%`, background: BAR_COLOR.failed }} />
        <span className="sgt-bar-seg" style={{ width: `${pct(group.success || 0, total)}%`, background: BAR_COLOR.success }} />
        <span className="sgt-bar-seg" style={{ width: `${pct(group.pending || 0, total)}%`, background: BAR_COLOR.pending }} />
      </span>
      <span className="sgt-counts">실패 {group.failed || 0} / 성공 {group.success || 0} / 발송중 {group.pending || 0}</span>
    </span>
  );
}

function recentText(group, checkedAt) {
  const log = group.last_log;
  if (!log || !log.message) return '';
  const rel = fmtRelative(log.at, checkedAt);
  return rel ? `(${rel}) ${log.message}` : log.message;
}

export default function SolapiGroupTable({ groups, checkedAt, onOpenGroup }) {
  const rows = Array.isArray(groups) ? groups : [];
  const open = (id) => { if (typeof onOpenGroup === 'function') onOpenGroup(id); };
  const onKey = (event, id) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(id);
    }
  };

  return (
    <div className="sgt-wrap">
      <div className="sgt-head" aria-hidden="true">
        <span>생성일</span><span>구분</span><span>상태</span><span>타입</span><span>현황</span><span>최근 업데이트</span>
      </div>
      <ul className="sgt-list">
        {rows.map((group) => {
          const recent = recentText(group, checkedAt);
          const aud = AUDIENCE_LABEL[group.audience];
          return (
            <li
              key={group.group_id}
              className="sgt-row"
              role="button"
              tabIndex={0}
              onClick={() => open(group.group_id)}
              onKeyDown={(event) => onKey(event, group.group_id)}
            >
              <span className="sgt-cell sgt-cell-date" data-label="생성일">{fmtShort(group.created_at)}</span>
              <span className="sgt-cell sgt-cell-aud" data-label="구분">
                {aud ? <span className={`sgt-aud sgt-aud-${group.audience}`}>{aud}</span> : null}
                {group.category ? <small className="sgt-cat" title={group.category}>{group.category}</small> : null}
              </span>
              <span className="sgt-cell" data-label="상태"><StatusCell group={group} /></span>
              <span className="sgt-cell" data-label="타입"><TypeCell group={group} /></span>
              <span className="sgt-cell" data-label="현황"><StateCell group={group} /></span>
              <span className="sgt-cell sgt-cell-recent" data-label="최근 업데이트" title={recent}>
                <span className="sgt-ellipsis">{recent}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
