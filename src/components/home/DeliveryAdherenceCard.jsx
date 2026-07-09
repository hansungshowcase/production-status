import React, { useEffect, useState } from 'react';
import { getDeliveryAdherence } from '../../api/deliveryAdherence';
import './DeliveryAdherenceCard.css';

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

const EMPTY_STATS = {
  total_production_units: 0,
  on_time_units: 0,
  missed_units: 0,
  missing_due_date_units: 0,
  adherence_rate: 0,
  calculated_at: '',
};

function formatNumber(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function isValidDeliveryAdherence(data) {
  if (!data || typeof data !== 'object') return false;
  return [
    'total_production_units',
    'on_time_units',
    'missed_units',
    'missing_due_date_units',
    'adherence_rate',
  ].every((key) => Number.isFinite(Number(data[key])));
}

function StatCell({ label, value, unit, tone }) {
  return (
    <div className={`delivery-adherence__cell delivery-adherence__cell--${tone}`}>
      <span className="delivery-adherence__label">{label}</span>
      <strong className="delivery-adherence__value">
        {value}
        <span>{unit}</span>
      </strong>
    </div>
  );
}

export default function DeliveryAdherenceCard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function loadStats() {
      try {
        const data = await getDeliveryAdherence();
        if (!isValidDeliveryAdherence(data)) {
          throw new Error('Invalid delivery adherence response');
        }
        if (!active) return;
        setStats({ ...EMPTY_STATS, ...data });
        setError('');
      } catch (err) {
        if (!active) return;
        setStats(null);
        setError('납기율을 불러오지 못했습니다');
      } finally {
        if (active) setLoading(false);
      }
    }

    loadStats();
    const refreshId = window.setInterval(loadStats, HALF_DAY_MS);

    return () => {
      active = false;
      window.clearInterval(refreshId);
    };
  }, []);

  const hasStats = Boolean(stats);
  const totalUnits = loading || !hasStats ? '-' : formatNumber(stats.total_production_units);
  const onTimeUnits = loading || !hasStats ? '-' : formatNumber(stats.on_time_units);
  const missedUnits = loading || !hasStats ? '-' : formatNumber(stats.missed_units);
  const rate = loading || !hasStats ? '-' : stats.adherence_rate.toLocaleString('ko-KR');

  return (
    <section className="delivery-adherence" aria-label="현재 납기 준수율">
      <div className="delivery-adherence__head">
        <div>
          <h2>현재 납기 준수율</h2>
          <p>총 생산대수 대비 납기 준수 현황</p>
        </div>
        <span className="delivery-adherence__refresh">하루 2회 갱신</span>
      </div>

      <div className="delivery-adherence__grid">
        <StatCell label="총 생산대수" value={totalUnits} unit="대" tone="total" />
        <StatCell label="납기준수" value={onTimeUnits} unit="대" tone="good" />
        <StatCell label="미준수" value={missedUnits} unit="대" tone="bad" />
        <StatCell label="준수율" value={rate} unit="%" tone="rate" />
      </div>

      {((stats?.missing_due_date_units || 0) > 0 || error) && (
        <p className="delivery-adherence__note">
          {error || `납기일 미입력 ${formatNumber(stats.missing_due_date_units)}대는 준수율 계산에서 제외`}
        </p>
      )}
    </section>
  );
}
