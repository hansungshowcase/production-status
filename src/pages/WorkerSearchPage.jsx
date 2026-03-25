import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../components/common/Header';
import SearchBar from '../components/worker/SearchBar';
import SearchResultCard from '../components/worker/SearchResultCard';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorState from '../components/common/ErrorState';
import { getOrders } from '../api/orders';
import { formatDueStatus } from '../utils/dateUtils';
import { PROCESS_STEPS } from '../constants';
import useApi from '../hooks/useApi';
import './WorkerSearchPage.css';

function mapOrderForSearch(order) {
  const processes = order.processes || [];
  const completedCount = processes.filter((p) => p.status === 'completed').length;
  const inProgressProcess = processes.find((p) => p.status === 'in_progress');
  const currentStepIndex = inProgressProcess
    ? PROCESS_STEPS.indexOf(inProgressProcess.step_name)
    : completedCount;

  const isAllCompleted = completedCount === processes.length && processes.length > 0;
  const isInProgress = !!inProgressProcess;

  return {
    id: order.id,
    orderNumber: order.id,
    product: order.product_type,
    productType: order.product_type || null,
    doorType: order.door_type || null,
    width: order.width || null,
    depth: order.depth || null,
    height: order.height || null,
    color: order.color || null,
    quantity: order.quantity || null,
    client: order.client_name || '-',
    clientName: order.client_name || '',
    salesRep: order.sales_person || '',
    currentStep: currentStepIndex,
    currentStepName: inProgressProcess
      ? inProgressProcess.step_name
      : PROCESS_STEPS[currentStepIndex] || '-',
    completedSteps: completedCount,
    isActive: isInProgress,
    isCompleted: isAllCompleted,
    dueDate: order.due_date,
    dueStatus: formatDueStatus(order.due_date, order.status),
    processes,
  };
}

export default function WorkerSearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const { data: ordersRaw, loading, error, execute: fetchOrders } = useApi(
    async () => {
      const res = await getOrders({ status: 'in_production', limit: 100 });
      const orders = Array.isArray(res) ? res : (res.orders || []);
      const { default: request } = await import('../api/client');
      const detailed = await Promise.all(
        orders.map(async (o) => {
          try {
            return await request(`/orders/${o.id}`);
          } catch {
            return { ...o, processes: [] };
          }
        })
      );
      return detailed;
    }
  );

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const allOrders = useMemo(() => {
    return (ordersRaw || []).map(mapOrderForSearch);
  }, [ordersRaw]);

  const filteredOrders = useMemo(() => {
    if (!debouncedQuery.trim()) return allOrders;
    const q = debouncedQuery.trim().toLowerCase();
    return allOrders.filter((order) => {
      const searchFields = [
        order.clientName,
        order.client,
        order.productType,
        order.doorType,
        order.product,
        order.salesRep,
        order.width && order.depth && order.height
          ? `${order.width}x${order.depth}x${order.height}`
          : '',
        order.color,
        order.orderNumber,
      ];
      return searchFields.some((field) => field && String(field).toLowerCase().includes(q));
    });
  }, [allOrders, debouncedQuery]);

  const handleClear = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
  }, []);

  if (loading) {
    return (
      <div className="worker-search-page">
        <Header subtitle="주문 검색" profileEmoji="&#x1F50D;" onBack={() => navigate('/worker')} />
        <div className="wsp-content">
          <LoadingSpinner message="주문 목록을 불러오는 중..." />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="worker-search-page">
        <Header subtitle="주문 검색" profileEmoji="&#x1F50D;" onBack={() => navigate('/worker')} />
        <div className="wsp-content">
          <ErrorState message={error} onRetry={() => fetchOrders()} />
        </div>
      </div>
    );
  }

  return (
    <div className="worker-search-page">
      <Header subtitle="주문 검색" profileEmoji="&#x1F50D;" onBack={() => navigate('/worker')} />
      <div className="wsp-content">
        <div className="wsp-search-area">
          <SearchBar value={query} onChange={setQuery} onClear={handleClear} />
          <div className="wsp-result-count">
            {debouncedQuery.trim()
              ? `${filteredOrders.length}건 검색됨`
              : `전체 ${allOrders.length}건`}
          </div>
        </div>
        <div className="wsp-results">
          {filteredOrders.length === 0 ? (
            <div className="wsp-empty">
              <div className="wsp-empty-icon">&#x1F50D;</div>
              <div className="wsp-empty-text">검색 결과가 없습니다</div>
              <div className="wsp-empty-hint">거래처명, 사양, 규격으로 검색해보세요</div>
            </div>
          ) : (
            filteredOrders.map((order) => (
              <SearchResultCard key={order.id} order={order} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
