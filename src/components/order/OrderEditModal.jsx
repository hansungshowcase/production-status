import React, { useState, useEffect } from 'react';
import OrderForm from './OrderForm';
import { updateOrder, getTrackLink } from '../../api/orders';
import './OrderEditModal.css';

export default function OrderEditModal({ order, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...order }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkLoading, setLinkLoading] = useState(false);

  // 조회링크는 목록 응답에 없고(토큰 공개 방지) 발급 API 로 필요 시점에 받아온다
  async function handleCopyTrackLink() {
    if (!order?.id || linkLoading) return;
    setLinkLoading(true);
    let url = '';
    try {
      const res = await getTrackLink(order.id);
      url = res?.url || '';
      if (!url) throw new Error('링크 발급 실패');
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // 구형 브라우저 폴백
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      if (url) window.prompt('아래 링크를 복사하세요', url);
      else window.alert('조회링크 발급에 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setLinkLoading(false);
    }
  }

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  function validate() {
    const e = {};
    if (!form.client_name?.trim()) e.client_name = '거래처명은 필수입니다';
    if (!form.product_type) e.product_type = '사양은 필수입니다';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    setServerError(null);
    try {
      const payload = {
        order_date: form.order_date || null,
        due_date: form.due_date || null,
        sales_person: form.sales_person || null,
        client_name: form.client_name.trim(),
        phone: form.phone || null,
        product_type: form.product_type,
        door_type: form.door_type || null,
        design: form.design || null,
        width: form.width === '' || form.width == null ? null : Number(form.width),
        depth: form.depth === '' || form.depth == null ? null : Number(form.depth),
        height: form.height === '' || form.height == null ? null : Number(form.height),
        quantity: form.quantity === '' || form.quantity == null ? 1 : Number(form.quantity),
        color: form.color || null,
        notes: form.notes || null,
        remarks: form.remarks || null,
        ship_scheduled_date: form.ship_scheduled_date || null,
      };
      const updated = await updateOrder(order.id, payload);
      onSaved?.(updated);
      onClose();
    } catch (err) {
      setServerError(err.message || '수정 실패');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="order-edit-modal__overlay" onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <div className="order-edit-modal__panel" role="dialog" aria-label="주문 수정">
        <div className="order-edit-modal__header">
          <h2 className="order-edit-modal__title">주문 수정</h2>
          <button className="order-edit-modal__close" onClick={onClose} disabled={saving} aria-label="닫기">&times;</button>
        </div>

        <div className="order-edit-modal__body">
          <OrderForm form={form} errors={errors} onChange={setForm} />

          {/* 출고예정일 — 저장 시 백엔드 PATCH 훅이 고객 알림(rescheduled) 처리 */}
          <div className="order-edit-modal__ship-section">
            <label className="order-edit-modal__ship-label">
              <span>출고예정일</span>
              <input
                type="date"
                className="order-edit-modal__ship-input"
                value={form.ship_scheduled_date ? String(form.ship_scheduled_date).slice(0, 10) : ''}
                onChange={(e) => setForm({ ...form, ship_scheduled_date: e.target.value })}
              />
            </label>
            <p className="order-edit-modal__ship-hint">저장 시 고객에게 변경 안내가 발송됩니다</p>
          </div>
        </div>

        {serverError && (
          <div className="order-edit-modal__error">{serverError}</div>
        )}

        <div className="order-edit-modal__footer">
          <button
            type="button"
            className="order-edit-modal__copy-link"
            onClick={handleCopyTrackLink}
            disabled={saving || linkLoading}
          >
            {linkCopied ? '복사됨 ✓' : linkLoading ? '발급 중…' : '고객 조회링크 복사'}
          </button>
          <button className="order-edit-modal__cancel" onClick={onClose} disabled={saving}>취소</button>
          <button className="order-edit-modal__save" onClick={handleSave} disabled={saving}>
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
