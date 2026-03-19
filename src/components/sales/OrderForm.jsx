import React, { useState, useEffect } from 'react';
import { SALES_PERSONS as SP_DATA } from '../../constants';
import './OrderForm.css';

const SALES_PERSONS = SP_DATA.map(p => p.name);
const PRODUCT_TYPES = ['제과', '정육', '반찬', '꽃', '와인', '오픈', '마카롱', '진열', '샌드위치', '주류', '음료', '토핑', '밧트', '유럽형', '냉동고', '직냉식', '양념육', '비냉', '셀프대면', '오픈쇼케이스'];
const DOOR_TYPES = ['앞문', '뒷문', '양문', '여닫이', '오픈', '라운드앞문', '라운드뒷문', '사선뒷문', '미닫이', '평대', '토핑'];
const COLORS = ['화이트', '올백색', '올스텐', '올검정', '블랙', '골드스텐', '골드미러', '스텐', '브론즈스텐'];

const initialForm = {
  order_date: '',
  due_date: '',
  sales_person: '',
  client_name: '',
  phone: '',
  product_type: '',
  door_type: '',
  width: '',
  depth: '',
  height: '',
  quantity: 1,
  color: '',
  custom_color: '',
  sale_amount: '',
  notes: '',
};

export default function OrderForm({ isOpen, onClose, onSubmit, editOrder }) {
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [useCustomColor, setUseCustomColor] = useState(false);

  useEffect(() => {
    if (editOrder) {
      const isCustom = editOrder.color && !COLORS.includes(editOrder.color);
      setUseCustomColor(isCustom);
      setForm({
        order_date: editOrder.order_date ? editOrder.order_date.slice(0, 10) : '',
        due_date: editOrder.due_date ? editOrder.due_date.slice(0, 10) : '',
        sales_person: editOrder.sales_person || '',
        client_name: editOrder.client_name || '',
        phone: editOrder.phone || '',
        product_type: editOrder.product_type || '',
        door_type: editOrder.door_type || '',
        width: editOrder.width || '',
        depth: editOrder.depth || '',
        height: editOrder.height || '',
        quantity: editOrder.quantity || 1,
        color: isCustom ? '' : (editOrder.color || ''),
        custom_color: isCustom ? editOrder.color : '',
        sale_amount: editOrder.sale_amount || '',
        notes: editOrder.notes || '',
      });
    } else {
      setForm({
        ...initialForm,
        order_date: new Date().toISOString().slice(0, 10),
      });
      setUseCustomColor(false);
    }
  }, [editOrder, isOpen]);

  if (!isOpen) return null;

  const handleChange = (field) => (e) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
  };

  const handleColorSelect = (e) => {
    const value = e.target.value;
    if (value === '__custom__') {
      setUseCustomColor(true);
      setForm((prev) => ({ ...prev, color: '' }));
    } else {
      setUseCustomColor(false);
      setForm((prev) => ({ ...prev, color: value, custom_color: '' }));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.client_name.trim()) return;

    setSubmitting(true);
    try {
      const data = {
        ...form,
        color: useCustomColor ? form.custom_color : form.color,
        width: form.width ? Number(form.width) : null,
        depth: form.depth ? Number(form.depth) : null,
        height: form.height ? Number(form.height) : null,
        quantity: form.quantity ? Number(form.quantity) : 1,
      };
      delete data.custom_color;
      await onSubmit(data);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="order-form-overlay show" onClick={onClose}>
      <div className="order-form-container" onClick={(e) => e.stopPropagation()}>
        <div className="order-form-header">
          <div className="order-form-title">
            {editOrder ? '주문 수정' : '새 주문 등록'}
          </div>
          <button className="order-form-close" onClick={onClose}>&times;</button>
        </div>
        <form className="order-form-body" onSubmit={handleSubmit}>
          {/* 기본 정보 */}
          <div className="form-section">
            <div className="form-section-title">기본 정보</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">발주일</label>
                <input
                  type="date"
                  className="form-input"
                  value={form.order_date}
                  onChange={handleChange('order_date')}
                />
              </div>
              <div className="form-group">
                <label className="form-label">납기일</label>
                <input
                  type="date"
                  className="form-input"
                  value={form.due_date}
                  onChange={handleChange('due_date')}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">담당</label>
                <select
                  className="form-select"
                  value={form.sales_person}
                  onChange={handleChange('sales_person')}
                >
                  <option value="">선택</option>
                  {SALES_PERSONS.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* 고객 정보 */}
          <div className="form-section">
            <div className="form-section-title">고객 정보</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">
                  거래처 <span className="required">*</span>
                </label>
                <input
                  type="text"
                  className="form-input"
                  value={form.client_name}
                  onChange={handleChange('client_name')}
                  placeholder="거래처명"
                  required
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">전화번호</label>
                <input
                  type="tel"
                  className="form-input"
                  value={form.phone}
                  onChange={handleChange('phone')}
                  placeholder="010-0000-0000"
                />
              </div>
            </div>
          </div>

          {/* 제품 정보 */}
          <div className="form-section">
            <div className="form-section-title">제품 정보</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">사양</label>
                <select
                  className="form-select"
                  value={form.product_type}
                  onChange={handleChange('product_type')}
                >
                  <option value="">선택</option>
                  {PRODUCT_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">디자인</label>
                <select
                  className="form-select"
                  value={form.door_type}
                  onChange={handleChange('door_type')}
                >
                  <option value="">선택</option>
                  {DOOR_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group full">
                <label className="form-label">규격 (가로 x 세로 x 높이)</label>
                <div className="dimension-inputs">
                  <input
                    type="number"
                    className="form-input"
                    value={form.width}
                    onChange={handleChange('width')}
                    placeholder="가로"
                  />
                  <span className="dimension-x">&times;</span>
                  <input
                    type="number"
                    className="form-input"
                    value={form.depth}
                    onChange={handleChange('depth')}
                    placeholder="세로"
                  />
                  <span className="dimension-x">&times;</span>
                  <input
                    type="number"
                    className="form-input"
                    value={form.height}
                    onChange={handleChange('height')}
                    placeholder="높이"
                  />
                </div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">수량</label>
                <input
                  type="number"
                  className="form-input"
                  value={form.quantity}
                  onChange={handleChange('quantity')}
                  min="1"
                />
              </div>
              <div className="form-group">
                <label className="form-label">색상</label>
                <div className="color-input-wrapper">
                  <select
                    className="form-select"
                    value={useCustomColor ? '__custom__' : form.color}
                    onChange={handleColorSelect}
                  >
                    <option value="">선택</option>
                    {COLORS.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                    <option value="__custom__">직접 입력</option>
                  </select>
                </div>
              </div>
            </div>
            {useCustomColor && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">색상 직접 입력</label>
                  <input
                    type="text"
                    className="form-input"
                    value={form.custom_color}
                    onChange={handleChange('custom_color')}
                    placeholder="색상명 입력"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 금액/비고 */}
          <div className="form-section">
            <div className="form-section-title">기타</div>
            <div className="form-row">
              <div className="form-group full">
                <label className="form-label">비고</label>
                <textarea
                  className="form-textarea"
                  value={form.notes}
                  onChange={handleChange('notes')}
                  placeholder="특이사항 입력"
                  rows={3}
                />
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="form-btn form-btn-cancel"
              onClick={onClose}
              disabled={submitting}
            >
              취소
            </button>
            <button
              type="submit"
              className="form-btn form-btn-submit"
              disabled={submitting || !form.client_name.trim()}
            >
              {submitting ? '저장 중...' : editOrder ? '수정' : '등록'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
