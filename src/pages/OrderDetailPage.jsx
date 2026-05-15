import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getOrder, deleteOrder, shipOrder } from '../api/orders';
import { resolveIssue } from '../api/issues';
import { deletePhoto } from '../api/photos';
import { formatDueStatus } from '../utils/dateUtils';
import { safeGet } from '../utils/safeStorage';
import { PROCESS_STEPS } from '../constants';
import OrderEditModal from '../components/order/OrderEditModal';
import './OrderDetailPage.css';

const LS_KEY = 'sales_last_person';

export default function OrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const salesPerson = safeGet(LS_KEY);
  const actor = salesPerson || '시스템';
  const canManageSales = Boolean(salesPerson);

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [confirmShip, setConfirmShip] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [resolvingIssueId, setResolvingIssueId] = useState(null);

  const fetchOrder = useCallback(async () => {
    setError(null);
    try {
      const data = await getOrder(id);
      setOrder(data);
    } catch (err) {
      setError(err.message || '주문을 불러올 수 없습니다');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    fetchOrder();
  }, [fetchOrder]);

  async function handleShip() {
    setActionLoading('ship');
    try {
      await shipOrder(order.id, actor);
      await fetchOrder();
      setConfirmShip(false);
    } catch (err) {
      alert('출고 처리 실패: ' + (err.message || ''));
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete() {
    setActionLoading('delete');
    try {
      await deleteOrder(order.id, actor, { delete_context: 'sales-management' });
      navigate(-1);
    } catch (err) {
      alert('삭제 실패: ' + (err.message || ''));
      setActionLoading(null);
    }
  }

  async function handleResolveIssue(issueId) {
    setResolvingIssueId(issueId);
    try {
      await resolveIssue(issueId, actor);
      await fetchOrder();
    } catch (err) {
      alert('이슈 해결 실패: ' + (err.message || ''));
    } finally {
      setResolvingIssueId(null);
    }
  }

  async function handleDeletePhoto(photoId) {
    if (!window.confirm('이 사진을 삭제하시겠습니까?')) return;
    try {
      await deletePhoto(photoId, actor);
      await fetchOrder();
    } catch (err) {
      alert('사진 삭제 실패: ' + (err.message || ''));
    }
  }

  if (loading) {
    return (
      <div className="odp-page">
        <div className="odp-loading">불러오는 중...</div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="odp-page">
        <div className="odp-error">
          <div>{error || '주문을 찾을 수 없습니다'}</div>
          <button className="odp-back-btn" onClick={() => navigate(-1)}>뒤로</button>
        </div>
      </div>
    );
  }

  const dueStatus = formatDueStatus(order.due_date, order.status);
  const isOverdue = dueStatus.isOverdue;
  const isShipped = order.status === 'shipped' || order.status === '출고완료' || !!order.ship_date;
  const completedSteps = (order.processes || []).filter(p => p.status === 'completed').length;
  const totalSteps = PROCESS_STEPS.length;
  const progressPct = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  const stepStatusMap = {};
  const stepHistMap = {};
  (order.processes || []).forEach(p => {
    stepStatusMap[p.step_name] = p.status;
    stepHistMap[p.step_name] = p;
  });

  const openIssues = (order.issues || []).filter(i => !i.resolved_at);
  const resolvedIssues = (order.issues || []).filter(i => !!i.resolved_at);

  return (
    <div className="odp-page">
      {/* Header */}
      <div className="odp-header">
        <button className="odp-back-btn" onClick={() => navigate(-1)}>&larr;</button>
        <div className="odp-header-title">
          <span className="odp-client">{order.client_name || '-'}</span>
          {isShipped && <span className="odp-badge odp-badge--shipped">출고완료</span>}
          {isOverdue && dueStatus.label && <span className="odp-badge odp-badge--overdue">{dueStatus.label}</span>}
        </div>
      </div>

      {/* 액션 버튼 */}
      <div className="odp-actions">
        {!isShipped && (
          <>
            <button className="odp-btn odp-btn--edit" onClick={() => setEditing(true)}>✏️ 수정</button>
            {!confirmShip ? (
              <button className="odp-btn odp-btn--ship" onClick={() => setConfirmShip(true)}>📦 출고완료</button>
            ) : (
              <div className="odp-confirm">
                <span>출고 처리?</span>
                <button className="odp-btn odp-btn--yes" disabled={actionLoading === 'ship'} onClick={handleShip}>
                  {actionLoading === 'ship' ? '처리 중...' : '확인'}
                </button>
                <button className="odp-btn odp-btn--no" onClick={() => setConfirmShip(false)}>취소</button>
              </div>
            )}
          </>
        )}
        {canManageSales && (
          !confirmDelete ? (
            <button className="odp-btn odp-btn--delete" onClick={() => setConfirmDelete(true)}>🗑 삭제</button>
          ) : (
            <div className="odp-confirm">
              <span>정말 삭제?</span>
              <button className="odp-btn odp-btn--yes" disabled={actionLoading === 'delete'} onClick={handleDelete}>
                {actionLoading === 'delete' ? '삭제 중...' : '삭제'}
              </button>
              <button className="odp-btn odp-btn--no" onClick={() => setConfirmDelete(false)}>취소</button>
            </div>
          )
        )}
      </div>

      {/* 진행률 */}
      <div className="odp-section">
        <div className="odp-section-title">진행 현황</div>
        <div className="odp-progress-bar">
          <div className={`odp-progress-fill${progressPct === 100 ? ' odp-progress-fill--done' : ''}`} style={{ width: `${progressPct}%` }} />
        </div>
        <div className="odp-progress-text">{completedSteps} / {totalSteps} 공정 완료 ({progressPct}%)</div>
      </div>

      {/* 공정 타임라인 */}
      <div className="odp-section">
        <div className="odp-section-title">공정 타임라인</div>
        <div className="odp-process-list">
          {PROCESS_STEPS.map((step) => {
            const st = stepStatusMap[step] || 'waiting';
            const p = stepHistMap[step];
            const isDone = st === 'completed';
            const isActive = st === 'in_progress';
            return (
              <div key={step} className={`odp-process-item odp-process-item--${isDone ? 'done' : isActive ? 'active' : 'wait'}`}>
                <div className="odp-process-dot" />
                <div className="odp-process-content">
                  <div className="odp-process-name">{step}</div>
                  <div className="odp-process-meta">
                    {isDone && p?.completed_by && <span>완료 · {p.completed_by}</span>}
                    {isActive && p?.started_by && <span>진행중 · {p.started_by}</span>}
                    {!isDone && !isActive && <span>대기</span>}
                    {p?.completed_at && <span> · {String(p.completed_at).replace('T', ' ').slice(0, 16)}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 주문 정보 */}
      <div className="odp-section">
        <div className="odp-section-title">주문 정보</div>
        <div className="odp-info-grid">
          <DetailRow label="발주일" value={order.order_date} />
          <DetailRow label="납기일" value={order.due_date} />
          <DetailRow label="담당" value={order.sales_person} />
          <DetailRow label="연락처" value={order.phone} />
          <DetailRow label="사양" value={[order.product_type, order.door_type].filter(Boolean).join(' / ')} />
          <DetailRow label="디자인" value={order.design} />
          <DetailRow label="규격" value={[order.width, order.depth, order.height].filter(Boolean).join(' × ') || ''} />
          <DetailRow label="수량" value={order.quantity ? `${order.quantity}대` : ''} />
          <DetailRow label="색상" value={order.color} />
          {order.ship_date && <DetailRow label="출고일" value={order.ship_date} />}
          {order.notes && <DetailRow label="비고" value={order.notes} full />}
          {order.remarks && <DetailRow label="특이사항" value={order.remarks} full />}
        </div>
      </div>

      {/* 이슈 */}
      <div className="odp-section">
        <div className="odp-section-title">
          이슈 <span className="odp-count">{openIssues.length} 미해결 / {resolvedIssues.length} 해결</span>
        </div>
        {openIssues.length === 0 && resolvedIssues.length === 0 ? (
          <div className="odp-empty">등록된 이슈가 없습니다</div>
        ) : (
          <div className="odp-issue-list">
            {openIssues.map(iss => (
              <div key={iss.id} className="odp-issue odp-issue--open">
                <div className="odp-issue-header">
                  <span className="odp-issue-type">{iss.issue_type}</span>
                  <span className="odp-issue-time">{iss.reported_at ? String(iss.reported_at).replace('T', ' ').slice(0, 16) : ''}</span>
                </div>
                {iss.description && <div className="odp-issue-desc">{iss.description}</div>}
                <div className="odp-issue-footer">
                  <span className="odp-issue-reporter">보고: {iss.reported_by || '-'}</span>
                  <button
                    className="odp-issue-resolve"
                    onClick={() => handleResolveIssue(iss.id)}
                    disabled={resolvingIssueId === iss.id}
                  >
                    {resolvingIssueId === iss.id ? '처리 중...' : '해결 완료'}
                  </button>
                </div>
              </div>
            ))}
            {resolvedIssues.map(iss => (
              <div key={iss.id} className="odp-issue odp-issue--resolved">
                <div className="odp-issue-header">
                  <span className="odp-issue-type">{iss.issue_type}</span>
                  <span className="odp-issue-time">해결: {iss.resolved_at ? String(iss.resolved_at).replace('T', ' ').slice(0, 16) : ''}</span>
                </div>
                {iss.description && <div className="odp-issue-desc">{iss.description}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 사진 */}
      <div className="odp-section">
        <div className="odp-section-title">
          사진 <span className="odp-count">{(order.photos || []).length}장</span>
        </div>
        {(order.photos || []).length === 0 ? (
          <div className="odp-empty">등록된 사진이 없습니다</div>
        ) : (
          <div className="odp-photo-grid">
            {order.photos.map(ph => (
              <div key={ph.id} className="odp-photo">
                <a href={ph.file_path} target="_blank" rel="noreferrer">
                  <img src={ph.file_path} alt="" loading="lazy" />
                </a>
                <button
                  className="odp-photo-del"
                  onClick={() => handleDeletePhoto(ph.id)}
                  title="사진 삭제"
                >&times;</button>
                <div className="odp-photo-meta">{ph.uploaded_by || '-'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 사전 제작 체크리스트 */}
      {order.pre_production && (
        <div className="odp-section">
          <div className="odp-section-title">사전 제작 체크리스트</div>
          <div className="odp-pre-grid">
            {Object.entries(order.pre_production)
              .filter(([k]) => !['id', 'order_id', 'created_at', 'updated_at'].includes(k))
              .map(([k, v]) => (
                <div key={k} className={`odp-pre-item${v ? ' odp-pre-item--ok' : ''}`}>
                  <span className="odp-pre-check">{v ? '✓' : '·'}</span>
                  <span>{k}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {editing && (
        <OrderEditModal
          order={order}
          onClose={() => setEditing(false)}
          onSaved={() => fetchOrder()}
        />
      )}
    </div>
  );
}

function DetailRow({ label, value, full }) {
  if (!value) return null;
  return (
    <div className={`odp-info-row${full ? ' odp-info-row--full' : ''}`}>
      <span className="odp-info-label">{label}</span>
      <span className="odp-info-value">{value}</span>
    </div>
  );
}
