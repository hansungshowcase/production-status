import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSmsConsole, postSmsConsole } from '../../api/smsConsole.js';
import KakaoTemplatePreview from './KakaoTemplatePreview.jsx';
import KakaoTemplateForm from './KakaoTemplateForm.jsx';
import SmsTextTemplateForm, { TemplateKindChooser } from './SmsTextTemplateForm.jsx';
import { KIND_KAKAO, KIND_SMS } from './smsTextTemplateFormModel.js';
import {
  ACTION_LABELS, availableActions, defaultStatusFilter, deleteConfirmed, deleteDecision, filterTemplates, formatDate,
  isValidRename, readOnlyAudienceSections, readOnlyKakaoItems, statusInfo, statusPills, templateAudienceSections, templateExtras, usageBadge, usageCount,
} from './templateListModel.js';
import './KakaoTemplateManager.css';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function Icon({ name }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };
  if (name === 'plus') return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
  if (name === 'lock') return <svg {...common}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
  if (name === 'search') return <svg {...common}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></svg>;
  if (name === 'back') return <svg {...common}><path d="M15 6l-6 6 6 6" /></svg>;
  if (name === 'copy') return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>;
  return <svg {...common}><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></svg>;
}

// 최소한의 대화상자: Esc 닫기, 초점 가두기, 닫히면 원래 자리로 초점 복귀
function Modal({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector(FOCUSABLE);
    (first || node)?.focus();
    return () => { if (previous && previous.focus) previous.focus(); };
  }, []);
  const onKeyDown = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const items = Array.from(ref.current?.querySelectorAll(FOCUSABLE) || []);
    if (items.length === 0) { event.preventDefault(); return; }
    const head = items[0];
    const tail = items[items.length - 1];
    if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
    else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
  };
  return (
    <div className="ktm-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ktm-modal" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onKeyDown={onKeyDown}>
        <h3 className="ktm-modal-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function emphasizeLabel(type) {
  if (type === 'NONE' || !type) return '기본형';
  if (type === 'TEXT') return '강조표기형';
  if (type === 'IMAGE') return '이미지첨부형';
  if (type === 'ITEM_LIST') return '리스트형';
  return type;
}
function messageLabel(type) {
  if (type === 'BA' || !type) return '기본';
  if (type === 'EX') return '부가정보';
  if (type === 'AD') return '채널추가형';
  if (type === 'MI') return '복합형';
  return type;
}

export default function KakaoTemplateManager({ active, selectedId, mode, kind = KIND_SMS, onRoute, onOpenLog, onSend, onSendText }) {
  const [tplState, setTplState] = useState({ loading: false, loaded: false, error: null, status: 0, data: null });
  const [usage, setUsage] = useState(null);
  const [sent, setSent] = useState(null); // 종류·보내는 곳·문자 대체 건수(읽기 전용). 못 불러와도 목록은 그대로
  const [openRoId, setOpenRoId] = useState('');
  const [query, setQuery] = useState('');
  const [pickedFilter, setPickedFilter] = useState(null); // null = 아직 안 고름(발송 중이 있으면 그것, 없으면 전체)
  const [menuId, setMenuId] = useState('');
  const [dialog, setDialog] = useState(null); // {type, item}
  const [dialogError, setDialogError] = useState('');
  const [notice, setNotice] = useState(null); // {kind, text}
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [copied, setCopied] = useState(false);
  const startedRef = useRef(false);

  const loadTemplates = useCallback(async () => {
    setTplState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      // 관리 화면은 서버 캐시를 건너뛴다(등록·삭제 직후 다른 서버가 옛 목록을 주지 않게)
      const data = await fetchSmsConsole('templates', { fresh: 1 });
      setTplState({ loading: false, loaded: true, error: null, status: 200, data });
    } catch (err) {
      setTplState((prev) => ({ ...prev, loading: false, loaded: true, error: err.message || '불러오지 못했습니다.', status: err.status || 0 }));
    }
  }, []);

  useEffect(() => {
    if (!active || startedRef.current) return;
    startedRef.current = true;
    loadTemplates();
    fetchSmsConsole('usage').then(setUsage).catch(() => setUsage(null));
    fetchSmsConsole('sent').then((res) => setSent(Array.isArray(res?.groups) ? res.groups : null)).catch(() => setSent(null));
  }, [active, loadTemplates]);

  // 메뉴 바깥 누름·Esc 로 ⋮ 메뉴 닫기
  useEffect(() => {
    if (!menuId) return undefined;
    const close = (event) => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      if (event.type === 'mousedown' && event.target.closest?.('.ktm-menu-wrap')) return;
      setMenuId('');
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menuId]);

  const data = tplState.data;
  const items = useMemo(() => (Array.isArray(data?.items) ? data.items : []), [data]);
  const write = data?.write || null;
  const writeOff = Boolean(write && write.enabled === false);
  const pills = useMemo(() => statusPills(items, usage), [items, usage]);
  const statusFilter = pickedFilter ?? defaultStatusFilter(pills, selectedId, usage);
  const visible = useMemo(() => filterTemplates(items, { query, status: statusFilter, usage }), [items, query, statusFilter, usage]);
  const readOnly = useMemo(() => readOnlyKakaoItems(items, sent, { status: statusFilter, query }), [items, sent, statusFilter, query]);
  const listSections = useMemo(() => templateAudienceSections(visible, sent), [visible, sent]);
  const readOnlySections = useMemo(() => readOnlyAudienceSections(readOnly), [readOnly]);
  const selected = selectedId ? items.find((item) => item.id === selectedId) || null : null;
  const formOpen = mode === 'new' || (mode === 'edit' && selected);

  // ----- 쓰기 -----
  // 관리자 비밀번호 잠금 없음(2026-11-11 사장님 결정). 서버 스위치(SMS_CONSOLE_WRITE=off)로 꺼져 있을 때만 막는다.
  const requireWrite = (run) => {
    if (writeOff) { setNotice({ kind: 'error', text: '등록·삭제가 꺼져 있습니다' }); return; }
    run();
  };
  const doWrite = (action, body) => postSmsConsole(action, body);

  const afterWrite = async (text, warning) => {
    setNotice({ kind: 'ok', text: warning ? `${text} ${warning}` : text });
    await loadTemplates();
  };

  const closeDialog = () => { setDialog(null); setDialogError(''); };

  const submitDialog = (type, item, body) => {
    const run = async () => {
      setBusy(true);
      setDialogError('');
      try {
        await doWrite(type, { id: item.id, ...body });
        closeDialog();
        const messages = {
          rename: '이름을 바꿨습니다.', inspect: '검수를 요청했습니다.',
          cancel_inspect: '검수 요청을 취소했습니다.', delete: '템플릿을 삭제했습니다.',
        };
        if (type === 'delete' && selectedId === item.id) onRoute({ tpl: '' });
        await afterWrite(messages[type] || '완료했습니다.');
      } catch (err) {
        setDialogError(err.message || '실패했습니다.');
      } finally {
        setBusy(false);
      }
    };
    requireWrite(run);
  };

  const submitForm = (value, extra) => {
    const editing = mode === 'edit' && selected;
    const run = async () => {
      setBusy(true);
      setFormError('');
      try {
        const result = editing
          ? await doWrite('update', { id: selected.id, template: value })
          : await doWrite('create', { template: value, requestInspection: Boolean(extra?.requestInspection), comment: extra?.comment || '' });
        const newId = editing ? selected.id : result.item?.id;
        await afterWrite(editing ? '수정했습니다.' : '템플릿을 등록했습니다.', result.warning);
        setPickedFilter('all'); // 방금 등록·수정한 템플릿이 발송 중 밖이어도 보이게
        onRoute({ mode: '', tpl: newId || '' });
      } catch (err) {
        setFormError(err.message || '실패했습니다.');
      } finally {
        setBusy(false);
      }
    };
    return new Promise((resolve) => { requireWrite(run); resolve(); });
  };

  // ----- 동작 -----
  const runAction = (action, item) => {
    setMenuId('');
    setNotice(null);
    if (action === 'today_log') { onOpenLog?.(item.id); return; }
    if (action === 'send') { onSend?.(item.id); return; }
    if (action === 'edit') { setFormError(''); onRoute({ tpl: item.id, mode: 'edit' }); return; }
    setDialogError('');
    setDialog({ type: action, item });
  };

  const copyId = async (id) => {
    try { await navigator.clipboard.writeText(id); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };

  // ----- 그리기 조각 -----
  // 서버에서 등록·삭제를 꺼 둔 경우에만 띠를 보인다(평소에는 비밀번호 없이 바로 쓴다)
  const lockBar = data && writeOff
    ? <div className="ktm-lockbar ktm-lockbar--off"><Icon name="lock" /><span>등록·삭제가 꺼져 있습니다(서버 설정 SMS_CONSOLE_WRITE=off)</span></div>
    : null;

  const renderDetail = () => {
    if (formOpen) {
      return (
        <div className="ktm-form-pane">
          {mode === 'new' ? <TemplateKindChooser kind={KIND_KAKAO} onPick={(next) => onRoute({ mode: 'new', tpl: '', kind: next })} /> : null}
          <KakaoTemplateForm
            key={mode === 'edit' ? selected.id : 'new'}
            mode={mode === 'edit' ? 'edit' : 'create'}
            initial={mode === 'edit' ? selected : null}
            targets={data?.targets || []}
            busy={busy}
            serverError={formError}
            onCancel={() => { setFormError(''); onRoute({ mode: '' }); }}
            onSubmit={submitForm}
          />
        </div>
      );
    }
    if (!selectedId) return <div className="ktm-empty">왼쪽에서 템플릿을 고르면 미리보기가 보입니다.</div>;
    if (!selected) return <div className="ktm-empty">선택한 템플릿을 찾을 수 없습니다. 삭제되었거나 이 화면에서 볼 수 없는 템플릿입니다.</div>;
    const info = statusInfo(selected.status);
    const comments = (Array.isArray(selected.comments) ? selected.comments : [])
      .slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)).slice(0, 3);
    const variables = Array.isArray(selected.variables) ? selected.variables : [];
    return (
      <div className="ktm-detail">
        <div className="ktm-detail-head">
          <button type="button" className="ktm-btn ktm-back" onClick={() => onRoute({ tpl: '' })}><Icon name="back" /> 목록</button>
          <h3 className="ktm-detail-name">{selected.name}</h3>
          <span className={`ktm-badge ktm-badge--${info.tone}`}>{info.label}</span>
        </div>
        <KakaoTemplatePreview template={{
          name: selected.name, content: selected.content, emphasizeType: selected.emphasizeType,
          emphasizeTitle: selected.emphasizeTitle, emphasizeSubtitle: selected.emphasizeSubtitle,
          extra: selected.extra, buttons: (selected.buttons || []).map((b) => ({ type: b.type, name: b.name })),
          targetName: selected.target?.name || '',
        }} />
        <dl className="ktm-info">
          <dt>템플릿 ID</dt>
          <dd className="ktm-id">
            <code>{selected.id}</code>
            <button type="button" className="ktm-btn ktm-btn--icon" onClick={() => copyId(selected.id)} aria-label="템플릿 ID 복사">
              <Icon name="copy" /> {copied ? '복사됨' : '복사'}
            </button>
          </dd>
          <dt>채널/그룹</dt><dd>{selected.target?.name || '-'}{selected.target?.kind === 'group' ? ' (그룹)' : ''}</dd>
          <dt>유형</dt><dd>{emphasizeLabel(selected.emphasizeType)} · {messageLabel(selected.messageType)}</dd>
          <dt>카테고리</dt><dd>{selected.categoryCode || '-'}</dd>
          <dt>등록일</dt><dd>{formatDate(selected.dateCreated) || '-'}</dd>
          <dt>수정일</dt><dd>{formatDate(selected.dateUpdated) || '-'}</dd>
          <dt>변수</dt><dd>{variables.length ? variables.map((v) => `#{${v}}`).join(', ') : '없음'}</dd>
          <dt>검수 의견</dt>
          <dd>
            {comments.length === 0 ? '없음' : (
              <ul className="ktm-comments">
                {comments.map((c, index) => (
                  <li key={index}>
                    <span className="ktm-comment-meta">{c.isAdmin ? '검수자' : '요청'} · {formatDate(c.date) || '-'}</span>
                    <span className="ktm-comment-text">{c.content}</span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
      </div>
    );
  };

  const renderCard = (item) => {
    const info = statusInfo(item.status);
    const badge = usageBadge(usage, item.id);
    const actions = [...(item.status === 'APPROVED' && onSend ? ['send'] : []), ...availableActions(item)];
    const isOpen = menuId === item.id;
    const extras = templateExtras(item.id, sent);
    return (
      <li key={item.id} className={`ktm-card${item.id === selectedId ? ' is-selected' : ''}`}>
        <button type="button" className="ktm-card-main" onClick={() => { setNotice(null); onRoute({ tpl: item.id, mode: '' }); }} aria-current={item.id === selectedId ? 'true' : undefined}>
          <span className="ktm-card-name">{item.name}</span>
          <span className="ktm-card-meta">
            <span className="ktm-chip">{item.target?.name || '채널'}{item.target?.kind === 'group' ? ' · 그룹' : ''}</span>
            <span className="ktm-date">{formatDate(item.dateCreated)}</span>
            {extras ? <span className="ktm-chip ktm-chip--sender">{extras.sender}</span> : null}
            {extras ? <span className="ktm-chip">{extras.kind}</span> : null}
          </span>
          <span className="ktm-card-badges">
            <span className={`ktm-badge ktm-badge--${info.tone}`}>{info.label}</span>
            {badge ? <span className={`ktm-badge ktm-badge--${badge.tone}`}>{badge.text}</span> : null}
            {item.program_use ? <span className="ktm-badge ktm-badge--info">프로그램 알림에 사용</span> : null}
            {extras && extras.replaced7 > 0 ? <span className="ktm-badge ktm-badge--warn">문자 대체 {extras.replaced7}건</span> : null}
            {extras && extras.off ? <span className="ktm-badge ktm-badge--muted">꺼짐</span> : null}
          </span>
        </button>
        <div className="ktm-menu-wrap">
          <button type="button" className="ktm-more" aria-haspopup="menu" aria-expanded={isOpen} aria-label={`${item.name} 동작 메뉴`} onClick={() => setMenuId(isOpen ? '' : item.id)}>
            <Icon name="more" />
          </button>
          {isOpen ? (
            <ul className="ktm-menu" role="menu">
              {actions.map((action) => (
                <li key={action} role="none">
                  <button type="button" role="menuitem" className={action === 'delete' ? 'is-danger' : ''} onClick={() => runAction(action, item)}>{ACTION_LABELS[action]}</button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </li>
    );
  };

  // 템플릿 목록에 없는 브랜드메시지(친구톡)·기타 발송 — 읽기 전용(⋮ 메뉴·삭제 없음)
  const renderReadOnly = () => (
    <section className="ktm-kind" aria-label="브랜드메시지·기타 발송">
      <h3 className="ktm-kind-head">브랜드메시지·기타 발송 <span className="ktm-kind-count">{readOnly.length}</span></h3>
      {readOnlySections.map((group) => (
        <div key={group.group} className="ktm-aud-sub">
          <h4 className="ktm-kind-head ktm-kind-head--sub">{group.group} <span className="ktm-kind-count">{group.items.length}</span></h4>
          <ul className="ktm-cards">
            {group.items.map((entry) => {
              const expandable = Boolean(entry.body || entry.image || entry.trigger || entry.scenario);
              const opened = openRoId === entry.id;
              return (
                <li key={entry.id} className={`ktm-card${opened ? ' is-selected' : ''}`}>
                  <button type="button" className="ktm-card-main" aria-expanded={opened} onClick={() => setOpenRoId(opened ? '' : entry.id)}>
                    <span className="ktm-card-name">{entry.name}</span>
                    <span className="ktm-card-meta">
                      <span className="ktm-chip ktm-chip--sender">{entry.sender}</span>
                      <span className="ktm-chip">{entry.kind}</span>
                      <span className="ktm-chan">{entry.channel === 'BMS' ? '브랜드메시지·친구톡' : '알림톡'}</span>
                    </span>
                    <span className="ktm-card-badges">
                      {entry.count === null ? <span className="ktm-badge ktm-badge--muted">사용 여부 확인 못 함</span>
                        : <span className={`ktm-badge ktm-badge--${entry.count > 0 ? 'warn' : 'muted'}`}>최근 7일 {entry.count}건</span>}
                      {entry.ad ? <span className="ktm-badge ktm-badge--info">광고</span> : null}
                      {entry.active === false ? <span className="ktm-badge ktm-badge--muted">꺼짐</span> : null}
                    </span>
                    {opened && expandable ? (
                      <span className="ktm-open">
                        {entry.trigger ? <span className="ktm-open-line"><b>언제 나가나</b> {entry.trigger}</span> : null}
                        {entry.scenario ? <span className="ktm-open-line"><b>{entry.sender === '메이크' ? '메이크 시나리오' : '자동화 이름'}</b> {entry.scenario}</span> : null}
                        {entry.image ? <img className="ktm-open-img" src={entry.image} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = 'none'; }} /> : null}
                        {entry.body ? <span className="ktm-open-body">{entry.body}</span> : null}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );

  const renderDialog = () => {
    if (!dialog) return null;
    const { type, item } = dialog;
    if (type === 'rename') return <RenameDialog item={item} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={(name) => submitDialog('rename', item, { name })} />;
    if (type === 'inspect') return <InspectDialog item={item} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={(comment) => submitDialog('inspect', item, { comment })} />;
    if (type === 'cancel_inspect') {
      return (
        <Modal title="검수 요청 취소" onClose={closeDialog}>
          <p className="ktm-modal-text">“{item.name}” 의 검수 요청을 취소합니다.</p>
          {dialogError ? <p className="ktm-alert" role="alert">{dialogError}</p> : null}
          <div className="ktm-modal-actions">
            <button type="button" className="ktm-btn" onClick={closeDialog}>닫기</button>
            <button type="button" className="ktm-btn ktm-btn--primary" disabled={busy} onClick={() => submitDialog('cancel_inspect', item, {})}>{busy ? '처리 중…' : '검수 요청 취소'}</button>
          </div>
        </Modal>
      );
    }
    if (type === 'delete') return <DeleteDialog item={item} usage={usage} busy={busy} error={dialogError} onClose={closeDialog} onSubmit={() => submitDialog('delete', item, { confirmName: item.name })} />;
    return null;
  };

  // ----- 본문 -----
  let body;
  if (mode === 'new' && kind === KIND_SMS) {
    // 문자 템플릿 등록: 알림톡 목록을 못 불러와도 쓸 수 있게 목록 조회 결과와 상관없이 그린다
    body = (
      <div className="ktm-form-pane">
        <TemplateKindChooser kind={KIND_SMS} onPick={(next) => onRoute({ mode: 'new', tpl: '', kind: next })} />
        <SmsTextTemplateForm onSend={(id) => onSendText?.(id)} onCancel={() => onRoute({ mode: '' })} />
      </div>
    );
  } else if (!tplState.loaded && tplState.loading) body = <div className="ktm-empty">불러오는 중…</div>;
  else if (tplState.error && !data) {
    const noPermission = tplState.status === 401 || tplState.status === 403;
    body = (
      <div className="ktm-error" role="alert">
        <p>{noPermission ? '쏠라피에서 권한을 받지 못했습니다.' : '템플릿을 불러오지 못했습니다.'}</p>
        <p className="ktm-error-detail">{tplState.error}</p>
        <button type="button" className="ktm-btn" onClick={loadTemplates}>다시 불러오기</button>
      </div>
    );
  } else if (data && data.configured === false) {
    body = <div className="ktm-empty">쏠라피 연결 정보가 설정되지 않아 템플릿을 볼 수 없습니다.</div>;
  } else if (data) {
    body = (
      <div className={`ktm-layout${selectedId || formOpen ? ' has-detail' : ''}${formOpen ? ' is-form' : ''}`}>
        <section className="ktm-list-pane" aria-label="템플릿 목록" hidden={formOpen}>
          <div className="ktm-search">
            <Icon name="search" />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름 또는 템플릿 ID 검색" aria-label="템플릿 검색" />
          </div>
          <div className="ktm-pills" role="group" aria-label="상태 거르기">
            {pills.map((pill) => (
              <button type="button" key={pill.id} className={`ktm-pill${statusFilter === pill.id ? ' is-active' : ''}`} aria-pressed={statusFilter === pill.id} onClick={() => setPickedFilter(pill.id)}>
                {pill.label} {pill.count}
              </button>
            ))}
          </div>
          {data.unresolved_groups > 0 ? <p className="ktm-hint">범위를 확인하지 못한 템플릿 {data.unresolved_groups}개는 숨겼습니다</p> : null}
          {visible.length === 0
            ? <div className="ktm-empty">{items.length === 0 ? '등록된 템플릿이 없습니다.' : '조건에 맞는 템플릿이 없습니다.'}</div>
            : listSections.map((aud) => (
              <section key={aud.group} className="ktm-aud" aria-label={aud.group}>
                <h3 className="ktm-kind-head ktm-kind-head--aud">{aud.group} <span className="ktm-kind-count">{aud.count}</span></h3>
                {aud.kinds.map((section) => (
                  <section key={section.kind || aud.group} className="ktm-kind" aria-label={section.kind || aud.group}>
                    {section.kind ? <h3 className="ktm-kind-head">{section.kind} <span className="ktm-kind-count">{section.items.length}</span></h3> : null}
                    <ul className="ktm-cards">{section.items.map(renderCard)}</ul>
                  </section>
                ))}
              </section>
            ))}
          {readOnly.length > 0 ? renderReadOnly() : null}
        </section>
        <section className="ktm-detail-pane" aria-label="미리보기">{renderDetail()}</section>
      </div>
    );
  } else body = null;

  return (
    <div className="ktm-root" hidden={!active}>
      <div className="ktm-header">
        <div>
          <h2 className="ktm-title">알림톡 템플릿</h2>
          <p className="ktm-sub">한성쇼케이스 채널의 알림톡 템플릿을 보고, 바로 등록·삭제합니다.</p>
        </div>
        {mode === 'new' ? null : (
          <button type="button" className="ktm-btn ktm-btn--primary" disabled={!data || data.configured === false || writeOff}
            onClick={() => { setNotice(null); setFormError(''); onRoute({ mode: 'new', tpl: '', kind: KIND_KAKAO }); }}>
            <Icon name="plus" /> 템플릿 등록
          </button>
        )}
      </div>
      {lockBar}
      {notice ? <div className={`ktm-notice ktm-notice--${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.text}</div> : null}
      {tplState.error && data ? <div className="ktm-notice ktm-notice--error" role="alert">{tplState.error}</div> : null}
      {body}
      {renderDialog()}
    </div>
  );
}

function RenameDialog({ item, busy, error, onClose, onSubmit }) {
  const [name, setName] = useState(item.name || '');
  const valid = isValidRename(name);
  return (
    <Modal title="이름 변경" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (valid && !busy) onSubmit(name.trim()); }}>
        <label className="ktm-field">
          <span>새 이름 (1~100자)</span>
          <input type="text" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          <small>{name.trim().length}/100</small>
        </label>
        {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
        <div className="ktm-modal-actions">
          <button type="button" className="ktm-btn" onClick={onClose}>닫기</button>
          <button type="submit" className="ktm-btn ktm-btn--primary" disabled={!valid || busy}>{busy ? '처리 중…' : '이름 변경'}</button>
        </div>
      </form>
    </Modal>
  );
}

function InspectDialog({ item, busy, error, onClose, onSubmit }) {
  const [comment, setComment] = useState('');
  return (
    <Modal title="검수 요청" onClose={onClose}>
      <form onSubmit={(event) => { event.preventDefault(); if (!busy) onSubmit(comment.trim()); }}>
        <p className="ktm-modal-text">“{item.name}” 의 검수를 요청합니다. 검수에는 1~3 영업일이 걸립니다.</p>
        <label className="ktm-field">
          <span>검수자 참고 의견 (선택, 500자까지)</span>
          <textarea value={comment} maxLength={500} rows={3} onChange={(event) => setComment(event.target.value)} />
        </label>
        {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
        <div className="ktm-modal-actions">
          <button type="button" className="ktm-btn" onClick={onClose}>닫기</button>
          <button type="submit" className="ktm-btn ktm-btn--primary" disabled={busy}>{busy ? '처리 중…' : '검수 요청'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteDialog({ item, usage, busy, error, onClose, onSubmit }) {
  const [typed, setTyped] = useState('');
  const decision = deleteDecision(item, usage);
  const info = statusInfo(item.status);
  const count = usageCount(usage, item.id);
  return (
    <Modal title="템플릿 삭제" onClose={onClose}>
      <dl className="ktm-modal-info">
        <dt>이름</dt><dd>{item.name}</dd>
        <dt>상태</dt><dd>{info.label}</dd>
        <dt>최근 7일 발송</dt><dd>{count === null ? '확인 못 함' : `${count}건`}</dd>
      </dl>
      {!decision.allowed ? (
        <p className="ktm-alert" role="alert">
          {decision.reason === 'program'
            ? '이 프로그램의 고객 알림(주문 접수·제작 시작·포장·출고·일정 변경)에 쓰는 템플릿이라 여기서는 지울 수 없습니다.'
            : `${decision.reason === 'unknown' ? '최근 7일 사용 여부를 확인하지 못했습니다. ' : ''}지금 발송에 쓰이고 있어 여기서는 지울 수 없습니다. 이 템플릿을 쓰는 자동 발송(쏠라피 자동화·프로그램 알림)을 먼저 끄세요`}
        </p>
      ) : (
        <>
          <p className="ktm-warn">쏠라피 자동화에 연결된 템플릿이면 그 자동화가 멈춥니다.</p>
          {item.status === 'APPROVED' ? <p className="ktm-warn">승인된 템플릿입니다. 다시 등록하면 검수에 1~3 영업일이 걸립니다.</p> : null}
          <label className="ktm-field">
            <span>삭제하려면 템플릿 이름을 그대로 입력하세요</span>
            <input type="text" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </label>
        </>
      )}
      {error ? <p className="ktm-alert" role="alert">{error}</p> : null}
      <div className="ktm-modal-actions">
        <button type="button" className="ktm-btn" onClick={onClose}>닫기</button>
        {decision.allowed ? (
          <button type="button" className="ktm-btn ktm-btn--danger" disabled={!deleteConfirmed(item, typed) || busy} onClick={onSubmit}>{busy ? '삭제 중…' : '삭제'}</button>
        ) : null}
      </div>
    </Modal>
  );
}
