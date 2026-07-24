import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import OrderForm from '../components/order/OrderForm';
import Toast from '../components/common/Toast';
import { createOrder } from '../api/orders';
import { startProcess } from '../api/processes';
import { uploadWorkOrderImage } from '../api/workOrderImages';
import { clearToken, getToken } from '../utils/authClient';
import { extractDueDateFromText } from '../utils/dateUtils';
import { extractBrowserOcrEssentialFields } from './browserOcrEssentialFields';
import { buildOrderPayload, validateOrderEntryForm } from './orderEntryPayload';
import {
  COLOR_OPTIONS,
  DOOR_TYPE_OPTIONS,
  OCR_CONFIRMATION_FIELD_DEFINITIONS,
  PRODUCT_TYPE_OPTIONS,
  getOcrConfirmationValidation,
} from './ocrConfirmationValidation';
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
  delivery_address: '',
  freight_payment: '',
  product_type: '',
  door_type: '',
  width: '',
  depth: '',
  height: '',
  quantity: '',
  color: '',
  sale_amount: '',
  balance: '',
  lead_source: '',
  notes: '',
};

const EMPTY_OCR_DATA = {
  client_name: '',
  order_date: '',
  due_date: '',
  phone: '',
  delivery_address: '',
  freight_payment: '',
  sales_person: '',
  product_type: '',
  door_type: '',
  width: '',
  depth: '',
  height: '',
  quantity: '',
  color: '',
  notes: '',
};

const CURRENT_YEAR = new Date().getFullYear();

function normalizeOcrText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[|｜]/g, ' ')
    .replace(/[：]/g, ':')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractLabeledValue(text, labels) {
  const labelPattern = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const regex = new RegExp(`(?:${labelPattern})\\s*[:：]?\\s*([^\\n]+)`, 'i');
  const match = text.match(regex);
  if (!match) return '';
  return match[1]
    .replace(/\s{2,}.*/, '')
    .replace(/(?:발주일|주문일|납기|납품|연락처|전화|담당|제품|품명|문짝|색상|비고)\s*[:：]?.*$/i, '')
    .trim();
}

function normalizeDateValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/(?:(\d{2,4})\D+)?(\d{1,2})\D+(\d{1,2})/);
  if (!match) return '';

  let year = match[1] ? Number(match[1]) : CURRENT_YEAR;
  if (year < 100) year += 2000;
  if (year < CURRENT_YEAR - 1) year = CURRENT_YEAR;

  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractPhone(text) {
  const match = text.match(/(?:010|011|016|017|018|019|02|0\d{2})[-.\s]?\d{3,4}[-.\s]?\d{4}/);
  return match ? match[0].replace(/[^\d]/g, '').replace(/^(010|011|016|017|018|019)(\d{4})(\d{4})$/, '$1-$2-$3') : '';
}

function extractFirstNumber(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)?/);
  return match ? match[0] : '';
}

function extractQuantity(text) {
  const total = String(text || '').match(/총\s*(\d+)\s*대/);
  if (total) return total[1];
  const labeled = extractFirstNumber(extractLabeledValue(text, ['수량', '개수', 'Quantity', 'Qty', 'QTY']));
  if (labeled) return labeled;
  const match = String(text || '').match(/(?:Quantity|Quantit\w+|Qty|QTY|\bEA\b|\bea\b)\D{0,24}(\d+)/i);
  return match ? match[1] : '';
}

function extractSize(text) {
  const labeled = {
    width: extractFirstNumber(extractLabeledValue(text, ['가로', '폭'])),
    depth: extractFirstNumber(extractLabeledValue(text, ['세로', '깊이'])),
    height: extractFirstNumber(extractLabeledValue(text, ['높이'])),
  };
  const sizeLine = extractLabeledValue(text, ['사이즈', '규격', '크기', 'Size', 'Dimensions']);
  const sizeMatch = (sizeLine || text).match(/(\d{2,5})\s*(?:x|X|\*|×)\s*(\d{2,5})\s*(?:x|X|\*|×)\s*(\d{2,5})/);
  if (sizeMatch) {
    return {
      width: labeled.width || sizeMatch[1],
      depth: labeled.depth || sizeMatch[2],
      height: labeled.height || sizeMatch[3],
    };
  }
  return labeled;
}

function inferOption(text, options) {
  const normalized = String(text || '').replace(/\s/g, '');
  return options.find((option) => normalized.includes(option.replace(/\s/g, ''))) || '';
}

function parseBrowserOcrText(text) {
  const normalized = normalizeOcrText(text);
  const size = extractSize(normalized);
  const essentialFields = extractBrowserOcrEssentialFields(normalized);
  const dateMatches = Array.from(normalized.matchAll(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/g)).map((match) => match[0]);
  const orderDate = normalizeDateValue(extractLabeledValue(normalized, ['발주일', '주문일', '작성일', '등록일', 'Order Date', 'Order'])) || normalizeDateValue(dateMatches[0]);
  const dueDate = essentialFields.due_date
    || extractDueDateFromText(normalized)
    || normalizeDateValue(extractLabeledValue(normalized, ['납기일자', '납품일자', '출고일자', '납기일', '납품일', '출고일', '납기', '납품', 'Due Date', 'Due', 'Ship Date']))
    || normalizeDateValue(dateMatches[1]);
  const notes = extractLabeledValue(normalized, ['비고', '특이사항', '요청사항', '메모', 'Note', 'Notes', 'Memo']);

  return {
    client_name: extractLabeledValue(normalized, ['거래처', '발주처', '상호', '업체명', '고객명', '고객', 'Client', 'Customer', 'Company']),
    order_date: orderDate,
    due_date: dueDate,
    phone: extractPhone(normalized) || extractLabeledValue(normalized, ['연락처', '전화', '휴대폰', '핸드폰', 'Phone', 'Tel', 'Mobile']),
    delivery_address: extractLabeledValue(normalized, ['납품주소', '주소', '배송주소', 'Address', 'Delivery Address']),
    freight_payment: extractLabeledValue(normalized, ['운임여부', '운임', '배송비', 'Freight', 'Shipping Fee']),
    sales_person: essentialFields.sales_person,
    product_type: inferOption(normalized, PRODUCT_TYPE_OPTIONS) || extractLabeledValue(normalized, ['품명', '제품', '사양', '용도', 'Product', 'Item', 'Spec']),
    door_type: inferOption(normalized, DOOR_TYPE_OPTIONS) || extractLabeledValue(normalized, ['문짝', '디자인', '도어', 'Door', 'Design']),
    width: size.width,
    depth: size.depth,
    height: size.height,
    quantity: extractQuantity(normalized),
    color: inferOption(normalized, COLOR_OPTIONS) || extractLabeledValue(normalized, ['색상', '색깔', '컬러', 'Color', 'Colour']),
    notes: notes || '',
    raw_text: normalized,
  };
}

function stripInternalOcrFields(data) {
  const { raw_text: _rawText, ...publicData } = data || {};
  return publicData;
}

async function runBrowserOcr(file, onProgress) {
  const { createWorker } = await import('tesseract.js');
  let worker = null;
  const workerOptions = {
    logger: (message) => {
      if (message?.status === 'recognizing text' && typeof message.progress === 'number') {
        onProgress?.(Math.max(1, Math.min(99, Math.round(message.progress * 100))));
      }
    },
  };
  try {
    try {
      worker = await createWorker(['kor', 'eng'], 1, workerOptions);
    } catch (languageErr) {
      if (worker) await worker.terminate();
      worker = await createWorker('eng', 1, workerOptions);
    }
    const result = await worker.recognize(file);
    return parseBrowserOcrText(result?.data?.text || '');
  } finally {
    if (worker) await worker.terminate();
  }
}

export default function OrderEntryPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const initialSalesPerson = location.state?.salesPerson || '';
  const [form, setForm] = useState({ ...INITIAL_FORM, sales_person: initialSalesPerson });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState({ visible: false, message: '' });
  const [showSuccess, setShowSuccess] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrResult, setOcrResult] = useState(null); // { data, imageUrl }
  const [workOrderImageUrl, setWorkOrderImageUrl] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const validate = useCallback(() => {
    const newErrors = validateOrderEntryForm(form, Boolean(workOrderImageUrl));
    setErrors(newErrors);
    return newErrors;
  }, [form, workOrderImageUrl]);
  const ocrValidation = getOcrConfirmationValidation(ocrResult?.data);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const validationErrors = validate();
    const missingMessages = Object.values(validationErrors).filter(Boolean);
    if (missingMessages.length > 0) {
      setToast({ visible: true, message: `등록할 수 없습니다 — ${missingMessages.join('  ·  ')}` });
      return;
    }

    setSubmitting(true);
    let success = false;
    try {
      const payload = buildOrderPayload(form, workOrderImageUrl, todayStr());

      const created = await createOrder(payload);
      success = true;

      // 도면설계는 김보수 팀장 담당으로 시작한다. 발주 담당자는 작업자로 기록하지 않는다.
      const processes = created.processes || [];
      const firstProcess = processes.find(p => p.step_name === '도면설계');
      if (firstProcess) {
        startProcess(firstProcess.id, {
          assigned_worker: '김보수 팀장',
          assigned_team: '도면설계',
          actor: '김보수 팀장',
        }).catch(() => {});
      }
    } catch (err) {
      setToast({ visible: true, message: err.message || '작업 등록에 실패했습니다' });
      setSubmitting(false);
    }

    // 주문 생성 성공하면 무조건 도면설계로 이동
    if (success) {
      navigate('/worker/station/' + encodeURIComponent('도면설계'));
    }
  };

  const handleContinue = () => {
    setForm({ ...INITIAL_FORM, order_date: todayStr() });
    setErrors({});
    setWorkOrderImageUrl(null);
    setShowSuccess(false);
  };

  const handleGoList = () => {
    navigate('/sales');
  };

  // ── 이미지 리사이즈 (모바일 고해상도 대응, Vercel 4.5MB 제한) ──
  const resizeImage = (file, maxWidth = 1600) => {
    return new Promise((resolve) => {
      // 이미 작은 파일은 그대로
      if (file.size < 1024 * 1024) { resolve(file); return; }

      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = img.width > maxWidth ? maxWidth / img.width : 1;
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' })),
          'image/jpeg',
          0.85
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  };

  // ── OCR 사진 인식 ──
  const processOcrFile = async (file) => {
    if (!file) return;
    const imageUrl = URL.createObjectURL(file);
    let uploadedUrl = null;
    let resizedFile = null;
    setOcrLoading(true);
    setWorkOrderImageUrl(null);
    setToast({ visible: true, message: '작업지시서를 인식하는 중...' });

    try {
      const resized = await resizeImage(file);
      resizedFile = resized;
      const uploaded = await uploadWorkOrderImage(resized);
      uploadedUrl = uploaded.url;
      setWorkOrderImageUrl(uploaded.url);

      const formData = new FormData();
      formData.append('image', resized);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const token = getToken();
      const res = await fetch('/api/ocr/work-order', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        if (res.status === 401) clearToken();
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || '인식 실패');
      }

      const { data, success, warning } = await res.json();
      if (success === false) {
        setToast({ visible: true, message: 'AI 인식이 막혀 브라우저 OCR로 다시 인식 중...' });
        const browserData = await runBrowserOcr(resized, (progress) => {
          setToast({ visible: true, message: `브라우저 OCR 인식 중... ${progress}%` });
        });
        setOcrResult({
          data: { ...EMPTY_OCR_DATA, ...stripInternalOcrFields(browserData) },
          imageUrl,
          workOrderImageUrl: uploaded.url,
          rawText: browserData.raw_text || '',
        });
        setToast({ visible: true, message: '브라우저 OCR 인식 완료! 결과를 확인해주세요.' });
        return;
      }

      setOcrResult({ data, imageUrl, workOrderImageUrl: uploaded.url });
      setToast({
        visible: true,
        message: success === false
          ? (warning || '자동 인식이 지연되어 수동 입력으로 전환했습니다.')
          : '인식 완료! 결과를 확인해주세요.',
      });
    } catch (err) {
      if (uploadedUrl) {
        try {
          setToast({ visible: true, message: '서버 OCR이 막혀 브라우저 OCR로 다시 인식 중...' });
          const browserData = await runBrowserOcr(resizedFile || file, (progress) => {
            setToast({ visible: true, message: `브라우저 OCR 인식 중... ${progress}%` });
          });
          setOcrResult({
            data: { ...EMPTY_OCR_DATA, ...stripInternalOcrFields(browserData) },
            imageUrl,
            workOrderImageUrl: uploadedUrl,
            rawText: browserData.raw_text || '',
          });
          setToast({ visible: true, message: '브라우저 OCR 인식 완료! 결과를 확인해주세요.' });
        } catch (browserErr) {
          setOcrResult({ data: { ...EMPTY_OCR_DATA }, imageUrl, workOrderImageUrl: uploadedUrl });
          setToast({
            visible: true,
            message: '작업지시서 이미지는 첨부되었습니다. 인식값을 확인해서 입력해주세요.',
          });
        }
      } else {
        URL.revokeObjectURL(imageUrl);
        setToast({
          visible: true,
          message: err.message || '이미지 인식에 실패했습니다',
        });
      }
      if (!uploadedUrl) setToast({
        visible: true,
        message: uploadedUrl
          ? '작업지시서 이미지는 첨부되었습니다. 수동 입력으로 전환했습니다.'
          : (err.message || '이미지 인식에 실패했습니다'),
      });
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

  // Ctrl+V (또는 Cmd+V) 붙여넣기로 작업지시서 사진 업로드 — 페이지 어디서든 작동
  const processOcrFileRef = useRef(null);
  processOcrFileRef.current = processOcrFile;
  useEffect(() => {
    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items || items.length === 0) return;
      for (const item of items) {
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            // 텍스트 input 안에서 paste해도 이미지면 preventDefault (텍스트 paste 방해 안 함)
            e.preventDefault();
            processOcrFileRef.current?.(file);
            return;
          }
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, []);

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleOcrConfirm = () => {
    if (!ocrResult) return;
    if (!ocrValidation.isValid) {
      setToast({
        visible: true,
        message: `핵심 필수값 ${ocrValidation.invalidCoreFields.length}개가 누락되었거나 올바르지 않습니다. 표시된 항목을 수정해주세요.`,
      });
      return;
    }
    const d = ocrResult.data;
    setForm((prev) => ({
      ...prev,
      client_name: d.client_name || prev.client_name,
      order_date: d.order_date || prev.order_date,
      due_date: d.due_date || prev.due_date,
      phone: d.phone || prev.phone,
      delivery_address: d.delivery_address || prev.delivery_address,
      freight_payment: d.freight_payment || prev.freight_payment,
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
    setWorkOrderImageUrl(ocrResult.workOrderImageUrl || null);
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
    if (ocrResult?.workOrderImageUrl && workOrderImageUrl === ocrResult.workOrderImageUrl) {
      setWorkOrderImageUrl(null);
    }
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
    if (errors.due_date && newForm.due_date) {
      setErrors((prev) => ({ ...prev, due_date: undefined }));
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
            onChange={handleOcrUpload}
            style={{ display: 'none' }}
          />
        </div>
        <div className="order-entry__hero-wave">
          <svg viewBox="0 0 1440 60" preserveAspectRatio="none">
            <path d="M0,60 L0,20 Q360,0 720,20 Q1080,40 1440,20 L1440,60 Z" fill="var(--bg, #f0f9ff)" />
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
                  작업지시서 사진 — 드래그 / Ctrl+V 붙여넣기 / 클릭하여 업로드
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
        <div className="ocr-confirm-overlay">
          <div className="ocr-confirm" onClick={(e) => e.stopPropagation()}>
            <div className="ocr-confirm__header">
              <h2 className="ocr-confirm__title">📷 인식 결과 확인</h2>
              <p className="ocr-confirm__desc">인식된 정보를 확인하고 수정하세요</p>
            </div>

            {ocrValidation.invalidCoreFields.length > 0 && (
              <div className="ocr-confirm__notice ocr-confirm__notice--error" role="alert" aria-live="assertive">
                <strong>
                  핵심 필수값 {ocrValidation.invalidCoreFields.length}개가 누락되었거나 올바르지 않습니다.
                </strong>
                <span>표시된 항목을 수정해야 확인할 수 있습니다.</span>
              </div>
            )}

            {ocrValidation.blankOptionalFields.length > 0 && (
              <div className="ocr-confirm__notice ocr-confirm__notice--warning" role="status" aria-live="polite">
                선택 항목 {ocrValidation.blankOptionalFields.length}개가 비어 있습니다. 필요하면 입력 후 진행하세요.
              </div>
            )}

            {ocrResult.imageUrl && (
              <div className="ocr-confirm__image-wrap">
                <img src={ocrResult.imageUrl} alt="작업지시서" className="ocr-confirm__image" />
              </div>
            )}

            <div className="ocr-confirm__fields">
              {OCR_CONFIRMATION_FIELD_DEFINITIONS.map(({ key, label, required, type, dropdown, textarea }) => {
                const fieldError = ocrValidation.invalidCoreFields.find((field) => field.key === key);
                const fieldId = `ocr-confirm-${key}`;
                return (
                  <div key={key} className={`ocr-confirm__field${fieldError ? ' ocr-confirm__field--error' : ''}`}>
                    <label className="ocr-confirm__label" htmlFor={fieldId}>
                      {label}
                      {required && <span className="ocr-confirm__required" aria-hidden="true">*</span>}
                    </label>
                    <div className="ocr-confirm__control">
                      {dropdown ? (
                        <select
                          id={fieldId}
                          className={`ocr-confirm__input ocr-confirm__select${fieldError ? ' ocr-confirm__input--error' : ''}`}
                          value={ocrResult.data[key] || ''}
                          onChange={(e) => handleOcrEdit(key, e.target.value)}
                          aria-invalid={Boolean(fieldError)}
                          aria-describedby={fieldError ? `${fieldId}-error` : undefined}
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
                          id={fieldId}
                          className={`ocr-confirm__input ocr-confirm__textarea${fieldError ? ' ocr-confirm__input--error' : ''}`}
                          value={ocrResult.data[key] || ''}
                          onChange={(e) => handleOcrEdit(key, e.target.value)}
                          rows={2}
                          aria-invalid={Boolean(fieldError)}
                          aria-describedby={fieldError ? `${fieldId}-error` : undefined}
                        />
                      ) : (
                        <input
                          id={fieldId}
                          type={type || 'text'}
                          className={`ocr-confirm__input${fieldError ? ' ocr-confirm__input--error' : ''}`}
                          value={ocrResult.data[key] || ''}
                          onChange={(e) => handleOcrEdit(key, type === 'number' ? Number(e.target.value) || '' : e.target.value)}
                          aria-invalid={Boolean(fieldError)}
                          aria-describedby={fieldError ? `${fieldId}-error` : undefined}
                        />
                      )}
                      {fieldError && (
                        <span className="ocr-confirm__field-error" id={`${fieldId}-error`}>
                          {fieldError.message}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="ocr-confirm__actions">
              <button type="button" className="ocr-confirm__btn ocr-confirm__btn--cancel" onClick={handleOcrCancel}>
                취소
              </button>
              <button
                type="button"
                className="ocr-confirm__btn ocr-confirm__btn--confirm"
                onClick={handleOcrConfirm}
                disabled={!ocrValidation.isValid}
              >
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
