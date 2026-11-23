import { useCallback, useEffect, useRef, useState } from 'react';
import { CONSOLE_MENUS, activeSubId } from '../../../shared/smsConsole.js';
import './SmsConsoleSidebar.css';

// 사이드바는 업무 흐름 3단계(자동 발송 설정 · 직접 발송 · 발송 결과 확인) · 6개 평면 항목으로 단순화한다.
const SIDEBAR_GROUPS = [
  {
    id: 'auto',
    title: '자동 발송 설정',
    items: [
      { id: 'sms', menu: 'templates', patch: { ch: 'sms', tpl: '', mode: '' }, label: '문자 템플릿', icon: 'templates', isActive: (s) => s.menu === 'templates' && s.ch !== 'kakao' },
      { id: 'kakao', menu: 'templates', patch: { ch: 'kakao', tpl: '', mode: '' }, label: '카카오톡 템플릿', icon: 'kakao', isActive: (s) => s.menu === 'templates' && s.ch === 'kakao' },
    ],
  },
  {
    id: 'manual',
    title: '직접 발송',
    items: [
      { id: 'send', menu: 'send', patch: {}, label: '직접 보내기', icon: 'send', isActive: (s) => s.menu === 'send' },
    ],
  },
  {
    id: 'results',
    title: '발송 결과 확인',
    items: [
      { id: 'customer', menu: 'customer', patch: {}, label: '고객 발송 관리', icon: 'customer', isActive: (s) => s.menu === 'customer' },
      { id: 'staff', menu: 'staff', patch: {}, label: '직원 발송 관리', icon: 'staff', isActive: (s) => s.menu === 'staff' },
      { id: 'log', menu: 'log', patch: { aud: 'all', ch: 'all' }, label: '전체 발송 기록', icon: 'log', isActive: (s) => s.menu === 'log' },
    ],
  },
];

// 아이콘은 직접 그린 인라인 SVG(24x24, stroke).
const ICONS = {
  templates: <path d="M4 5h16v11H9l-5 4z" />,
  kakao: <path d="M12 4C7.03 4 3 7.13 3 11c0 2.4 1.56 4.52 3.94 5.77L6 20l3.7-1.94c.74.16 1.51.24 2.3.24 4.97 0 9-3.13 9-7s-4.03-7-9-7z" />,
  send: <path d="M4 12 20 4l-4 16-4-6z" />,
  log: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  customer: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
    </>
  ),
  staff: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M17 14c2.4 0 4 1.6 4 4" />
    </>
  ),
};

function MenuIcon({ id }) {
  return (
    <svg className="smsc-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[id] || ICONS.templates}
    </svg>
  );
}

// props: state = parseConsoleQuery 결과, onSelect(menu, patch)
export default function SmsConsoleSidebar({ state, onSelect }) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef(null);
  const firstRef = useRef(null);
  const current = CONSOLE_MENUS.find(menu => menu.id === state.menu) || CONSOLE_MENUS[0];
  const subId = activeSubId(state);
  const allItems = SIDEBAR_GROUPS.flatMap(g => g.items);
  const activeItem = allItems.find(item => item.isActive(state)) || allItems[0];

  const close = useCallback(() => {
    setOpen(false);
    toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    firstRef.current?.focus();
    const onKey = event => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const choose = (menu, patch) => {
    onSelect(menu, patch || {});
    setOpen(false);
  };

  const mobileSubs = current.id === 'templates' ? (current.subs || []) : [];

  return (
    <div className="smsc-side">
      <div className="smsc-mbar">
        <button
          type="button"
          ref={toggleRef}
          className="smsc-mbar__toggle"
          aria-expanded={open}
          aria-controls="smsc-nav"
          onClick={() => setOpen(true)}
        >
          <svg className="smsc-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
          <span>메뉴</span>
        </button>
        <strong className="smsc-mbar__title">{activeItem.label}</strong>
      </div>

      {mobileSubs.length > 0 && (
        <div className="smsc-pills" role="group" aria-label="템플릿 채널 전환">
          {mobileSubs.map(sub => (
            <button
              key={sub.id}
              type="button"
              className={`smsc-pill${subId === sub.id ? ' is-active' : ''}`}
              aria-current={subId === sub.id ? 'true' : undefined}
              onClick={() => choose('templates', { ch: sub.ch, tpl: '', mode: '' })}
            >
              {sub.label}
            </button>
          ))}
        </div>
      )}

      {open && <div className="smsc-backdrop" onClick={close} aria-hidden="true" />}

      <nav id="smsc-nav" className={`smsc-nav${open ? ' is-open' : ''}`} aria-label="문자 관리 메뉴">
        <div className="smsc-groups">
          {SIDEBAR_GROUPS.map((group, gIdx) => (
            <div key={group.id} className="smsc-sec-group">
              <p className="smsc-sec-label">{group.title}</p>
              <ul className="smsc-menu">
                {group.items.map((item, iIdx) => {
                  const selected = item.isActive(state);
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        ref={gIdx === 0 && iIdx === 0 ? firstRef : undefined}
                        className={`smsc-item${selected ? ' is-active' : ''}`}
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => (selected ? setOpen(false) : choose(item.menu, item.patch))}
                      >
                        <MenuIcon id={item.icon} />
                        <span>{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <p className="smsc-note">쏠라피 · 한성쇼케이스 채널</p>
      </nav>
    </div>
  );
}
