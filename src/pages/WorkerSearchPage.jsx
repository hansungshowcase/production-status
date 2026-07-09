import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../components/common/Header';
import SearchBar from '../components/worker/SearchBar';
import SearchResultCard from '../components/worker/SearchResultCard';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorState from '../components/common/ErrorState';
import { getOrders } from '../api/orders';
import { extractDueDateFromOrder, formatDueStatus } from '../utils/dateUtils';
import { PROCESS_STEPS } from '../constants';
import useApi from '../hooks/useApi';
import './WorkerSearchPage.css';

const WORKER_SEARCH_PAGE_SIZE = 100;

async function fetchAllWorkerSearchOrders() {
  const loaded = [];
  let offset = 0;
  let total = null;

  while (true) {
    const data = await getOrders({ status: 'in_production', limit: WORKER_SEARCH_PAGE_SIZE, offset });
    const page = Array.isArray(data) ? data : (data.orders || []);
    loaded.push(...page);
    total = Array.isArray(data) ? loaded.length : Number(data.total ?? loaded.length);

    if (page.length === 0 || loaded.length >= total) {
      return { orders: loaded, total };
    }

    offset += page.length;
  }
}

function parseProcessSummary(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value;
}

function getCurrentProcess(processes) {
  const priority = { in_progress: 3, waiting: 2, completed: 1 };
  const processByStep = new Map();
  (processes || []).forEach((process) => {
    const current = processByStep.get(process.step_name);
    if (!current || (priority[process.status] || 0) > (priority[current.status] || 0)) {
      processByStep.set(process.step_name, process);
    }
  });
  return PROCESS_STEPS
    .map((step) => processByStep.get(step))
    .find((process) => process && process.status !== 'completed') || null;
}

function buildProcessByStep(processes) {
  const priority = { in_progress: 3, waiting: 2, completed: 1 };
  const processByStep = new Map();
  (processes || []).forEach((process) => {
    const current = processByStep.get(process.step_name);
    if (!current || (priority[process.status] || 0) > (priority[current.status] || 0)) {
      processByStep.set(process.step_name, process);
    }
  });
  return processByStep;
}

function mapOrderForSearch(order) {
  const dueDate = extractDueDateFromOrder(order);
  const summary = parseProcessSummary(order.process_summary);
  const processes = (order.processes && order.processes.length > 0)
    ? order.processes
    : PROCESS_STEPS
      .map((step) => summary[step] ? { step_name: step, ...summary[step] } : null)
      .filter(Boolean);
  const processByStep = buildProcessByStep(processes);
  const completedCount = PROCESS_STEPS.filter((step) => processByStep.get(step)?.status === 'completed').length;
  const currentProcess = getCurrentProcess(processes);
  const inProgressProcess = currentProcess?.status === 'in_progress' ? currentProcess : null;
  const currentStepIndex = currentProcess
    ? PROCESS_STEPS.indexOf(currentProcess.step_name)
    : completedCount;

  const isAllCompleted = completedCount === PROCESS_STEPS.length;
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
    currentStepName: currentProcess
      ? currentProcess.step_name
      : PROCESS_STEPS[currentStepIndex] || '-',
    completedSteps: completedCount,
    isActive: isInProgress,
    isCompleted: isAllCompleted,
    dueDate,
    dueStatus: formatDueStatus(dueDate, order.status),
    processes,
  };
}

export default function WorkerSearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const { data: ordersRaw, loading, error, execute: fetchOrders } = useApi(
    async () => {
      return fetchAllWorkerSearchOrders();
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
    return (ordersRaw?.orders || []).map(mapOrderForSearch);
  }, [ordersRaw]);
  const allOrdersTotalCount = Number(ordersRaw?.total ?? allOrders.length);

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
              : `전체 ${allOrdersTotalCount}건`}
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
