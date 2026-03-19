import React from 'react';
import ConnectionStatus from '../common/ConnectionStatus';
import './SalesHeader.css';

const TAB_LABELS = ['전체', '진행중', '지연', '완료'];

export default function SalesHeader({ salesName, activeTab, onTabChange, wsConnected, onBack, counts }) {
  return (
    <>
      <div className="sales-header">
        <div className="app-header-row">
          <div className="app-logo">
            {onBack && (
              <button className="header-back-btn" onClick={onBack} aria-label="뒤로가기">
                &larr;
              </button>
            )}
            <div className="logo-icon">HS</div>
            <div>
              <div className="app-title">한성쇼케이스</div>
              <div className="app-subtitle">영업 현황보드</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {wsConnected !== undefined && <ConnectionStatus connected={wsConnected} />}
            <div className="profile-icon">💼</div>
          </div>
        </div>
        <div className="sales-greeting">{salesName}님의 발주 현황</div>
      </div>

      <div className="sales-tabs">
        {TAB_LABELS.map((label, idx) => {
          const count = counts ? (Array.isArray(counts) ? counts[idx] : counts[label]) : null;
          return (
            <button
              key={idx}
              className={`sales-tab ${idx === activeTab ? 'active' : ''}`}
              onClick={() => onTabChange(idx)}
            >
              {label}{count != null ? ` (${count})` : ''}
            </button>
          );
        })}
      </div>
    </>
  );
}
