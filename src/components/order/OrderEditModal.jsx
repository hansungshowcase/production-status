import React, { useState, useEffect } from 'react';
import OrderForm from './OrderForm';
import { updateOrder } from '../../api/orders';
import './OrderEditModal.css';

export default function OrderEditModal({ order, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({ ...order }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);

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
        </div>

        {serverError && (
          <div className="order-edit-modal__error">{serverError}</div>
        )}

        <div className="order-edit-modal__footer">
          <button className="order-edit-modal__cancel" onClick={onClose} disabled={saving}>취소</button>
          <button className="order-edit-modal__save" onClick={handleSave} disabled={saving}>
            {saving ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
