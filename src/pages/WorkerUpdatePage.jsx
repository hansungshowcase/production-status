import React, { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Header from '../components/common/Header';
import Toast from '../components/common/Toast';
import Modal from '../components/common/Modal';
import ProcessUpdatePanel from '../components/worker/ProcessUpdatePanel';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorState from '../components/common/ErrorState';
import { getOrder } from '../api/orders';
import { startProcess, completeProcess } from '../api/processes';
import { reportIssue as reportIssueApi } from '../api/issues';
import { uploadPhoto } from '../api/photos';
import { formatDueStatus } from '../utils/dateUtils';
import { PROCESS_STEPS } from '../constants';
import useApi from '../hooks/useApi';
import './WorkerUpdatePage.css';

const WORKER_NAME = '작업자';

const ISSUE_TYPES = [
  { key: '자재부족', label: '자재 부족/지연', bg: '#fffbeb', color: '#d97706' },
  { key: '불량발생', label: '불량 발생', bg: '#fef2f2', color: '#dc2626' },
  { key: '설비고장', label: '설비 고장', bg: '#f5f3ff', color: '#7c3aed' },
  { key: '기타', label: '기타', bg: '#f0f4ff', color: '#666' },
];

export default function WorkerUpdatePage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const { data: order, loading, error, execute: fetchOrder } = useApi(
    () => getOrder(id)
  );

  const [toast, setToast] = useState({ visible: false, message: '' });
  const [modal, setModal] = useState({ visible: false, type: null });
  const [actionLoading, setActionLoading] = useState(false);

  const showToast = useCallback((message) => {
    setToast({ visible: true, message });
  }, []);

  const hideToast = useCallback(() => {
    setToast({ visible: false, message: '' });
  }, []);

  const closeModal = () => setModal({ visible: false, type: null });

  // Derive process state
  const processes = order?.processes || [];
  const completedCount = processes.filter((p) => p.status === 'completed').length;
  const inProgressProcess = processes.find((p) => p.status === 'in_progress');
  const currentStepIndex = inProgressProcess
    ? PROCESS_STEPS.indexOf(inProgressProcess.step_name)
    : completedCount;
  const isAllCompleted = completedCount === processes.length && processes.length > 0;
  const isActive = !!inProgressProcess;

  const dueStatus = order ? formatDueStatus(order.due_date, order.status) : null;

  const displaySpec = order
    ? order.product_type
      ? `${order.product_type}${order.door_type ? ' / ' + order.door_type : ''}`
      : order.product_name || '-'
    : '-';

  const dimensions =
    order && order.width && order.depth && order.height
      ? `${order.width}x${order.depth}x${order.height}`
      : null;

  const clientDisplay = order
    ? `${order.client_name}${order.client_store ? ' ' + order.client_store : ''}`
    : '';

  // Action handlers
  const handleStartClick = () => {
    const stepName = PROCESS_STEPS[currentStepIndex] || '다음 공정';
    setModal({ visible: true, type: 'start', stepName });
  };

  const handleCompleteClick = () => {
    const stepName = inProgressProcess?.step_name || PROCESS_STEPS[currentStepIndex] || '';
    setModal({ visible: true, type: 'complete', stepName });
  };

  const confirmStart = async () => {
    const waitingProcess = processes.find((p) => p.status === 'waiting');
    if (!waitingProcess) {
      showToast('시작할 수 있는 공정이 없습니다');
      closeModal();
      return;
    }
    setActionLoading(true);
    try {
      await startProcess(waitingProcess.id, {
        assigned_worker: WORKER_NAME,
        assigned_team: '조립팀',
      });
      closeModal();
      showToast('공정이 시작되었습니다');
      setTimeout(() => navigate('/worker/search'), 1200);
    } catch (err) {
      showToast(`공정 시작 실패: ${err.message}`);
      closeModal();
    } finally {
      setActionLoading(false);
    }
  };

  const confirmComplete = async () => {
    if (!inProgressProcess) {
      showToast('완료할 수 있는 공정이 없습니다');
      closeModal();
      return;
    }
    setActionLoading(true);
    try {
      await completeProcess(inProgressProcess.id);
      closeModal();
      showToast('공정 완료! 다음 공정팀에 알림 전송됨');
      setTimeout(() => navigate('/worker/search'), 1200);
    } catch (err) {
      showToast(`공정 완료 실패: ${err.message}`);
      closeModal();
    } finally {
      setActionLoading(false);
    }
  };

  const handlePhoto = async () => {
    if (!order) return;
    const activeProc = inProgressProcess || processes.find((p) => p.status === 'waiting');
    try {
      await uploadPhoto({
        order_id: order.id,
        process_id: activeProc?.id,
        file_path: `/photos/${order.order_number}_${Date.now()}.jpg`,
        uploaded_by: WORKER_NAME,
      });
      showToast('사진이 첨부되었습니다');
    } catch (err) {
      showToast(`사진 첨부 실패: ${err.message}`);
    }
  };

  const handleIssueClick = () => {
    setModal({ visible: true, type: 'issue' });
  };

  const submitIssue = async (issueType) => {
    const activeProc = inProgressProcess || processes.find((p) => p.status === 'waiting');
    setActionLoading(true);
    try {
      await reportIssueApi({
        order_id: order.id,
        process_id: activeProc?.id,
        issue_type: issueType,
        description: issueType,
        reported_by: WORKER_NAME,
      });
      closeModal();
      showToast(`"${issueType}" 이슈가 보고되었습니다`);
    } catch (err) {
      showToast(`이슈 보고 실패: ${err.message}`);
      closeModal();
    } finally {
      setActionLoading(false);
    }
  };

  const renderModalContent = () => {
    if (modal.type === 'start') {
      return (
        <>
          <div className="wup-modal-icon">&#x25B6;&#xFE0F;</div>
          <div className="wup-modal-title">공정 시작</div>
          <div className="wup-modal-desc">
            <strong>{modal.stepName}</strong> 공정을 시작할까요?
            <br />
            <small style={{ color: '#999' }}>시작 시간이 자동 기록됩니다</small>
          </div>
          <div className="wup-modal-btns">
            <button className="wup-modal-btn wup-modal-cancel" onClick={closeModal} disabled={actionLoading}>
              취소
            </button>
            <button className="wup-modal-btn wup-modal-confirm" onClick={confirmStart} disabled={actionLoading}>
              {actionLoading ? '처리중...' : '시작하기'}
            </button>
          </div>
        </>
      );
    }

    if (modal.type === 'complete') {
      return (
        <>
          <div className="wup-modal-icon">&#x2705;</div>
          <div className="wup-modal-title">공정 완료</div>
          <div className="wup-modal-desc">
            <strong>{modal.stepName}</strong> 공정을 완료 처리할까요?
            <br />
            <small style={{ color: '#999' }}>다음 공정팀에 자동 알림됩니다</small>
          </div>
          <div className="wup-modal-btns">
            <button className="wup-modal-btn wup-modal-cancel" onClick={closeModal} disabled={actionLoading}>
              취소
            </button>
            <button className="wup-modal-btn wup-modal-confirm wup-modal-green" onClick={confirmComplete} disabled={actionLoading}>
              {actionLoading ? '처리중...' : '완료하기'}
            </button>
          </div>
        </>
      );
    }

    if (modal.type === 'issue') {
      return (
        <>
          <div className="wup-modal-icon">&#x26A0;&#xFE0F;</div>
          <div className="wup-modal-title">이슈 보고</div>
          <div className="wup-modal-desc">어떤 문제가 발생했나요?</div>
          <div className="wup-issue-options">
            {ISSUE_TYPES.map((it) => (
              <button
                key={it.key}
                className="wup-issue-btn"
                style={{ background: it.bg, color: it.color }}
                onClick={() => submitIssue(it.key)}
                disabled={actionLoading}
              >
                {it.label}
              </button>
            ))}
          </div>
          <button
            className="wup-modal-btn wup-modal-cancel"
            style={{ width: '100%', marginTop: 8 }}
            onClick={closeModal}
            disabled={actionLoading}
          >
            취소
          </button>
        </>
      );
    }

    return null;
  };

  if (loading) {
    return (
      <div className="worker-update-page">
        <Header subtitle="주문 상세" profileEmoji="&#x1F4CB;" onBack={() => navigate('/worker/search')} />
        <div className="wup-content">
          <LoadingSpinner message="주문 정보를 불러오는 중..." />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="worker-update-page">
        <Header subtitle="주문 상세" profileEmoji="&#x1F4CB;" onBack={() => navigate('/worker/search')} />
        <div className="wup-content">
          <ErrorState message={error} onRetry={() => fetchOrder()} />
        </div>
      </div>
    );
  }

  if (!order) return null;

  return (
    <div className="worker-update-page">
      <Header subtitle="주문 상세" profileEmoji="&#x1F4CB;" onBack={() => navigate('/worker/search')} />
      <div className="wup-content">
        {/* Order info card */}
        <div className="wup-order-card">
          {dueStatus?.label && (
            <div className={`wup-due-badge ${dueStatus.isOverdue ? 'wup-due-red' : 'wup-due-orange'}`}>
              {dueStatus.label}
            </div>
          )}
          <div className="wup-order-client">{clientDisplay}</div>
          <div className="wup-order-spec">{displaySpec}</div>
          <div className="wup-order-details">
            {dimensions && <span className="wup-detail-tag">규격 {dimensions}</span>}
            {order.color && <span className="wup-detail-tag">색상 {order.color}</span>}
            {order.quantity && <span className="wup-detail-tag">수량 {order.quantity}</span>}
            {order.due_date && (
              <span className="wup-detail-tag">
                납기 {typeof order.due_date === 'string' ? order.due_date.slice(0, 10) : ''}
              </span>
            )}
          </div>
        </div>

        {/* Process pipeline */}
        <ProcessUpdatePanel
          processes={processes}
          currentStep={currentStepIndex}
          isActive={isActive}
          isCompleted={isAllCompleted}
          onStart={handleStartClick}
          onComplete={handleCompleteClick}
        />

        {/* Bottom action buttons */}
        {!isAllCompleted && (
          <div className="wup-bottom-actions">
            <button className="wup-action-btn wup-photo-btn" onClick={handlePhoto}>
              &#x1F4F7; 사진 첨부
            </button>
            <button className="wup-action-btn wup-issue-btn" onClick={handleIssueClick}>
              &#x26A0;&#xFE0F; 이슈 보고
            </button>
          </div>
        )}

        <div style={{ height: 32 }} />
      </div>

      <Toast message={toast.message} visible={toast.visible} onHide={hideToast} />
      <Modal visible={modal.visible} onClose={closeModal}>
        {renderModalContent()}
      </Modal>
    </div>
  );
}
