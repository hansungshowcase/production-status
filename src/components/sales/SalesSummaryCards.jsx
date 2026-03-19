import React from 'react';
import './SalesSummaryCards.css';

export default function SalesSummaryCards({ total, inProduction, shipped, overdue, onFilter, activeFilter }) {
  const handle = (value) => {
    if (onFilter) onFilter(value);
  };

  const active = activeFilter || 'all';

  return (
    <div className="sales-summary-cards">
      <button className={`sales-summary-card sales-summary-card--total${active === 'all' ? ' sales-summary-card--active' : ''}`} onClick={() => handle('all')}>
        <div className="sales-summary-card__icon">📋</div>
        <div className="sales-summary-card__value">{total}</div>
        <div className="sales-summary-card__label">전체</div>
      </button>
      <button className={`sales-summary-card sales-summary-card--production${active === 'in_production' ? ' sales-summary-card--active' : ''}`} onClick={() => handle('in_production')}>
        <div className="sales-summary-card__icon">🔧</div>
        <div className="sales-summary-card__value">{inProduction}</div>
        <div className="sales-summary-card__label">생산중</div>
      </button>
      <button className={`sales-summary-card sales-summary-card--overdue${active === 'overdue' ? ' sales-summary-card--active' : ''}`} onClick={() => handle('overdue')}>
        <div className="sales-summary-card__icon">⚠️</div>
        <div className="sales-summary-card__value">{overdue}</div>
        <div className="sales-summary-card__label">납기초과</div>
      </button>
      <button className={`sales-summary-card sales-summary-card--shipped${active === 'shipped' ? ' sales-summary-card--active' : ''}`} onClick={() => handle('shipped')}>
        <div className="sales-summary-card__icon">📦</div>
        <div className="sales-summary-card__value">{shipped}</div>
        <div className="sales-summary-card__label">출고완료</div>
      </button>
    </div>
  );
}
