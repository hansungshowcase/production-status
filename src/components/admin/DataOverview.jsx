import React, { useState, useEffect } from 'react';
import request from '../../api/client';
import './DataOverview.css';

export default function DataOverview() {
  const [stats, setStats] = useState({ total: 0, inProgress: 0, shipped: 0 });
  const [syncTime, setSyncTime] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const fetchData = async () => {
    try {
      const [statsRes, syncRes] = await Promise.all([
        request('/stats'),
        request('/sync/status'),
      ]);
      setStats({
        total: statsRes.total || 0,
        inProgress: statsRes.inProgress || 0,
        shipped: statsRes.shipped || 0,
      });
      if (syncRes.lastSync) {
        setSyncTime(new Date(syncRes.lastSync).toLocaleString('ko-KR'));
      }
    } catch (err) {
      console.error('데이터 현황 조회 실패:', err);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await request('/sync/trigger', { method: 'POST' });
      await fetchData();
    } catch (err) {
      alert('동기화 실패: ' + err.message);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="data-overview">
      <h2>데이터 현황</h2>
      <p className="section-desc">주문 데이터 요약 및 시트 동기화 상태</p>

      <div className="overview-stats">
        <div className="overview-stat-card">
          <div className="overview-stat-value blue">{stats.total}</div>
          <div className="overview-stat-label">전체 주문</div>
        </div>
        <div className="overview-stat-card">
          <div className="overview-stat-value orange">{stats.inProgress}</div>
          <div className="overview-stat-label">생산중</div>
        </div>
        <div className="overview-stat-card">
          <div className="overview-stat-value green">{stats.shipped}</div>
          <div className="overview-stat-label">출고완료</div>
        </div>
      </div>

      <div className="overview-sync">
        <div className="overview-sync-info">
          <div>마지막 동기화</div>
          <div className="overview-sync-time">
            {syncTime || '정보 없음'}
          </div>
        </div>
        <button
          className="overview-sync-btn"
          onClick={handleSync}
          disabled={syncing}
        >
          {syncing ? '동기화 중...' : '수동 동기화'}
        </button>
      </div>
    </div>
  );
}
