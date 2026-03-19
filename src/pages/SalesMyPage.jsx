import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import SalesSummaryCards from '../components/sales/SalesSummaryCards';
import SalesOrderCard from '../components/sales/SalesOrderCard';
import SearchBar from '../components/common/SearchBar';
import { getOrders, deleteOrder } from '../api/orders';
import { getFeed } from '../api/feed';
import { formatDueStatus } from '../utils/dateUtils';
import useWebSocket from '../hooks/useWebSocket';
import './SalesMyPage.css';

const LS_KEY = 'sales_last_person';
const REFRESH_INTERVAL = 5000; // 5 seconds

const SALES_PERSONS = ['신은철', '이시아'];

const FILTER_TABS = [
  { label: '전체', value: 'all' },
  { label: '생산중', value: 'in_production' },
  { label: '납기초과', value: 'overdue' },
  { label: '출고완료', value: 'shipped' },
];


function isShipped(order) {
  return order.status === 'shipped' || order.status === '출고완료' || !!order.ship_date;
}

function isOverdue(order) {
  const ds = formatDueStatus(order.due_date, order.status);
  return ds.isOverdue;
}

function isInProduction(order) {
  return !isShipped(order);
}


export default function SalesMyPage() {
  const navigate = useNavigate();
  const mySalesPerson = localStorage.getItem(LS_KEY);
  const { lastMessage, isConnected } = useWebSocket();

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [feedItems, setFeedItems] = useState([]);

  // "다른 담당자 보기" state
  const [viewingPerson, setViewingPerson] = useState(null); // null = viewing own orders
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const intervalRef = useRef(null);

  const activePerson = viewingPerson || mySalesPerson;
  const isViewingOther = !!viewingPerson;

  // Redirect if no person selected
  useEffect(() => {
    if (!mySalesPerson) {
      navigate('/sales/login', { replace: true });
    }
  }, [mySalesPerson, navigate]);

  // 드롭다운 닫기는 오버레이 onClick으로 처리

  const fetchOrders = useCallback(async () => {
    if (!activePerson) return;
    try {
      setError(null);
      const res = await getOrders({ sales_person: activePerson });
      const list = Array.isArray(res) ? res : (res.orders || []);

      // Fetch detail for each order for process info
      const { default: request } = await import('../api/client');
      const detailed = await Promise.all(
        list.map(async (o) => {
          try {
            return await request(`/orders/${o.id}`);
          } catch {
            return { ...o, processes: [] };
          }
        })
      );
      setOrders(detailed);
    } catch (err) {
      setError(err.message || '데이터를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, [activePerson]);

  const fetchFeed = useCallback(async () => {
    try {
      const data = await getFeed();
      setFeedItems(Array.isArray(data) ? data : []);
    } catch { /* ignore */ }
  }, []);

  // Initial fetch + auto-refresh
  useEffect(() => {
    setLoading(true);
    setOrders([]);
    fetchOrders();
    fetchFeed();
    intervalRef.current = setInterval(() => { fetchOrders(); fetchFeed(); }, REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [fetchOrders, fetchFeed]);

  // WebSocket 실시간 연동 — 현장 작업 변경 시 즉시 반영
  useEffect(() => {
    if (!lastMessage) return;
    const { type } = lastMessage;
    if (['PROCESS_STARTED', 'PROCESS_COMPLETED', 'PROCESS_REVERTED',
         'ISSUE_REPORTED', 'ISSUE_RESOLVED',
         'ORDER_CREATED', 'ORDER_UPDATED', 'ORDER_DELETED', 'ORDER_SHIPPED',
         'PRE_PRODUCTION_UPDATED'].includes(type)) {
      fetchOrders();
      fetchFeed();
    }
  }, [lastMessage, fetchOrders, fetchFeed]);

  if (!mySalesPerson) return null;

  // Compute summary counts (from all orders, before any filter)
  const totalCount = orders.length;
  const shippedCount = orders.filter(isShipped).length;
  const inProductionCount = orders.filter(isInProduction).length;
  const overdueCount = orders.filter(isOverdue).length;

  // Apply status filter
  let filtered = orders;
  if (filter === 'in_production') filtered = orders.filter(isInProduction);
  else if (filter === 'shipped') filtered = orders.filter(isShipped);
  else if (filter === 'overdue') filtered = orders.filter(isOverdue);

  // Apply search filter
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    filtered = filtered.filter((o) =>
      (o.client_name || '').toLowerCase().includes(q) ||
      (o.product_type || '').toLowerCase().includes(q) ||
      (o.door_type || '').toLowerCase().includes(q) ||
      (o.color || '').toLowerCase().includes(q) ||
      (o.design || '').toLowerCase().includes(q) ||
      (o.notes || '').toLowerCase().includes(q)
    );
  }

  function handleSelectPerson(person) {
    if (person === mySalesPerson) {
      setViewingPerson(null);
    } else {
      setViewingPerson(person);
    }
    setDropdownOpen(false);
    setFilter('all');
    setSearchQuery('');
  }

  function handleReturnToOwn() {
    setViewingPerson(null);
    setFilter('all');
    setSearchQuery('');
  }

  async function handleDeleteOrder(order) {
    try {
      await deleteOrder(order.id);
      setOrders(prev => prev.filter(o => o.id !== order.id));
    } catch (err) {
      alert('삭제 실패: ' + (err.message || ''));
    }
  }

  return (
    <div className="sales-my-page">
      {/* ── Header ── */}
      <div className="sales-my-page__header">
        <div className="sales-my-page__header-left">
          <button
            className="sales-my-page__home-btn"
            onClick={() => navigate('/')}
            title="홈으로"
          >
            🏠
          </button>
          <button
            className="sales-my-page__back-btn"
            onClick={() => navigate('/sales/login')}
            title="로그인 화면으로"
          >
            &larr;
          </button>
          <div className="sales-my-page__title-group">
            <span className="sales-my-page__title">
              {activePerson}님의 발주현황
            </span>
            {isViewingOther && (
              <span className="sales-my-page__viewing-badge">타인 조회 중</span>
            )}
          </div>
        </div>

        <div className="sales-my-page__header-right">
          {/* 다른 담당자 보기 */}
          <div className="sales-my-page__person-picker">
            <button
              className={`sales-my-page__person-btn${isViewingOther ? ' sales-my-page__person-btn--active' : ''}`}
              onClick={() => setDropdownOpen((v) => !v)}
              title="다른 담당자 보기"
            >
              <span className="sales-my-page__person-btn-icon" aria-hidden="true">👤</span>
              <span className="sales-my-page__person-btn-label">
                {isViewingOther ? viewingPerson : '담당자 변경'}
              </span>
              <span className="sales-my-page__person-btn-caret" aria-hidden="true">
                {dropdownOpen ? '▲' : '▼'}
              </span>
            </button>
          </div>

          {/* 내 주문으로 돌아가기 */}
          {isViewingOther && (
            <button
              className="sales-my-page__return-btn"
              onClick={handleReturnToOwn}
              title="내 주문으로 돌아가기"
            >
              ← 내 주문
            </button>
          )}

          <button
            className="sales-my-page__new-order-btn"
            onClick={() => navigate('/orders/new', { state: { salesPerson: mySalesPerson } })}
            title="새 주문 등록"
          >
            <span className="sales-my-page__new-order-btn-icon">+</span>
            <span className="sales-my-page__new-order-btn-label">작업 등록하기</span>
          </button>
          <span className="sales-my-page__refresh-info">30초 자동갱신</span>
        </div>
      </div>

      {/* ── 담당자 드롭다운 (헤더 밖에 렌더링) ── */}
      {dropdownOpen && (
        <div className="sales-my-page__person-dropdown-overlay" onClick={() => setDropdownOpen(false)}>
          <div className="sales-my-page__person-dropdown" onClick={(e) => e.stopPropagation()}>
            <div className="sales-my-page__person-dropdown-header">담당자 선택</div>
            {SALES_PERSONS.map((person) => {
              const isMe = person === mySalesPerson;
              const isSelected = person === activePerson;
              return (
                <button
                  key={person}
                  className={`sales-my-page__person-option${isSelected ? ' sales-my-page__person-option--selected' : ''}`}
                  onClick={() => handleSelectPerson(person)}
                >
                  <span className="sales-my-page__person-option-name">{person}</span>
                  {isMe && (
                    <span className="sales-my-page__person-option-tag">나</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Search ── */}
      <div style={{ padding: '12px 20px 0' }}>
        <SearchBar
          placeholder="거래처, 사양, 색상으로 검색"
          onSearch={setSearchQuery}
        />
      </div>

      {/* ── Summary cards ── */}
      <SalesSummaryCards
        total={totalCount}
        inProduction={inProductionCount}
        shipped={shippedCount}
        overdue={overdueCount}
        onFilter={setFilter}
        activeFilter={filter}
      />

      {/* ── Status filter bar ── */}
      <div className="sales-my-page__filter-bar">
        {FILTER_TABS.map((tab) => {
          let cls = 'sales-my-page__filter-btn';
          if (filter === tab.value) cls += ' sales-my-page__filter-btn--active';
          if (tab.value === 'overdue') cls += ' sales-my-page__filter-btn--overdue';
          return (
            <button
              key={tab.value}
              className={cls}
              onClick={() => setFilter(tab.value)}
            >
              {tab.label}
              {tab.value === 'overdue' && overdueCount > 0 ? ` (${overdueCount})` : ''}
            </button>
          );
        })}
      </div>

      {/* ── 2-column: 주문목록(좌) + 활동로그(우) ── */}
      <div className="sales-my-page__body">
        {/* ── 좌측: 주문 목록 ── */}
        <div className="sales-my-page__main">
          {/* Order list / states */}
          {loading ? (
            <div className="sales-my-page__loading">
              <div className="sales-my-page__spinner" />
              <span>발주 내역을 불러오는 중...</span>
            </div>
          ) : error ? (
            <div className="sales-my-page__error">
              <div>{error}</div>
              <button className="sales-my-page__retry-btn" onClick={fetchOrders}>다시 시도</button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="sales-my-page__empty">
              {filter === 'all'
                ? '담당 발주가 없습니다'
                : '해당 조건의 발주가 없습니다'}
            </div>
          ) : (
            <div className="sales-my-page__order-list">
              {filtered.map((order, idx) => (
                <SalesOrderCard key={order.id || idx} order={order} onDelete={handleDeleteOrder} />
              ))}
            </div>
          )}
        </div>

        {/* ── 우측: 활동로그 세로 사이드바 ── */}
        <aside className="sales-my-page__feed-log">
          <div className="sales-my-page__feed-header">
            <span className="sales-my-page__feed-dot" />
            <span className="sales-my-page__feed-title">실시간 활동로그</span>
            <span className="sales-my-page__feed-count">{feedItems.length}</span>
          </div>
          {feedItems.length === 0 ? (
            <div className="sales-my-page__feed-empty">활동 내역이 없습니다</div>
          ) : (
            <div className="sales-my-page__feed-list">
              {feedItems.map((item, idx) => {
                const d = new Date(item.created_at);
                const time = `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                const colorMap = { '공정시작': '#0ea5e9', '공정완료': '#059669', '이슈등록': '#dc2626', '이슈해결': '#059669', '주문등록': '#7c3aed', '출고완료': '#d97706' };
                const bgMap = { '공정시작': '#e0f2fe', '공정완료': '#d1fae5', '이슈등록': '#fee2e2', '이슈해결': '#d1fae5', '주문등록': '#ede9fe', '출고완료': '#fef3c7' };
                const iconMap = { '공정시작': '▶', '공정완료': '✓', '이슈등록': '!', '이슈해결': '✓', '주문등록': '+', '출고완료': '📦' };
                const color = colorMap[item.action_type] || '#64748b';
                const bg = bgMap[item.action_type] || '#f1f5f9';
                const icon = iconMap[item.action_type] || '•';
                return (
                  <div key={item.id || idx} className="sales-my-page__feed-item">
                    <span className="sales-my-page__feed-time">{time}</span>
                    <div className="sales-my-page__feed-line">
                      <div className="sales-my-page__feed-icon" style={{ background: bg, color }}>
                        {icon}
                      </div>
                      {idx < feedItems.length - 1 && <div className="sales-my-page__feed-connector" />}
                    </div>
                    <div className="sales-my-page__feed-content">
                      <div className="sales-my-page__feed-action" style={{ color }}>{item.action_type}</div>
                      <div className="sales-my-page__feed-desc">{item.description}</div>
                      {item.actor && <div className="sales-my-page__feed-actor">담당: {item.actor}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>

      {/* ── FAB ── */}
      <button
        className="sales-my-page__fab"
        onClick={() => navigate('/orders/new', { state: { salesPerson: mySalesPerson } })}
        title="새 주문 등록"
      >
        <span className="sales-my-page__fab-icon">+</span>
        <span className="sales-my-page__fab-label">작업 등록하기</span>
      </button>
    </div>
  );
}
