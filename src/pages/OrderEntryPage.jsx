import React, { useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import OrderForm from '../components/order/OrderForm';
import Toast from '../components/common/Toast';
import { createOrder } from '../api/orders';
import { startProcess } from '../api/processes';
import request from '../api/client';
import './OrderEntryPage.css';

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

const INITIAL_FORM = {
  order_date: todayStr(),
  due_date: '',
  sales_person: '',
  client_name: '',
  phone: '',
  product_type: '',
  door_type: '',
  width: '',
  depth: '',
  height: '',
  quantity: '',
  color: '',
  sale_amount: '',
  lead_source: '',
  notes: '',
};

export default function OrderEntryPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '' });
  const [showSuccess, setShowSuccess] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null); // { data, imageUrl }
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const validate = useCallback(() => {
    const newErrors = {};
    if (!form.client_name || !form.client_name.trim()) {
      newErrors.client_name = '거래처를 입력해주세요';
    }
    if (!form.product_type || !form.product_type.trim()) {
      newErrors.product_type = '사양을 선택해주세요';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [form]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    try {
      const payload = {
        order_date: form.order_date || todayStr(),
        due_date: form.due_date || null,
        sales_person: form.sales_person || null,
        client_name: form.client_name.trim(),
        phone: form.phone || null,
        product_type: form.product_type.trim(),
        door_type: form.door_type || null,
        width: form.width ? Number(form.width) : null,
        depth: form.depth ? Number(form.depth) : null,
        height: form.height ? Number(form.height) : null,
        quantity: form.quantity ? Number(form.quantity) : null,
        color: form.color || null,
        sale_amount: form.sale_amount ? Number(form.sale_amount) : null,
        lead_source: form.lead_source || null,
        notes: form.notes || null,
      };

      const created = await createOrder(payload);
      // 첫 번째 공정(도면설계) 자동 시작
      const processes = created.processes || [];
      const firstProcess = processes.find(p => p.step_name === '도면설계');
      if (firstProcess) {
        try {
          await startProcess(firstProcess.id, {
            assigned_worker: payload.sales_person || '시스템',
            assigned_team: '도면설계',
            actor: payload.sales_person || '시스템',
          });
        } catch (e) {
          console.warn('도면설계 자동시작 실패:', e);
        }
      }
      setShowSuccess(true);
      setToast({ visible: true, message: '작업이 등록되었습니다 (도면설계 자동시작)' });
    } catch (err) {
      setToast({ visible: true, message: err.message || '작업 등록에 실패했습니다' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleContinue = () => {
    setForm({ ...INITIAL_FORM, order_date: todayStr() });
    setErrors({});
    setShowSuccess(false);
  };

  const handleGoList = () => {
    navigate('/sales');
  };

  // ── OCR 사진 인식 ──
  const processOcrFile = async (file) => {
    if (!file) return;
    const imageUrl = URL.createObjectURL(file);
    setOcrLoading(true);
    setToast({ visible: true, message: '작업지시서를 인식하는 중...' });

    try {
      const formData = new FormData();
      formData.append('image', file);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch('/api/ocr/work-order', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || '인식 실패');
      }

      const { data } = await res.json();
      setOcrResult({ data, imageUrl });
      setToast({ visible: true, message: '인식 완료! 결과를 확인해주세요.' });
    } catch (err) {
      setToast({ visible: true, message: err.message || '이미지 인식에 실패했습니다' });
    } finally {
      setOcrLoading(false);
    }
  };

  const handleOcrUpload = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    processOcrFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      processOcrFile(file);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleOcrConfirm = () => {
    if (!ocrResult) return;
    const d = ocrResult.data;
    setForm((prev) => ({
      ...prev,
      client_name: d.client_name || prev.client_name,
      order_date: d.order_date || prev.order_date,
      due_date: d.due_date || prev.due_date,
      phone: d.phone || prev.phone,
      sales_person: d.sales_person || prev.sales_person,
      product_type: d.product_type || prev.product_type,
      door_type: d.door_type || prev.door_type,
      width: d.width || prev.width,
      depth: d.depth || prev.depth,
      height: d.height || prev.height,
      quantity: d.quantity || prev.quantity,
      color: d.color || prev.color,
      notes: d.notes || prev.notes,
    }));
    if (ocrResult.imageUrl) URL.revokeObjectURL(ocrResult.imageUrl);
    setOcrResult(null);
    setToast({ visible: true, message: '인식 결과가 입력되었습니다' });
  };

  const handleOcrEdit = (field, value) => {
    setOcrResult((prev) => ({
      ...prev,
      data: { ...prev.data, [field]: value },
    }));
  };

  const handleOcrCancel = () => {
    if (ocrResult?.imageUrl) URL.revokeObjectURL(ocrResult.imageUrl);
    setOcrResult(null);
  };

  const handleFormChange = (newForm) => {
    setForm(newForm);
    if (errors.client_name && newForm.client_name) {
      setErrors((prev) => ({ ...prev, client_name: undefined }));
    }
    if (errors.product_type && newForm.product_type) {
      setErrors((prev) => ({ ...prev, product_type: undefined }));
    }
  };

  return (
    <div className="order-entry">
      {/* Hero header */}
      <header className="order-entry__hero">
        <div className="order-entry__hero-bg" />
        <div className="order-entry__hero-content">
          <button
            className="order-entry__home"
            onClick={() => navigate('/')}
            aria-label="홈으로"
          >
            🏠
          </button>
          <button
            className="order-entry__back"
            onClick={() => navigate(-1)}
            aria-label="뒤로가기"
          >
            &#8592;
          </button>
          <div className="order-entry__hero-text">
            <div className="order-entry__hero-badge">NEW</div>
            <h1 className="order-entry__hero-title">작업 등록</h1>
            <p className="order-entry__hero-desc">새로운 제작 발주를 등록합니다</p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleOcrUpload}
            style={{ display: 'none' }}
          />
        </div>
        <div className="order-entry__hero-wave">
          <svg viewBox="0 0 1440 60" preserveAspectRatio="none">
            <path d="M0,60 L0,20 Q360,0 720,20 Q1080,40 1440,20 L1440,60 Z" fill="var(--bg, #f0f4ff)" />
          </svg>
        </div>
      </header>

      <main className="order-entry__body">
        {/* 드래그 앤 드롭 영역 */}
        {!showSuccess && (
          <div
            className={`order-entry__dropzone${dragOver ? ' order-entry__dropzone--active' : ''}${ocrLoading ? ' order-entry__dropzone--loading' : ''}`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => !ocrLoading && fileInputRef.current?.click()}
          >
            {ocrLoading ? (
              <>
                <span className="order-entry__spinner order-entry__spinner--large" />
                <span className="order-entry__dropzone-text">작업지시서를 인식하는 중...</span>
              </>
            ) : (
              <>
                <span className="order-entry__dropzone-icon">📷</span>
                <span className="order-entry__dropzone-text">
                  작업지시서 사진을 여기에 드래그하거나 클릭하여 업로드
                </span>
                <span className="order-entry__dropzone-hint">
                  사진을 인식하여 자동으로 입력합니다
                </span>
              </>
            )}
          </div>
        )}

        {showSuccess ? (
          <div className="order-entry__success">
            <div className="order-entry__success-ring">
              <div className="order-entry__success-icon">&#10003;</div>
            </div>
            <h2 className="order-entry__success-title">작업이 등록되었습니다!</h2>
            <p className="order-entry__success-desc">
              {form.client_name} &mdash; {form.product_type}
            </p>
            <div className="order-entry__success-actions">
              <button
                className="order-entry__btn order-entry__btn--outline"
                onClick={handleContinue}
              >
                연속 등록
              </button>
              <button
                className="order-entry__btn order-entry__btn--primary"
                onClick={handleGoList}
              >
                목록으로
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate className="order-entry__form">
            <OrderForm
              form={form}
              errors={errors}
              onChange={handleFormChange}
            />
            <div className="order-entry__submit-wrap">
              <button
                type="submit"
                className="order-entry__submit"
                disabled={submitting}
              >
                {submitting ? (
                  <span className="order-entry__submit-loading">
                    <span className="order-entry__spinner" />
                    등록 중...
                  </span>
                ) : (
                  <>작업 등록</>
                )}
              </button>
            </div>
          </form>
        )}
      </main>

      {/* ── OCR 결과 확인 모달 ── */}
      {ocrResult && (
        <div className="ocr-confirm-overlay" onClick={handleOcrCancel}>
          <div className="ocr-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="ocr-confirm__header">
              <h2 className="ocr-confirm__title">📷 인식 결과 확인</h2>
              <p className="ocr-confirm__desc">인식된 정보를 확인하고 수정하세요</p>
            </div>

            {ocrResult.imageUrl && (
              <div className="ocr-confirm__image-wrap">
                <img src={ocrResult.imageUrl} alt="작업지시서" className="ocr-confirm__image" />
              </div>
            )}

            <div className="ocr-confirm__fields">
              {[
                { key: 'client_name', label: '거래처' },
                { key: 'order_date', label: '발주일', type: 'date' },
                { key: 'due_date', label: '납기일', type: 'date' },
                { key: 'phone', label: '연락처' },
                { key: 'sales_person', label: '담당자', dropdown: ['신은철', '이시아'] },
                { key: 'product_type', label: '품명/사양', dropdown: ['제과', '정육', '반찬', '꽃', '와인', '오픈', '진열', '마카롱', '샌드위치', '음료', '밧트', '토핑', '양념육', '유럽형', '주류'] },
                { key: 'door_type', label: '문짝/디자인', dropdown: ['앞문', '뒷문', '양문', '여닫이', '오픈', '라운드앞문', '라운드뒷문', '평대'] },
                { key: 'width', label: '가로(mm)', type: 'number' },
                { key: 'depth', label: '세로(mm)', type: 'number' },
                { key: 'height', label: '높이(mm)', type: 'number' },
                { key: 'quantity', label: '수량', type: 'number' },
                { key: 'color', label: '색상', dropdown: ['화이트', '올백색', '올스텐', '올검정', '블랙', '골드스텐', '골드미러'] },
                { key: 'notes', label: '비고', textarea: true },
              ].map(({ key, label, type, dropdown, textarea }) => (
                <div key={key} className="ocr-confirm__field">
                  <span className="ocr-confirm__label">{label}</span>
                  {dropdown ? (
                    <select
                      className="ocr-confirm__input ocr-confirm__select"
                      value={ocrResult.data[key] || ''}
                      onChange={(e) => handleOcrEdit(key, e.target.value)}
                    >
                      <option value="">선택</option>
                      {dropdown.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                      {ocrResult.data[key] && !dropdown.includes(ocrResult.data[key]) && (
                        <option value={ocrResult.data[key]}>{ocrResult.data[key]} (인식값)</option>
                      )}
                    </select>
                  ) : textarea ? (
                    <textarea
                      className="ocr-confirm__input ocr-confirm__textarea"
                      value={ocrResult.data[key] || ''}
                      onChange={(e) => handleOcrEdit(key, e.target.value)}
                      rows={2}
                    />
                  ) : (
                    <input
                      type={type || 'text'}
                      className="ocr-confirm__input"
                      value={ocrResult.data[key] || ''}
                      onChange={(e) => handleOcrEdit(key, type === 'number' ? Number(e.target.value) || '' : e.target.value)}
                    />
                  )}
                </div>
              ))}
            </div>

            <div className="ocr-confirm__actions">
              <button className="ocr-confirm__btn ocr-confirm__btn--cancel" onClick={handleOcrCancel}>
                취소
              </button>
              <button className="ocr-confirm__btn ocr-confirm__btn--confirm" onClick={handleOcrConfirm}>
                확인 후 입력
              </button>
            </div>
          </div>
        </div>
      )}

      <Toast
        message={toast.message}
        visible={toast.visible}
        onHide={() => setToast({ visible: false, message: '' })}
      />
    </div>
  );
}
