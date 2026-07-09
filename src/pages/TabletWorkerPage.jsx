import { useState, useEffect, useCallback, useRef } from 'react';
import OrderListPanel from '../components/tablet/OrderListPanel';
import OrderDetailPanel from '../components/tablet/OrderDetailPanel';
import { getOrder, getOrders } from '../api/orders';
import { startProcess, completeProcess } from '../api/processes';
import { uploadPhoto } from '../api/photos';
import { reportIssue } from '../api/issues';
import { WORKER_STORAGE_KEY } from '../constants';
import '../../src/styles/tablet.css';
import './TabletWorkerPage.css';

const ISSUE_TYPES = [
  { value: '자재부족', label: '자재 부족' },
  { value: '불량발생', label: '불량 발생' },
  { value: '설비고장', label: '설비 고장' },
  { value: '기타', label: '기타' },
];

const REFRESH_INTERVAL = 180000; // 3 minutes
const TABLET_ORDER_PAGE_SIZE = 200;

async function fetchAllActiveOrders() {
  const loaded = [];
  let offset = 0;
  let total = null;

  while (true) {
    const data = await getOrders({ status: 'in_production', limit: TABLET_ORDER_PAGE_SIZE, offset });
    const page = Array.isArray(data) ? data : (data.orders || []);
    loaded.push(...page);
    total = Array.isArray(data) ? loaded.length : Number(data.total ?? loaded.length);

    if (page.length === 0 || loaded.length >= total) {
      return loaded;
    }

    offset += page.length;
  }
}

export default function TabletWorkerPage() {
  const [orders, setOrders] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [toast, setToast] = useState(null); // {message, type} | null
  const [issueModal, setIssueModal] = useState(null); // { orderId } | null
  const [issueType, setIssueType] = useState('자재부족');
  const [issueDesc, setIssueDesc] = useState('');
  const [issueSaving, setIssueSaving] = useState(false);
  const [photoUploadOrderId, setPhotoUploadOrderId] = useState(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const fileInputRef = useRef(null);
  const timerRef = useRef(null);
  const toastTimerRef = useRef(null);

  const workerName = (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(WORKER_STORAGE_KEY)) || '현장작업자';

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
      const list = await fetchAllActiveOrders();
      // Filter to active orders (not shipped)
      const active = list.filter(
        (o) => o.status !== '출고완료'
      );
      setOrders(active.filter((o) => o.status !== 'shipped' && o.status !== '출고완료'));
      setLastRefresh(new Date());
    } catch (err) {
      console.error('Failed to fetch orders:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const hydrateSelectedOrder = useCallback(async (orderId) => {
    if (!orderId) return;
    try {
      const detail = await getOrder(orderId);
      setOrders(prev => prev.map(order => order.id === orderId ? { ...order, ...detail } : order));
    } catch (err) {
      console.error('Failed to fetch selected order detail:', err);
    }
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    fetchOrderList();
    timerRef.current = setInterval(fetchOrderList, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchOrderList]);

  useEffect(() => {
    hydrateSelectedOrder(selectedId);
  }, [selectedId, hydrateSelectedOrder]);

  const selectedOrder = orders.find((o) => o.id === selectedId) || null;

  async function handleStartProcess(processId) {
    try {
      await startProcess(processId, { assigned_worker: '현장작업자', actor: '현장작업자' });
      await fetchOrderList();
      await hydrateSelectedOrder(selectedId);
    } catch (err) {
      console.error('Process start failed:', err);
      showToast('공정 시작에 실패했습니다.', 'error');
    }
  }

  async function handleCompleteProcess(processId) {
    try {
      await completeProcess(processId, { actor: '현장작업자' });
      await fetchOrderList();
      await hydrateSelectedOrder(selectedId);
    } catch (err) {
      console.error('Process complete failed:', err);
      showToast('공정 완료에 실패했습니다.', 'error');
    }
  }

  function handlePhotoAttach(orderId) {
    if (photoUploading) return;
    setPhotoUploadOrderId(orderId);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }

  async function onPhotoFileSelected(e) {
    const file = e.target.files?.[0];
    if (!file || !photoUploadOrderId) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('파일 크기는 10MB 이하여야 합니다.', 'error');
      return;
    }
    setPhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append('photo', file);
      fd.append('order_id', String(photoUploadOrderId));
      fd.append('uploaded_by', workerName);
      await uploadPhoto(fd);
      showToast('사진이 업로드되었습니다.', 'info');
      await fetchOrderList();
    } catch (err) {
      console.error('Photo upload failed:', err);
      showToast('사진 업로드에 실패했습니다.', 'error');
    } finally {
      setPhotoUploading(false);
      setPhotoUploadOrderId(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleIssueReport(orderId) {
    setIssueType('자재부족');
    setIssueDesc('');
    setIssueModal({ orderId });
  }

  async function submitIssue() {
    if (!issueModal || issueSaving) return;
    if (!issueDesc.trim()) {
      showToast('이슈 설명을 입력하세요.', 'error');
      return;
    }
    setIssueSaving(true);
    try {
      await reportIssue({
        order_id: issueModal.orderId,
        issue_type: issueType,
        description: issueDesc.trim(),
        reported_by: workerName,
      });
      showToast('이슈가 등록되었습니다.', 'info');
      setIssueModal(null);
      await fetchOrderList();
    } catch (err) {
      console.error('Issue report failed:', err);
      showToast('이슈 등록에 실패했습니다.', 'error');
    } finally {
      setIssueSaving(false);
    }
  }

  if (loading) {
    return <div className="tablet-loading">주문 데이터를 불러오는 중...</div>;
  }

  return (
    <div className="tablet-page tablet-worker-page">
      {/* 사진 업로드용 hidden input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: 'none' }}
        onChange={onPhotoFileSelected}
      />

      {/* 업로드 중 오버레이 */}
      {photoUploading && (
        <div className="tablet-overlay">
          <div className="tablet-overlay__card">
            <div className="tablet-overlay__spinner" />
            <div>사진 업로드 중...</div>
          </div>
        </div>
      )}

      {/* 이슈 보고 모달 */}
      {issueModal && (
        <div className="tablet-modal__overlay" onClick={(e) => { if (e.target === e.currentTarget && !issueSaving) setIssueModal(null); }}>
          <div className="tablet-modal__panel">
            <div className="tablet-modal__title">이슈 보고</div>
            <div className="tablet-modal__field">
              <label className="tablet-modal__label">유형</label>
              <div className="tablet-modal__chip-row">
                {ISSUE_TYPES.map(t => (
                  <button
                    key={t.value}
                    type="button"
                    className={`tablet-modal__chip${issueType === t.value ? ' tablet-modal__chip--active' : ''}`}
                    onClick={() => setIssueType(t.value)}
                    disabled={issueSaving}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="tablet-modal__field">
              <label className="tablet-modal__label">설명</label>
              <textarea
                className="tablet-modal__textarea"
                rows={4}
                value={issueDesc}
                onChange={(e) => setIssueDesc(e.target.value)}
                placeholder="이슈 내용을 입력하세요"
                disabled={issueSaving}
              />
            </div>
            <div className="tablet-modal__footer">
              <button className="tablet-modal__btn tablet-modal__btn--cancel" onClick={() => setIssueModal(null)} disabled={issueSaving}>취소</button>
              <button className="tablet-modal__btn tablet-modal__btn--submit" onClick={submitIssue} disabled={issueSaving}>
                {issueSaving ? '등록 중...' : '이슈 등록'}
              </button>
            </div>
          </div>
        </div>
      )}

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
