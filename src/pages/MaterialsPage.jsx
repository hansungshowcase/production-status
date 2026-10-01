import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMaterials } from '../api/materials.js';
import { aggregateMaterialOrders, filterMaterialOrders } from '../utils/materials.js';
import ErrorState from '../components/common/ErrorState.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import './MaterialsPage.css';

const SHIPPING_FILTERS = [
  { value: 'exclude_shipped', label: '출고완료 제외' },
  { value: 'all', label: '전체 출고' },
  { value: 'shipped', label: '출고완료' },
];

const MATERIAL_FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'incomplete', label: '미완료 포함' },
  { value: 'needs_review', label: '확인필요' },
  { value: 'receipt_incomplete', label: '발주서 수취 미완료' },
  { value: 'order_incomplete', label: '자재 발주 미완료' },
  { value: 'arrival_incomplete', label: '자재 입고 미완료' },
];

const STAGES = [
  { key: 'receipt', label: '발주서 수취' },
  { key: 'order', label: '자재 발주' },
  { key: 'arrival', label: '자재 입고' },
];

const STATUS_LABELS = {
  unchecked: '미체크',
  complete: '완료',
  needs_review: '확인필요',
};

const COMPANY_PAGE_SIZE = 40;

function formatFetchedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-2.05 4.95" />
    </svg>
  );
}

function StatusBadge({ stage }) {
  return (
    <span className={`materials-status materials-status--${stage.status}`}>
      <span>{STATUS_LABELS[stage.status]}</span>
      {stage.raw.trim() && <small>{stage.raw}</small>}
    </span>
  );
}

function StageCount({ label, count }) {
  return (
    <div className="materials-stage-count">
      <span>{label}</span>
      <strong>{count.complete_count}<small> / {count.target_order_count}</small></strong>
    </div>
  );
}

function OrderRow({ order }) {
  return (
    <div className="materials-order-row">
      <div className="materials-order-identity">
        <strong>{order.product_label || '작업명 미기재'}</strong>
        <small>시트 {order.source_row}행</small>
      </div>
      <div data-label="발주일">{order.order_date || '-'}</div>
      <div data-label="납기일">{order.due_date || '-'}</div>
      <div data-label="담당">{order.manager || '-'}</div>
      <div data-label="출고">{order.shipping.raw.trim() || '미출고'}</div>
      {STAGES.map(({ key, label }) => (
        <div key={key} data-label={label}>
          <StatusBadge stage={order.materials[key]} />
        </div>
      ))}
    </div>
  );
}

function CompanyCard({ company }) {
  return (
    <details className="materials-company-card">
      <summary>
        <div className="materials-company-heading">
          <div>
            <h2>{company.company}</h2>
            <p>{company.target_order_count}건 기준</p>
          </div>
          <span className="materials-company-disclosure" aria-hidden="true">상세</span>
        </div>
        <div className="materials-company-stages">
          {STAGES.map(({ key, label }) => (
            <StageCount key={key} label={label} count={company.stages[key]} />
          ))}
        </div>
      </summary>
      <div className="materials-order-list">
        <div className="materials-order-head" aria-hidden="true">
          <span>작업</span><span>발주일</span><span>납기일</span><span>담당</span><span>출고</span>
          <span>발주서 수취</span><span>자재 발주</span><span>자재 입고</span>
        </div>
        {company.orders.map(order => <OrderRow key={order.source_row} order={order} />)}
      </div>
    </details>
  );
}

export default function MaterialsPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [companyQuery, setCompanyQuery] = useState('');
  const [shipping, setShipping] = useState('exclude_shipped');
  const [material, setMaterial] = useState('all');
  const [visibleCompanyCount, setVisibleCompanyCount] = useState(COMPANY_PAGE_SIZE);

  const loadInitial = () => {
    setLoading(true);
    setError('');
    getMaterials()
      .then(result => setData(result))
      .catch(requestError => setError(requestError.message || '자재 현황을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    getMaterials()
      .then(result => {
        if (active) setData(result);
      })
      .catch(requestError => {
        if (active) setError(requestError.message || '자재 현황을 불러오지 못했습니다.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError('');
    try {
      setData(await getMaterials({ refresh: true }));
    } catch (requestError) {
      setRefreshError(requestError.message || '자재 현황을 갱신하지 못했습니다.');
    } finally {
      setRefreshing(false);
    }
  };

  const filteredOrders = useMemo(() => filterMaterialOrders(data?.orders ?? [], {
    companyQuery,
    shipping,
    material,
  }), [companyQuery, data, material, shipping]);
  const summary = useMemo(() => aggregateMaterialOrders(filteredOrders), [filteredOrders]);
  const visibleCompanies = summary.companies.slice(0, visibleCompanyCount);

  useEffect(() => {
    setVisibleCompanyCount(COMPANY_PAGE_SIZE);
  }, [companyQuery, material, shipping]);

  if (loading) return <LoadingSpinner message="자재 현황을 불러오는 중입니다..." />;
  if (!data) return <ErrorState message={error} onRetry={loadInitial} />;

  return (
    <main className="materials-page">
      <header className="materials-header">
        <div className="materials-header__inner">
          <button className="materials-back" type="button" onClick={() => navigate(-1)} aria-label="뒤로가기">
            &larr;
          </button>
          <div className="materials-title-block">
            <h1>업체별 자재 현황</h1>
            <p>발주서 수취부터 자재 입고까지 업체별로 확인합니다.</p>
          </div>
          <button
            className="materials-refresh"
            type="button"
            onClick={refresh}
            disabled={refreshing}
            aria-label={refreshing ? '시트 조회 중' : '시트 새로고침'}
          >
            <RefreshIcon />
            <span>{refreshing ? '조회 중' : '새로고침'}</span>
          </button>
        </div>
      </header>

      <div className="materials-content">
        <div className="materials-source-time">
          <span>시트 조회 {formatFetchedAt(data.fetched_at)}</span>
          <span>{data.source.title} · {data.source.tab}</span>
        </div>

        {refreshError && (
          <div className="materials-refresh-error" role="alert">
            <strong>갱신 실패 · 이전 조회 결과</strong>
            <span>{refreshError}</span>
          </div>
        )}

        <section className="materials-filters" aria-label="자재 현황 필터">
          <label className="materials-search">
            <span>업체 검색</span>
            <input
              type="search"
              value={companyQuery}
              onChange={event => setCompanyQuery(event.target.value)}
              placeholder="거래처명을 입력하세요"
            />
          </label>

          <fieldset>
            <legend>출고 구분</legend>
            <div className="materials-filter-buttons">
              {SHIPPING_FILTERS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={shipping === option.value ? 'is-selected' : ''}
                  aria-pressed={shipping === option.value}
                  onClick={() => setShipping(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>자재 구분</legend>
            <div className="materials-filter-buttons materials-filter-buttons--wide">
              {MATERIAL_FILTERS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={material === option.value ? 'is-selected' : ''}
                  aria-pressed={material === option.value}
                  onClick={() => setMaterial(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        </section>

        <section className="materials-summary" aria-label="현재 필터 집계">
          <div className="materials-summary-primary">
            <span>조회 업체</span>
            <strong>{summary.total_companies}<small>곳</small></strong>
          </div>
          <div className="materials-summary-primary">
            <span>대상 주문</span>
            <strong>{summary.total_orders}<small>건</small></strong>
          </div>
          {STAGES.map(({ key, label }) => (
            <StageCount key={key} label={`${label} 완료`} count={summary.stages[key]} />
          ))}
        </section>

        <section className="materials-companies" aria-live="polite">
          {summary.companies.length > 0
            ? visibleCompanies.map(company => <CompanyCard key={company.company} company={company} />)
            : (
              <div className="materials-empty">
                <strong>조건에 맞는 주문이 없습니다.</strong>
                <span>업체명 또는 필터를 변경해 주세요.</span>
              </div>
            )}
        </section>
        {visibleCompanyCount < summary.companies.length && (
          <button
            className="materials-more"
            type="button"
            onClick={() => setVisibleCompanyCount(count => count + COMPANY_PAGE_SIZE)}
          >
            업체 더 보기 ({summary.companies.length - visibleCompanyCount}곳 남음)
          </button>
        )}
      </div>
    </main>
  );
}
