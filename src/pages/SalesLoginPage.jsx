import { useNavigate } from 'react-router-dom';
import { SALES_PERSONS } from '../constants';
import './SalesLoginPage.css';

const LS_KEY = 'sales_last_person';

export default function SalesLoginPage() {
  const navigate = useNavigate();
  const lastPerson = localStorage.getItem(LS_KEY);

  function handleSelect(name) {
    localStorage.setItem(LS_KEY, name);
    navigate('/sales/my');
  }

  return (
    <div className="sl-page">
      {/* Background decoration */}
      <div className="sl-page__bg-circle sl-page__bg-circle--1" />
      <div className="sl-page__bg-circle sl-page__bg-circle--2" />

      {/* Top bar */}
      <div className="sl-page__topbar">
        <button className="sl-page__home-btn" onClick={() => navigate('/')}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M12.5 16.25L6.25 10L12.5 3.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          홈
        </button>
      </div>

      {/* Main content */}
      <div className="sl-page__content">
        {/* Logo / branding */}
        <div className="sl-page__brand">
          <div className="sl-page__logo">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect width="32" height="32" rx="8" fill="#2563eb"/>
              <path d="M8 16h6m4 0h6M16 8v6m0 4v6" stroke="white" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
          </div>
          <span className="sl-page__brand-text">한성쇼케이스</span>
        </div>

        <h1 className="sl-page__title">영업 관리</h1>
        <p className="sl-page__desc">
          담당자를 선택하여 발주현황을 확인하세요
        </p>

        {/* Quick re-login */}
        {lastPerson && (
          <button
            className="sl-page__quick"
            onClick={() => handleSelect(lastPerson)}
          >
            <div className="sl-page__quick-avatar">
              {lastPerson.charAt(0)}
            </div>
            <div className="sl-page__quick-info">
              <span className="sl-page__quick-label">최근 로그인</span>
              <span className="sl-page__quick-name">{lastPerson}</span>
            </div>
            <div className="sl-page__quick-arrow">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M7.5 3.75L13.75 10L7.5 16.25" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
          </button>
        )}

        {/* Divider */}
        {lastPerson && (
          <div className="sl-page__divider">
            <span>또는 담당자 선택</span>
          </div>
        )}

        {/* Person cards */}
        <div className="sl-page__cards">
          {SALES_PERSONS.map((person) => (
            <button
              key={person.name}
              className={`sl-page__card${lastPerson === person.name ? ' sl-page__card--last' : ''}`}
              onClick={() => handleSelect(person.name)}
              style={{ '--accent': person.color }}
            >
              <div className="sl-page__card-avatar" style={{ background: person.color }}>
                {person.name.charAt(0)}
              </div>
              <div className="sl-page__card-info">
                <span className="sl-page__card-name">{person.name}</span>
                <span className="sl-page__card-role">{person.role}</span>
              </div>
              <svg className="sl-page__card-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="sl-page__footer">
        한성쇼케이스 제작현황 v1.0
      </div>
    </div>
  );
}
