import { useCallback, useEffect, useRef, useState } from 'react';
import { CONSOLE_MENUS, activeSubId } from '../../../shared/smsConsole.js';
import './SmsConsoleSidebar.css';

// 아이콘은 직접 그린 인라인 SVG(24x24, stroke).
const ICONS = {
  dashboard: <path d="M5 20V10M12 20V4M19 20v-7" />,
  send: <path d="M4 12 20 4l-4 16-4-6z" />,
  log: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  templates: <path d="M4 5h16v11H9l-5 4z" />,
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
      {ICONS[id]}
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

  const subs = current.subs || [];
  const subPatch = sub => {
    if (current.id === 'log') return { aud: sub.aud, ch: sub.ch };
    if (sub.mode) return { mode: sub.mode, tpl: '' };
    if (current.id === 'templates') return { ch: sub.ch, tpl: '', mode: '' };
    return { tpl: '', mode: '' };
  };

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
        <strong className="smsc-mbar__title">{current.label}</strong>
      </div>

      {subs.length > 0 && (
        <div className="smsc-pills" role="group" aria-label={`${current.label} 하위 메뉴`}>
          {subs.map(sub => (
            <button
              key={sub.id}
              type="button"
              className={`smsc-pill${subId === sub.id ? ' is-active' : ''}`}
              aria-current={subId === sub.id ? 'true' : undefined}
              onClick={() => choose(current.id, subPatch(sub))}
            >
              {sub.label}
            </button>
          ))}
        </div>
      )}

      {open && <div className="smsc-backdrop" onClick={close} aria-hidden="true" />}

      <nav id="smsc-nav" className={`smsc-nav${open ? ' is-open' : ''}`} aria-label="문자 관리 메뉴">
        <ul className="smsc-menu">
          {CONSOLE_MENUS.map((menu, index) => {
            const selected = menu.id === state.menu;
            return (
              <li key={menu.id}>
                <button
                  type="button"
                  ref={index === 0 ? firstRef : undefined}
                  className={`smsc-item${selected ? ' is-active' : ''}`}
                  aria-current={selected && !subId ? 'page' : undefined}
                  onClick={() => (selected ? setOpen(false) : choose(menu.id, {}))}
                >
                  <MenuIcon id={menu.id} />
                  <span>{menu.label}</span>
                </button>
                {selected && menu.subs && (
                  <ul className="smsc-sub">
                    {menu.subs.map(sub => (
                      <li key={sub.id}>
                        <button
                          type="button"
                          className={`smsc-subitem${subId === sub.id ? ' is-active' : ''}`}
                          aria-current={subId === sub.id ? 'page' : undefined}
                          onClick={() => choose(menu.id, subPatch(sub))}
                        >
                          {sub.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <p className="smsc-note">쏠라피 계정 중 한성쇼케이스 채널만 다룹니다</p>
      </nav>
    </div>
  );
}
