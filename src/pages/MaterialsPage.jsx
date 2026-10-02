import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMaterials } from '../api/materials.js';
import {
  aggregateMaterialOrders,
  filterMaterialOrders,
  parseMaterialCheckDate,
  scopeMaterialOrders,
  summarizeArrivalCheckNeeds,
  summarizeMaterialCheckDates,
} from '../utils/materials.js';
import { deriveMaterialsPresentation } from './materialsPresentation.js';
import ErrorState from '../components/common/ErrorState.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import './MaterialsPage.css';

const STATUS_FILTERS = [
  { value: 'all', label: '전체 업체' },
  { value: 'incomplete', label: '미완료 포함' },
  { value: 'needs_review', label: '확인필요 포함' },
  { value: 'receipt_incomplete', label: '발주서 미완료' },
  { value: 'order_incomplete', label: '자재발주 미완료' },
  { value: 'arrival_incomplete', label: '자재입고 미완료' },
];

const STAGES = [
  { key: 'receipt', index: 1, label: '발주서 수령', summaryLabel: '발주서' },
  { key: 'order', index: 2, label: '자재 발주', summaryLabel: '자재 발주' },
  { key: 'arrival', index: 3, label: '자재 입고', summaryLabel: '자재 입고' },
];

const STATUS_LABELS = {
  unchecked: '미체크',
  complete: '완료',
  needs_review: '확인필요',
};

const COMPANY_PAGE_SIZE = 40;

function stageCountTone({ target_order_count: N, complete_count: C, unchecked_count: U, needs_review_count: R }) {
  if (N > 0 && C === N) return 'complete';
  if (R > 0) return 'review';
  if (C > 0 && U > 0) return 'mixed';
  return 'unchecked';
}

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

function formatDateKey(value) {
  if (!value) return '-';
  const [year, month, day] = value.split('-');
  return `${year}. ${Number(month)}. ${Number(day)}.`;
}

function formatDueState(due) {
  if (!due || due.status === 'needs_review') return '';
  if (due.status === 'overdue') return `납기 경과 ${due.days}일`;
  if (due.status === 'today') return '오늘 납기';
  return `납기 D-${due.days}`;
}

const DUE_REVIEW_LABELS = {
  미기재: '납기 확인필요 · 미기재',
  날짜형식: '납기 확인필요 · 날짜 형식',
  발주일이전: '확인 필요 · 발주일 이전',
  조회기준일미기재: '납기 확인필요 · 조회 기준일 미기재',
};

const DUE_REVIEW_SEGMENTS = {
  미기재: ['납기 확인필요', '미기재'],
  날짜형식: ['납기 확인필요', '날짜 형식'],
  발주일이전: ['확인 필요', '발주일 이전'],
  조회기준일미기재: ['납기 확인필요', '조회 기준일 미기재'],
};

function formatDueDetail(due) {
  if (!due) return '납기 확인필요';
  if (due.status === 'needs_review') {
    return DUE_REVIEW_LABELS[due.reason] || '납기 확인필요';
  }
  return formatDueState(due);
}

function DueDetail({ due }) {
  if (due?.status !== 'needs_review') {
    return <small>{formatDueDetail(due)}</small>;
  }
  const segments = DUE_REVIEW_SEGMENTS[due.reason];
  if (!segments) return <small>{formatDueDetail(due)}</small>;
  return (
    <small className="materials-order-due__review">
      <span className="materials-order-due__meaning">{segments[0]}</span>
      <span className="materials-order-due__meaning"> · {segments[1]}</span>
    </small>
  );
}

function priorityLabel(company) {
  const deadline = company.representative_order.deadline;
  if (company.priority_rank === 1) return `입고 미체크 · 기준일 ${deadline.days}일 지남`;
  if (company.priority_rank === 2) return '입고 미체크 · 오늘 기준일';
  if (company.priority_rank === 4) return `입고 미체크 · 기준일까지 ${deadline.days}일`;
  if (company.priority_rank === 5) return '전체 입고 확인';
  const reason = DUE_REVIEW_SEGMENTS[deadline.reason]?.join(' · ')
    || (deadline.deadline_state === 'needs_review' ? '납기 확인필요' : '자재 상태 확인');
  return `확인필요 ${company.review_order_count}건 · ${reason}`;
}

function priorityDetail(company) {
  const deadline = company.representative_order.deadline;
  const details = [];
  if (company.priority_rank === 5 && deadline.deadline_state === 'overdue') {
    details.push(`입고 확인 · 기준일 ${deadline.days}일 경과`);
  }
  if (company.priority_rank === 3) details.push('확인할 수 없어 유지');
  if (company.additional_review_count > 0) details.push(`추가 확인 ${company.additional_review_count}건`);
  if (company.target_order_count > 1) details.push('우선 확인 주문 기준');
  return details.join(' · ');
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
  const raw = String(stage.raw ?? '').trim();
  return (
    <span className={`materials-status materials-status--${stage.status}`}>
      <span>{STATUS_LABELS[stage.status]}</span>
      {raw && <small>{raw}</small>}
    </span>
  );
}

function StageOverviewButton({ stage, counts, selected, onSelect, maxIncompleteCount, dataIdentity }) {
  const segments = [
    ['complete', '완료', counts.complete_count],
    ['unchecked', '미체크', counts.unchecked_count],
    ['needs_review', '확인필요', counts.needs_review_count],
  ];
  const incompleteCount = counts.unchecked_count + counts.needs_review_count;
  const hasTarget = counts.target_order_count > 0;
  const hasReview = counts.needs_review_count > 0;
  const isMostIncomplete = incompleteCount > 0 && incompleteCount === maxIncompleteCount;
  const accessibleCounts = `${stage.label}: 완료 ${counts.complete_count}건 · 미체크 ${counts.unchecked_count}건 · 확인필요 ${counts.needs_review_count}건 · 대상 ${counts.target_order_count}건`;

  return (
    <button
      className={`materials-overview-button${selected ? ' materials-overview-button--selected' : ''}${isMostIncomplete ? ' materials-overview-button--most' : ''}${!hasTarget ? ' materials-overview-button--empty' : ''}${hasTarget && !incompleteCount ? ' materials-overview-button--complete' : ''}`}
      type="button"
      data-stage={stage.key}
      data-stage-count={counts.target_order_count}
      data-incomplete-count={incompleteCount}
      aria-pressed={selected}
      aria-label={`${accessibleCounts}. 미완료 포함 업체 보기`}
      onClick={onSelect}
    >
      <span className="materials-overview-button__label">
        <span className="materials-stage-index" aria-hidden="true">{stage.index}</span>{stage.label}{selected && <span className="materials-overview-selected"> · 선택됨</span>}
      </span>
      <span className="materials-overview-primary">
        <span className="materials-overview-total">
          <strong className="materials-overview-total__number">{incompleteCount}</strong>
          <span className="materials-overview-total__unit">건</span>
        </span>
        {(incompleteCount === 0 || !hasTarget) && (
          <span className="materials-overview-status">{hasTarget ? '전체 완료' : '대상 없음'}</span>
        )}
        {isMostIncomplete && <em>최다</em>}
      </span>
      <span className="materials-overview-secondary">
        {hasTarget ? (
          <>
            <span className="materials-overview-completion-label">완료</span>{' '}
            <span className="materials-overview-completion-ratio">{counts.complete_count}/{counts.target_order_count}</span>
          </>
        ) : '대상 없음'}
        {hasReview && ` · 미체크 ${counts.unchecked_count} · 확인필요 ${counts.needs_review_count}`}
      </span>
      <span className="materials-overview-bar" aria-hidden="true">
        <span className="materials-stage-segments" key={dataIdentity}>
          {segments.map(([status, , count]) => (
            <span
              key={status}
              data-status={status}
              data-count={count}
              style={{ width: `${counts.target_order_count ? (count / counts.target_order_count) * 100 : 0}%` }}
            />
          ))}
        </span>
      </span>
    </button>
  );
}

function CheckDate({ stage }) {
  if (stage.status !== 'complete') return null;
  const date = parseMaterialCheckDate(stage.raw);
  return (
    <small
      className="materials-check-date"
      data-check-date={date?.identity ?? 'missing'}
      data-check-date-kind={date ? 'recorded' : 'missing'}
    >
      {date?.label ?? '체크일 미기록'}
    </small>
  );
}

function StageCheckDates({ summary, singleOrder }) {
  return (
    <>
      {summary.dates.map(date => (
        <small key={date.identity} className="materials-stage-check-date" data-check-date={date.identity} data-check-date-kind="recorded">
          {date.label}
        </small>
      ))}
      {!singleOrder && summary.additional_date_count > 0 && (
        <small className="materials-stage-check-date" data-check-date="additional" data-check-date-kind="additional">
          외 {summary.additional_date_count}개 날짜
        </small>
      )}
      {summary.missing_date_count > 0 && (
        <small className="materials-stage-check-date" data-check-date="missing" data-check-date-kind="missing">
          {singleOrder ? '체크일 미기록' : `체크일 미기록 ${summary.missing_date_count}건`}
        </small>
      )}
    </>
  );
}

function StageCount({ label, stageKey, count, orders }) {
  const singleOrder = count.target_order_count === 1;
  const checkDates = summarizeMaterialCheckDates(orders, stageKey);
  const tone = stageCountTone(count);
  let value;
  if (singleOrder) {
    const status = count.complete_count === 1
      ? 'complete'
      : count.unchecked_count === 1 ? 'unchecked' : 'needs_review';
    value = STATUS_LABELS[status];
  } else if (count.complete_count === count.target_order_count) {
    value = '전체 완료';
  } else {
    value = `완료 ${count.complete_count}/${count.target_order_count}`;
  }

  const secondary = [
    count.unchecked_count > 0 ? `미체크 ${count.unchecked_count}` : '',
    count.needs_review_count > 0 ? `확인필요 ${count.needs_review_count}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className={`materials-stage-count materials-stage-count--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <StageCheckDates summary={checkDates} singleOrder={singleOrder} />
      {!singleOrder && secondary && <small>{secondary}</small>}
    </div>
  );
}

function OrderRow({ order }) {
  const due = order.due;
  return (
    <div className="materials-order-row">
      <div className="materials-order-identity">
        <strong>{order.product_label || '작업명 미기재'}</strong>
        <small>시트 {order.source_row}행</small>
      </div>
      <div data-label="발주일">{order.order_date || '-'}</div>
      <div className="materials-order-due" data-label="납기일">
        <strong className={order.deadline.due_date_key ? 'materials-order-due__date' : ''}>
          {String(order.due_date ?? '').trim() || '-'}
        </strong>
        <DueDetail due={due} />
        {order.deadline.deadline_date_key && (
          <small className="materials-order-due__deadline">입고 기준일 {formatDateKey(order.deadline.deadline_date_key)}</small>
        )}
        {order.deadline.started_after_deadline && <small>발주 시점에 입고 기준일 경과</small>}
      </div>
      <div data-label="담당">{order.manager || '-'}</div>
      <div data-label="출고">{String(order.shipping.raw ?? '').trim() || '미출고'}</div>
      {STAGES.map(({ key, label }) => (
        <div key={key} data-label={label}>
          <StatusBadge stage={order.materials[key]} />
          <CheckDate stage={order.materials[key]} />
        </div>
      ))}
    </div>
  );
}

function CompanyCard({ company }) {
  const representative = company.representative_order;
  const detail = priorityDetail(company);
  const deadlineReason = DUE_REVIEW_LABELS[representative.deadline.reason]
    || '입고 기준일 계산불가 · 조회 기준일 미기재';
  const dueNeedsReview = representative.due.status === 'needs_review';
  return (
    <details className={`materials-company-card materials-company-card--${company.priority_tone}`}>
      <summary>
        <div className="materials-company-heading">
          <h2>{company.company}</h2>
          <p>대상 {company.target_order_count}건</p>
        </div>
        <div className="materials-company-priority">
          <strong>{priorityLabel(company)}</strong>
          {detail && <small>{detail}</small>}
        </div>
        <div className="materials-company-date materials-company-date--deadline" data-label="입고 기준일">
          <span>입고 기준일</span>
          <strong>{representative.deadline.deadline_date_key
            ? formatDateKey(representative.deadline.deadline_date_key)
            : '계산 불가'}</strong>
          {!representative.deadline.deadline_date_key && <small>{deadlineReason}</small>}
        </div>
        <div className="materials-company-date materials-company-date--due" data-label="납기">
          <span>납기</span>
          <strong>{representative.deadline.due_date_key
            ? formatDateKey(representative.deadline.due_date_key)
            : '납기 확인필요'}</strong>
          {dueNeedsReview && <small>{formatDueDetail(representative.due)}</small>}
          {company.priority_rank === 5 && ['overdue', 'today'].includes(representative.due.status) && (
            <small>{formatDueState(representative.due)}</small>
          )}
        </div>
        <div className="materials-company-stages">
          {STAGES.map(({ key, summaryLabel }) => (
            <StageCount key={key} label={summaryLabel} stageKey={key} count={company.stages[key]} orders={company.orders} />
          ))}
        </div>
        <span className="materials-company-disclosure">상세</span>
      </summary>
      <div className="materials-order-list">
        <div className="materials-order-head" aria-hidden="true">
          <span>작업</span><span>발주일</span><span>납기일</span><span>담당</span><span>출고</span>
          <span>발주서 수령</span><span>자재 발주</span><span>자재 입고</span>
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
  const [material, setMaterial] = useState('all');
  const [visibleCompanyCount, setVisibleCompanyCount] = useState(COMPANY_PAGE_SIZE);
  const [displayGeneration, setDisplayGeneration] = useState(0);

  const loadInitial = () => {
    setLoading(true);
    setError('');
    getMaterials()
      .then(result => {
        setData(result);
        setDisplayGeneration(generation => generation + 1);
      })
      .catch(requestError => setError(requestError.message || '자재 현황을 불러오지 못했습니다.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    getMaterials()
      .then(result => {
        if (active) {
          setData(result);
          setDisplayGeneration(generation => generation + 1);
        }
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
      const result = await getMaterials({ refresh: true });
      setData(result);
      setDisplayGeneration(generation => generation + 1);
    } catch (requestError) {
      setRefreshError(requestError.message || '자재 현황을 갱신하지 못했습니다.');
    } finally {
      setRefreshing(false);
    }
  };

  const scope = useMemo(
    () => scopeMaterialOrders(data?.orders ?? [], data?.fetched_at),
    [data],
  );
  const filteredOrders = useMemo(() => filterMaterialOrders(data?.orders ?? [], {
    companyQuery,
    material,
    fetchedAt: data?.fetched_at,
  }), [companyQuery, data, material]);
  const dueAnchor = scope.date_range?.end ?? null;
  const summary = useMemo(
    () => aggregateMaterialOrders(filteredOrders, dueAnchor),
    [dueAnchor, filteredOrders],
  );
  const arrivalCheckNeeds = useMemo(
    () => summarizeArrivalCheckNeeds(filteredOrders, dueAnchor),
    [dueAnchor, filteredOrders],
  );
  const presentation = useMemo(
    () => deriveMaterialsPresentation(summary, arrivalCheckNeeds),
    [arrivalCheckNeeds, summary],
  );
  const dataIdentity = displayGeneration;
  const groupedCompanies = [
    ...summary.companies.filter(company => company.priority_rank !== 3),
    ...summary.companies.filter(company => company.priority_rank === 3),
  ];
  const visibleCompanies = groupedCompanies.slice(0, visibleCompanyCount);
  const scheduleCompanies = visibleCompanies.filter(company => company.priority_rank !== 3);
  const reviewCompanies = visibleCompanies.filter(company => company.priority_rank === 3);
  const unverifiedShippingCount = filteredOrders
    .filter(order => order.shipping?.app_match !== 'verified').length;

  const selectStage = stageKey => {
    setMaterial(`${stageKey}_incomplete`);
    setVisibleCompanyCount(COMPANY_PAGE_SIZE);
  };

  useEffect(() => {
    setVisibleCompanyCount(COMPANY_PAGE_SIZE);
  }, [companyQuery, material]);

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
        <div className="materials-scope-line">
          <span>시트 조회 {formatFetchedAt(data.fetched_at)}</span>
          <span>최근 3개월 · 출고완료 제외 · 납기 5일 경과 제외</span>
        </div>

        {refreshError && (
          <div className="materials-refresh-error" role="alert">
            <strong>갱신 실패 · 이전 조회 결과</strong>
            <span>{refreshError}</span>
          </div>
        )}

        <section className={`materials-urgency materials-urgency--${presentation.urgency.tone}${presentation.show_empty ? ' materials-urgency--empty' : ''}`} aria-labelledby="materials-urgency-title" data-urgency-tone={presentation.urgency.tone}>
          <div className="materials-urgency__heading">
            <h2 id="materials-urgency-title">
              {presentation.show_empty
                ? '표시할 대상 없음'
                : presentation.show_all_complete
                  ? '모든 단계 완료 기록 확인'
                  : '입고 기록 우선 확인'}
            </h2>
            {!presentation.show_empty && !presentation.show_all_complete && (
              <strong className="materials-urgency__total">{presentation.urgency.overdue_count + presentation.urgency.today_count}건</strong>
            )}
          </div>
          {presentation.show_empty ? (
            <div className="materials-urgency__empty">
              <span>검색 또는 업체 상태를 변경해 주세요</span>
            </div>
          ) : presentation.show_all_complete ? null : presentation.urgency.neutral ? (
            <p className="materials-urgency__neutral">기준일 지난·오늘 미체크 0건</p>
          ) : (
            <div className="materials-urgency__breakdown">
              <span>기준일 지남 {presentation.urgency.overdue_count}건</span>
              <span>오늘 기준일 {presentation.urgency.today_count}건</span>
            </div>
          )}
          {(presentation.review_order_count > 0 || presentation.show_arrival_action) && (
            <div className="materials-urgency__footer">
              {presentation.review_order_count > 0 && (
                <p className="materials-urgency__review">일정·원본 확인 {presentation.review_order_count}건</p>
              )}
              {presentation.show_arrival_action && (
                <button className="materials-urgency__action" type="button" onClick={() => selectStage('arrival')}>
                  입고 미확인 업체 보기 →
                </button>
              )}
            </div>
          )}
        </section>

        <section className="materials-stage-overview" aria-labelledby="materials-stage-overview-title">
          <h2 id="materials-stage-overview-title">단계별 완료 미확인 · 업체 보기</h2>
          <div className="materials-overview-grid">
            {STAGES.map(stage => (
              <StageOverviewButton
                key={stage.key}
                stage={stage}
                counts={summary.stages[stage.key]}
                selected={material === `${stage.key}_incomplete`}
                onSelect={() => selectStage(stage.key)}
                maxIncompleteCount={presentation.max_incomplete_count}
                dataIdentity={dataIdentity}
              />
            ))}
          </div>
          <p className="materials-stage-overview__guide">미확인 = 완료 기록을 확인할 수 없는 주문</p>
          <p className="materials-stage-overview__guide">입고 기준일 = 납기 7일 전 · 단계 간 중복 집계</p>
        </section>

        <section className="materials-filters" aria-label="자재 현황 필터">
          <label className="materials-search">
            <span>업체 검색</span>
            <input
              type="search"
              value={companyQuery}
              onChange={event => setCompanyQuery(event.target.value)}
              placeholder="업체 검색"
            />
          </label>

          <label className="materials-status-filter">
            <span>업체 찾기</span>
            <select
              value={material}
              onChange={event => setMaterial(event.target.value)}
              aria-label="업체 찾기"
            >
              {STATUS_FILTERS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </section>

        <div className="materials-result-row">
          <div className="materials-result" aria-live="polite">
            <span className="materials-result__unit">{summary.total_companies}개 업체</span>
            <span className="materials-result__separator" aria-hidden="true"> · </span>
            <span className="materials-result__unit">대상 {summary.total_orders}건</span>
          </div>

          <details className="materials-scope-details">
            <summary>조회 범위·제외 내역</summary>
            <div className="materials-scope-details__body">
              <span>{data.source.title} · {data.source.tab}</span>
              <span>조회 범위 {formatDateKey(scope.date_range?.start)} ~ {formatDateKey(scope.date_range?.end)}</span>
              <span>
                제외: {scope.unknown_date_count > 0 && <>발주일 미확인 {scope.unknown_date_count}건 · </>}
                납기 5일 이상 경과 {scope.overdue_due_count}건
              </span>
              {(summary.deadline_counts.review_count > 0 || unverifiedShippingCount > 0) && (
                <span>
                  유지: {summary.deadline_counts.review_count > 0 && (
                    <>납기 확인필요 {summary.deadline_counts.review_count}건{unverifiedShippingCount > 0 && ' · '}</>
                  )}
                  {unverifiedShippingCount > 0 && <>앱 출고 대조 미확인 {unverifiedShippingCount}건</>}
                </span>
              )}
              <p>입고 기준일 = 납기 7일 전 · 미체크 = 완료 여부 미확인</p>
              <p>체크일: 시트 기록 날짜 · 연도 없으면 월/일</p>
            </div>
          </details>
        </div>

        <div className="materials-company-columns" aria-hidden="true">
          <span>업체 / 건수</span>
          <span>우선 확인</span>
          <span>입고 기준일</span>
          <span>납기</span>
          <span>발주서</span>
          <span>자재발주</span>
          <span>자재입고</span>
          <span>상세</span>
        </div>

        <section className="materials-company-groups" aria-live="polite">
          {scheduleCompanies.length > 0 && (
            <section className="materials-company-group" aria-label="입고 일정 확인">
              <h2>입고 일정 확인</h2>
              <div className="materials-companies">
                {scheduleCompanies.map(company => <CompanyCard key={company.company} company={company} />)}
              </div>
            </section>
          )}
          {reviewCompanies.length > 0 && (
            <section className="materials-company-group" aria-label="확인이 필요한 업체">
              <h2>확인이 필요한 업체</h2>
              <div className="materials-companies">
                {reviewCompanies.map(company => <CompanyCard key={company.company} company={company} />)}
              </div>
            </section>
          )}
          {summary.companies.length === 0 && (
            <div className="materials-empty">
              <strong>표시할 대상이 없습니다.</strong>
              <span>업체명 또는 상태를 변경해 주세요.</span>
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
