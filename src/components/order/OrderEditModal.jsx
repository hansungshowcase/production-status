import React, { useState, useEffect } from 'react';
import OrderForm from './OrderForm';
import { updateOrder, getTrackLink } from '../../api/orders';
import { getVisibleOrderMemo } from '../../utils/orderText';
import './OrderEditModal.css';

function normalizeOptionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const match = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export default function OrderEditModal({ order, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    ...order,
    notes: getVisibleOrderMemo(order?.notes),
    remarks: getVisibleOrderMemo(order?.remarks),
  }));
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);

  // 고객 화면 보기 — 발급 API로 링크를 받아 실제 고객 조회페이지를 새 탭으로 연다
  async function handleViewTrackPage() {
    if (!order?.id || viewLoading) return;
    // 팝업 차단 회피: 클릭 시점에 빈 탭을 먼저 열고, 링크 발급 후 주소를 채운다
    const win = window.open('', '_blank');
    setViewLoading(true);
    try {
      const res = await getTrackLink(order.id);
      const url = res?.url || '';
      if (!url) throw new Error('링크 발급 실패');
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch {
      if (win) win.close();
      window.alert('고객 화면을 여는 데 실패했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
      setViewLoading(false);
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
        delivery_address: form.delivery_address?.trim() || null,
        freight_payment: form.freight_payment?.trim() || null,
        product_type: form.product_type,
        door_type: form.door_type || null,
        design: form.design || null,
        width: form.width === '' || form.width == null ? null : Number(form.width),
        depth: form.depth === '' || form.depth == null ? null : Number(form.depth),
        height: form.height === '' || form.height == null ? null : Number(form.height),
        quantity: form.quantity === '' || form.quantity == null ? 1 : Number(form.quantity),
        color: form.color || null,
        sale_amount: normalizeOptionalPositiveNumber(form.sale_amount),
        balance: normalizeOptionalPositiveNumber(form.balance),
        notes: getVisibleOrderMemo(form.notes) || null,
        remarks: getVisibleOrderMemo(form.remarks) || null,
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
          <button
            type="button"
            className="order-edit-modal__view-link"
            onClick={handleViewTrackPage}
            disabled={saving || viewLoading}
          >
            {viewLoading ? '여는 중…' : '고객 화면 보기'}
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
