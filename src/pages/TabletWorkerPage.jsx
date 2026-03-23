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
  const timerRef = useRef(null);

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
      alert('공정 시작에 실패했습니다.');
    }
  }

  async function handleCompleteProcess(processId) {
    try {
      await completeProcess(processId, { actor: '현장작업자' });
      await fetchOrderList();
    } catch (err) {
      console.error('Process complete failed:', err);
      alert('공정 완료에 실패했습니다.');
    }
  }

  function handlePhotoAttach(orderId) {
    // Placeholder: In production, open camera/file picker
    alert('사진 첨부 기능은 준비 중입니다.');
  }

  function handleIssueReport(orderId) {
    // Placeholder: In production, open issue report form
    alert('이슈 보고 기능은 준비 중입니다.');
  }

  if (loading) {
    return <div className="tablet-loading">주문 데이터를 불러오는 중...</div>;
  }

  return (
    <div className="tablet-page tablet-worker-page">
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
