import React from 'react';
import { SALES_PERSONS as SP_DATA } from '../../constants';
import './OrderForm.css';

const SALES_PERSONS = SP_DATA.map(p => p.name);

const PRODUCT_TYPES = ['제과', '정육', '반찬', '꽃', '와인', '오픈', '진열', '마카롱', '샌드위치', '음료', '밧트', '토핑', '양념육', '유럽형', '주류'];

const DOOR_TYPES = ['앞문', '뒷문', '양문', '여닫이', '오픈', '라운드앞문', '라운드뒷문', '평대'];

const COLORS = ['화이트', '올백색', '올스텐', '올검정', '블랙', '골드스텐', '골드미러'];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export default function OrderForm({ form, errors, onChange }) {
  const set = (field, value) => onChange({ ...form, [field]: value });
  const inp = (field) => (e) => set(field, e.target.value);

  // Auto-fill today on mount
  if (!form.order_date) {
    setTimeout(() => onChange({ ...form, order_date: todayStr() }), 0);
  }

  return (
    <div className="of">
      {/* 기본 정보 */}
      <div className="of__section">
        <h3 className="of__section-title">기본 정보</h3>
        <div className="of__row">
          <label className="of__field">
            <span className="of__label">발주일</span>
            <input type="date" className="of__input" value={form.order_date || todayStr()} onChange={inp('order_date')} />
          </label>
          <label className="of__field">
            <span className="of__label">납기일</span>
            <input type="date" className="of__input" value={form.due_date || ''} onChange={inp('due_date')} />
          </label>
        </div>
        <label className="of__field">
          <span className="of__label">담당자</span>
          <select className="of__input of__select" value={form.sales_person || ''} onChange={inp('sales_person')}>
            <option value="">선택</option>
            {SALES_PERSONS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>

      {/* 고객 정보 */}
      <div className="of__section">
        <h3 className="of__section-title">고객 정보</h3>
        <label className="of__field">
          <span className="of__label">거래처 <span className="of__req">*</span></span>
          <input
            type="text"
            className={`of__input ${errors.client_name ? 'of__input--error' : ''}`}
            value={form.client_name || ''}
            onChange={inp('client_name')}
            placeholder="거래처명"
          />
          {errors.client_name && <span className="of__error">{errors.client_name}</span>}
        </label>
        <label className="of__field">
          <span className="of__label">전화번호</span>
          <input type="tel" className="of__input" value={form.phone || ''} onChange={inp('phone')} placeholder="010-0000-0000" inputMode="tel" />
        </label>
      </div>

      {/* 제품 정보 */}
      <div className="of__section">
        <h3 className="of__section-title">제품 정보</h3>
        <div className="of__row">
          <label className="of__field">
            <span className="of__label">사양 <span className="of__req">*</span></span>
            <select
              className={`of__input of__select ${errors.product_type ? 'of__input--error' : ''}`}
              value={form.product_type || ''}
              onChange={inp('product_type')}
            >
              <option value="">선택</option>
              {PRODUCT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            {errors.product_type && <span className="of__error">{errors.product_type}</span>}
          </label>
          <label className="of__field">
            <span className="of__label">디자인</span>
            <select className="of__input of__select" value={form.door_type || ''} onChange={inp('door_type')}>
              <option value="">선택</option>
              {DOOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* 규격 */}
      <div className="of__section">
        <h3 className="of__section-title">규격</h3>
        <div className="of__dim-row">
          <label className="of__dim-field">
            <span className="of__dim-label">가로</span>
            <div className="of__dim-wrap">
              <input type="number" className="of__input of__input--dim" value={form.width || ''} onChange={inp('width')} placeholder="0" min="0" inputMode="numeric" />
              <span className="of__dim-unit">mm</span>
            </div>
          </label>
          <span className="of__dim-x">&times;</span>
          <label className="of__dim-field">
            <span className="of__dim-label">세로</span>
            <div className="of__dim-wrap">
              <input type="number" className="of__input of__input--dim" value={form.depth || ''} onChange={inp('depth')} placeholder="0" min="0" inputMode="numeric" />
              <span className="of__dim-unit">mm</span>
            </div>
          </label>
          <span className="of__dim-x">&times;</span>
          <label className="of__dim-field">
            <span className="of__dim-label">높이</span>
            <div className="of__dim-wrap">
              <input type="number" className="of__input of__input--dim" value={form.height || ''} onChange={inp('height')} placeholder="0" min="0" inputMode="numeric" />
              <span className="of__dim-unit">mm</span>
            </div>
          </label>
        </div>
        <div className="of__row">
          <label className="of__field">
            <span className="of__label">수량</span>
            <input type="number" className="of__input" value={form.quantity === '' || form.quantity == null ? '' : form.quantity} onChange={inp('quantity')} placeholder="1" min="1" inputMode="numeric" />
          </label>
          <label className="of__field">
            <span className="of__label">색상</span>
            <select className="of__input of__select" value={form.color || ''} onChange={inp('color')}>
              <option value="">선택</option>
              {COLORS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* 기타 */}
      <div className="of__section">
        <h3 className="of__section-title">기타</h3>
        <label className="of__field">
          <span className="of__label">비고</span>
          <textarea className="of__input of__textarea" value={form.notes || ''} onChange={inp('notes')} placeholder="특이사항" rows={3} />
        </label>
      </div>
    </div>
  );
}
