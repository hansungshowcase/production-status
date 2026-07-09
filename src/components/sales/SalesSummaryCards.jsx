import React from 'react';
import './SalesSummaryCards.css';

const SUMMARY_ITEMS = [
  { key: 'all', label: '전체', tone: 'total' },
  { key: 'in_production', label: '생산중', tone: 'production' },
  { key: 'packing_completed', label: '포장완료', tone: 'packing' },
  { key: 'overdue', label: '납기초과', tone: 'overdue' },
  { key: 'shipped', label: '출고완료', tone: 'shipped' },
];

export default function SalesSummaryCards({
  total,
  inProduction,
  packingCompleted,
  shipped,
  overdue,
  onFilter,
  activeFilter,
  onOverdueClick,
}) {
  const active = activeFilter || 'all';
  const values = {
    all: total,
    in_production: inProduction,
    packing_completed: packingCompleted,
    overdue,
    shipped,
  };

  const handle = (value) => {
    if (value === 'overdue' && onOverdueClick) {
      onOverdueClick();
      return;
    }
    if (onFilter) onFilter(value);
  };

  return (
    <section className="sales-summary-cards" aria-label="발주현황 요약">
      {SUMMARY_ITEMS.map((item) => (
        <button
          key={item.key}
          className={`sales-summary-card sales-summary-card--${item.tone}${active === item.key ? ' sales-summary-card--active' : ''}`}
          onClick={() => handle(item.key)}
          type="button"
        >
          <span className="sales-summary-card__accent" />
          <span className="sales-summary-card__label">{item.label}</span>
          <span className="sales-summary-card__value">{values[item.key]}</span>
        </button>
      ))}
    </section>
  );
}
