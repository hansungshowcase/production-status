import { useState, useEffect, useCallback, useRef } from 'react';
import OrderListPanel from '../components/tablet/OrderListPanel';
import OrderDetailPanel from '../components/tablet/OrderDetailPanel';
import { getOrders } from '../api/orders';
import { startProcess, completeProcess } from '../api/processes';
import '../../src/styles/tablet.css';
import './TabletWorkerPage.css';

const REFRESH_INTERVAL = 5000; // 5 seconds

export default function TabletWorkerPage() {
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [toast, setToast] = useState(null); // {message, type} | null
  const timerRef = useRef(null);
  const toastTimerRef = useRef(null);

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  const fetchOrderList = useCallback(async () => {
    try {
      const data = await getOrders();
      const list = Array.isArray(data) ? data : (data.orders || []);
      // Filter to active orders (not shipped)
      const active = list.filter(
        (o) => o.status !== '출고완료'
      );
      setOrders(active);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    fetchOrderList();
    timerRef.current = setInterval(fetchOrderList, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchOrderList]);

  const selectedOrder = orders.find((o) => o.id === selectedId) || null;

  async function handleStartProcess(processId) {
    try {
      await startProcess(processId, { assigned_worker: '현장작업자', actor: '현장작업자' });
      await fetchOrderList();
    } catch (err) {
      console.error('Process start failed:', err);
      showToast('공정 시작에 실패했습니다.', 'error');
    }
  }

  async function handleCompleteProcess(processId) {
    try {
      await completeProcess(processId, { actor: '현장작업자' });
      await fetchOrderList();
    } catch (err) {
      console.error('Process complete failed:', err);
      showToast('공정 완료에 실패했습니다.', 'error');
    }
  }

  function handlePhotoAttach(orderId) {
    showToast('사진 첨부 기능은 준비 중입니다.', 'info');
  }

  function handleIssueReport(orderId) {
    showToast('이슈 보고 기능은 준비 중입니다.', 'info');
  }

  if (loading) {
    return <div className="tablet-loading">주문 데이터를 불러오는 중...</div>;
  }

  return (
    <div className="tablet-page tablet-worker-page">
      {/* Toast (alert 대체 — 흐름 안 끊김) */}
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)',
            zIndex: 9999, padding: '12px 22px', borderRadius: 12,
            background: toast.type === 'error' ? '#dc2626' : '#0369a1',
            color: 'white', fontSize: 16, fontWeight: 600,
            boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Landscape hint for portrait mode */}
      <div className="tablet-landscape-hint">
        <div className="tablet-landscape-hint-icon">📱↔️</div>
        <div>태블릿을 가로로 돌려주세요</div>
      </div>

      {/* Left panel: order list */}
      <div className="tablet-worker-left">
        <div className="tablet-refresh-bar">
          <span>
            <span className="tablet-refresh-dot" />
            {lastRefresh
              ? `${lastRefresh.getHours().toString().padStart(2, '0')}:${lastRefresh.getMinutes().toString().padStart(2, '0')} 갱신`
              : '로딩 중...'}
          </span>
          <button className="tablet-refresh-btn" onClick={fetchOrderList}>
            새로고침
          </button>
        </div>
        <OrderListPanel
          orders={orders}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {/* Right panel: order detail */}
      <div className="tablet-worker-right">
        <OrderDetailPanel
          order={selectedOrder}
          onStartProcess={handleStartProcess}
          onCompleteProcess={handleCompleteProcess}
          onPhotoAttach={handlePhotoAttach}
          onIssueReport={handleIssueReport}
        />
      </div>
    </div>
  );
}
