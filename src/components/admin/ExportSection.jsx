import React, { useState } from 'react';
import { downloadCsv } from '../../api/exportImport';
import './ExportSection.css';

const STATUS_OPTIONS = [
  { value: 'all', label: '전체' },
  { value: 'in-progress', label: '생산중' },
  { value: '출고완료', label: '출고완료' },
];

export default function ExportSection({ salesPersons = [] }) {
  const [status, setStatus] = useState('all');
  const [salesPerson, setSalesPerson] = useState('all');
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      await downloadCsv({ status, salesPerson });
    } catch (err) {
      alert('CSV 다운로드 실패: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="export-section">
      <h2>CSV 내보내기</h2>
      <p className="section-desc">주문 데이터를 CSV 파일로 다운로드합니다.</p>

      <div className="export-filters">
        <div className="export-filter-row">
          <label>상태</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="export-filter-row">
          <label>담당자</label>
          <select value={salesPerson} onChange={(e) => setSalesPerson(e.target.value)}>
            <option value="all">전체</option>
            {salesPersons.map((sp) => (
              <option key={sp} value={sp}>
                {sp}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        className="export-download-btn"
        onClick={handleDownload}
        disabled={loading}
      >
        {loading ? '다운로드 중...' : 'CSV 다운로드'}
      </button>
    </div>
  );
}
