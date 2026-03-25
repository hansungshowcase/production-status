import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Header from '../components/common/Header';
import BottomNav from '../components/common/BottomNav';
import Toast from '../components/common/Toast';
import Modal from '../components/common/Modal';
import RealtimeToast from '../components/common/RealtimeToast';
import WorkerGreeting from '../components/worker/WorkerGreeting';
import TaskList from '../components/worker/TaskList';
import LoadingSpinner from '../components/common/LoadingSpinner';
import ErrorState from '../components/common/ErrorState';
import SearchBar from '../components/common/SearchBar';
import { getOrders, getOrder } from '../api/orders';
import { startProcess, completeProcess } from '../api/processes';
import { reportIssue as reportIssueApi } from '../api/issues';
import { uploadPhoto } from '../api/photos';
import { getStats } from '../api/stats';
import useApi from '../hooks/useApi';
import useWebSocket from '../hooks/useWebSocket';
import { formatDueStatus } from '../utils/dateUtils';
import { PROCESS_STEPS, WORKER_STORAGE_KEY, DEPARTMENT_STORAGE_KEY, DEPARTMENT_STEP_MAP } from '../constants';

function mapOrderToTask(order) {
  const processes = order.processes || [];
  const completedCount = processes.filter((p) => p.status === 'completed').length;
  const inProgressProcess = processes.find((p) => p.status === 'in_progress');
  const currentStepIndex = inProgressProcess
    ? PROCESS_STEPS.indexOf(inProgressProcess.step_name)
    : completedCount;

  const isAllCompleted = completedCount === processes.length && processes.length > 0;
  const isInProgress = !!inProgressProcess;
  const isBlocked = !isInProgress && !isAllCompleted && completedCount < currentStepIndex;

  let status = 'waiting';
  let statusLabel = '대기';
  if (isAllCompleted) {
    status = 'done';
    statusLabel = '완료';
  } else if (isInProgress) {
    status = 'progress';
    statusLabel = `${inProgressProcess.step_name} 진행중`;
  } else {
    statusLabel = `${PROCESS_STEPS[currentStepIndex] || '대기'} 대기`;
  }

  // Find the active process id (in_progress or next waiting)
  const activeProcess = inProgressProcess ||
    processes.find((p) => p.status === 'waiting');

  return {
    id: order.id,
    orderId: order.id,
    processId: activeProcess?.id || null,
    orderNumber: order.order_number,
    status,
    statusLabel,
    product: order.product_name,
    productType: order.product_type || null,
    doorType: order.door_type || null,
    width: order.width || null,
    depth: order.depth || null,
    height: order.height || null,
    color: order.color || null,
    quantity: order.quantity || null,
    client: `${order.client_name}${order.client_store ? ' ' + order.client_store : ''}`,
    salesRep: order.sales_person || '-',
    currentStep: currentStepIndex,
    completedSteps: completedCount,
    isActive: isInProgress,
    isBlocked: !isInProgress && !isAllCompleted && currentStepIndex > completedCount,
    isCompleted: isAllCompleted,
    dueDate: order.due_date,
    dueStatus: formatDueStatus(order.due_date, order.status),
    processes,
  };
}

export default function WorkerPage() {
  const navigate = useNavigate();
  const workerName = sessionStorage.getItem(WORKER_STORAGE_KEY);

  useEffect(() => {
    if (!workerName) {
      navigate('/worker/select', { state: { redirectTo: '/worker' }, replace: true });
    }
  }, [workerName, navigate]);

  const department = sessionStorage.getItem(DEPARTMENT_STORAGE_KEY);
  const departmentStep = department ? DEPARTMENT_STEP_MAP[department] : null;
  const WORKER_NAME = workerName || '작업자';
  const { lastMessage, isConnected } = useWebSocket();

  const { data: ordersRaw, loading: ordersLoading, error: ordersError, execute: fetchOrders } = useApi(
    async () => {
      const res = await getOrders({ status: 'in_production', limit: 20 });
      const orders = Array.isArray(res) ? res : (res.orders || []);
      const detailed = await Promise.all(
        orders.slice(0, 20).map(async (o) => {
          try {
            return await getOrder(o.id);
          } catch {
            return { ...o, processes: [] };
          }
        })
      );
      return detailed;
    }
  );

  const { data: statsData, execute: fetchStats } = useApi(getStats);

  const allTasks = (ordersRaw || []).map(mapOrderToTask);

  // 부서가 선택되어 있으면 해당 부서 공정에 관련된 작업만 필터링
  const tasks = departmentStep
    ? allTasks.filter((task) => {
        const proc = task.processes.find((p) => p.step_name === departmentStep);
        // 해당 공정이 대기 또는 진행중인 주문만 표시
        return proc && (proc.status === 'waiting' || proc.status === 'in_progress');
      })
    : allTasks;

  const [toast, setToast] = useState({ visible: false, message: '' });
  const [modal, setModal] = useState({ visible: false, type: null, taskId: null });
  const [navIndex, setNavIndex] = useState(0);
  const [actionLoading, setActionLoading] = useState(false);

  const stats = statsData
    ? {
        waiting: statsData.waiting,
        inProgress: statsData.in_progress,
        completed: statsData.completed_today,
      }
    : {
        waiting: tasks.filter((t) => t.status === 'waiting' && !t.isBlocked).length,
        inProgress: tasks.filter((t) => t.status === 'progress').length,
        completed: tasks.filter((t) => t.isCompleted).length,
      };

  // Auto-refresh on real-time events
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!lastMessage) return;
    const { type } = lastMessage;
    if (type === 'PROCESS_STARTED' || type === 'PROCESS_COMPLETED' || type === 'ISSUE_REPORTED') {
      fetchOrders().catch(() => {});
      fetchStats().catch(() => {});
    }
  }, [lastMessage]);

  const showToast = useCallback((message) => {
    setToast({ visible: true, message });
  }, []);

  const hideToast = useCallback(() => {
    setToast({ visible: false, message: '' });
  }, []);

  const handleChangeWorker = useCallback(() => {
    sessionStorage.removeItem(WORKER_STORAGE_KEY);
    sessionStorage.removeItem(DEPARTMENT_STORAGE_KEY);
    navigate('/worker/select', { state: { redirectTo: '/worker' } });
  }, [navigate]);

  const handleStart = (taskId) => {
    setModal({ visible: true, type: 'start', taskId });
  };

  const handleComplete = (taskId) => {
    setModal({ visible: true, type: 'complete', taskId });
  };

  const handlePhoto = async (taskId) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    // TODO: uploadPhoto requires multipart FormData with a 'photo' file field.
    // Without an actual file (e.g., from camera/file picker), we cannot upload.
    console.warn('사진 첨부: 실제 파일 선택 기능이 구현되지 않아 업로드를 건너뜁니다.', {
      order_id: task.orderId,
      process_id: task.processId,
    });
    showToast('사진 첨부 기능은 준비 중입니다');
  };

  const handleIssue = (taskId) => {
    setModal({ visible: true, type: 'issue', taskId });
  };

  const closeModal = () => {
    setModal({ visible: false, type: null, taskId: null });
  };

  const confirmStart = async () => {
    const taskId = modal.taskId;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const waitingProcess = task.processes.find((p) => p.status === 'waiting');
    if (!waitingProcess) {
      showToast('시작할 수 있는 공정이 없습니다');
      closeModal();
      return;
    }

    setActionLoading(true);
    try {
      await startProcess(waitingProcess.id, {
        assigned_worker: WORKER_NAME,
        assigned_team: department || '미지정',
        actor: WORKER_NAME,
      });
      await fetchOrders();
      await fetchStats();
      closeModal();
      showToast('공정이 시작되었습니다');
    } catch (err) {
      showToast(`공정 시작 실패: ${err.message}`);
      closeModal();
    } finally {
      setActionLoading(false);
    }
  };

  const confirmComplete = async () => {
    const taskId = modal.taskId;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    const inProgressProcess = task.processes.find((p) => p.status === 'in_progress');
    if (!inProgressProcess) {
      showToast('완료할 수 있는 공정이 없습니다');
      closeModal();
      return;
    }

    setActionLoading(true);
    try {
      await completeProcess(inProgressProcess.id, { actor: WORKER_NAME });
      await fetchOrders();
      await fetchStats();
      closeModal();
      showToast('공정 완료! 다음 공정팀에 알림 전송됨');
    } catch (err) {
      showToast(`공정 완료 실패: ${err.message}`);
      closeModal();
    } finally {
      setActionLoading(false);
    }
  };

  const reportIssue = async (issueType) => {
    const taskId = modal.taskId;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    setActionLoading(true);
    try {
      await reportIssueApi({
        order_id: task.orderId,
        process_id: task.processId,
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
    const { type, taskId } = modal;
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return null;

    if (type === 'start') {
      return (
        <>
          <div className="modal-icon">▶️</div>
          <div className="modal-title">공정 시작</div>
          <div className="modal-desc">
            {task.product}<br />
            공정을 시작할까요?<br />
            <small style={{ color: 'var(--text-dim)' }}>시작 시간이 자동 기록됩니다</small>
          </div>
          <div className="modal-btns">
            <button className="modal-btn modal-btn-cancel" onClick={closeModal} disabled={actionLoading}>취소</button>
            <button className="modal-btn modal-btn-confirm" onClick={confirmStart} disabled={actionLoading}>
              {actionLoading ? '처리중...' : '시작하기'}
            </button>
          </div>
        </>
      );
    }

    if (type === 'complete') {
      return (
        <>
          <div className="modal-icon">✅</div>
          <div className="modal-title">공정 완료</div>
          <div className="modal-desc">
            {task.product}<br />
            공정을 완료 처리할까요?<br />
            <small style={{ color: 'var(--text-dim)' }}>다음 공정팀에 자동 알림됩니다</small>
          </div>
          <div className="modal-btns">
            <button className="modal-btn modal-btn-cancel" onClick={closeModal} disabled={actionLoading}>취소</button>
            <button className="modal-btn modal-btn-confirm green" onClick={confirmComplete} disabled={actionLoading}>
              {actionLoading ? '처리중...' : '완료하기'}
            </button>
          </div>
        </>
      );
    }

    if (type === 'issue') {
      return (
        <>
          <div className="modal-icon">⚠️</div>
          <div className="modal-title">이슈 보고</div>
          <div className="modal-desc">어떤 문제가 발생했나요?</div>
          <div className="issue-options">
            <button
              className="issue-btn"
              style={{ background: 'var(--orange-light)', color: 'var(--orange)' }}
              onClick={() => reportIssue('자재부족')}
              disabled={actionLoading}
            >
              자재 부족/지연
            </button>
            <button
              className="issue-btn"
              style={{ background: 'var(--red-light)', color: 'var(--red)' }}
              onClick={() => reportIssue('불량발생')}
              disabled={actionLoading}
            >
              불량 발생
            </button>
            <button
              className="issue-btn"
              style={{ background: 'var(--purple-light)', color: 'var(--purple)' }}
              onClick={() => reportIssue('설비고장')}
              disabled={actionLoading}
            >
              설비 고장
            </button>
            <button
              className="issue-btn"
              style={{ background: 'var(--surface2)', color: 'var(--text-mid)' }}
              onClick={() => reportIssue('기타')}
              disabled={actionLoading}
            >
              기타 (메모 입력)
            </button>
          </div>
          <button className="modal-btn modal-btn-cancel" style={{ width: '100%' }} onClick={closeModal} disabled={actionLoading}>
            취소
          </button>
        </>
      );
    }

    return null;
  };

  if (ordersLoading) {
    return (
      <div className="app-container">
        <Header subtitle="생산현황 관리" profileEmoji="👷" wsConnected={isConnected} workerName={WORKER_NAME} onChangeWorker={handleChangeWorker} />
        <div className="app-content">
          <LoadingSpinner message="작업 목록을 불러오는 중..." />
        </div>
        <BottomNav activeIndex={0} onSelect={() => {}} mode="worker" />
      </div>
    );
  }

  if (ordersError) {
    return (
      <div className="app-container">
        <Header subtitle="생산현황 관리" profileEmoji="👷" wsConnected={isConnected} workerName={WORKER_NAME} onChangeWorker={handleChangeWorker} />
        <div className="app-content">
          <ErrorState message={ordersError} onRetry={() => fetchOrders()} />
        </div>
        <BottomNav activeIndex={0} onSelect={() => {}} mode="worker" />
      </div>
    );
  }

  return (
    <div className="app-container">
      <Header subtitle="생산현황 관리" profileEmoji="&#x1F477;" wsConnected={isConnected} onBack={() => navigate('/')} workerName={WORKER_NAME} onChangeWorker={handleChangeWorker} />
      <div className="app-content">
        <SearchBar
          placeholder="거래처·제품·담당자 검색"
          onSelect={(order) => navigate(`/worker/update/${order.id}`)}
        />
        <WorkerGreeting workerName={WORKER_NAME} stats={stats} />
        <TaskList
          tasks={tasks}
          onStart={handleStart}
          onComplete={handleComplete}
          onPhoto={handlePhoto}
          onIssue={handleIssue}
          teamName={department || '전체'}
        />
        <div style={{ height: 20 }} />
      </div>
      <BottomNav activeIndex={navIndex} onSelect={setNavIndex} mode="worker" />
      <Toast message={toast.message} visible={toast.visible} onHide={hideToast} />
      <RealtimeToast event={lastMessage} />
      <Modal visible={modal.visible} onClose={closeModal}>
        {renderModalContent()}
      </Modal>
    </div>
  );
}
