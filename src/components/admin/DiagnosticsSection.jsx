import React, { useState } from 'react';
import request from '../../api/client';
import './DiagnosticsSection.css';

export default function DiagnosticsSection() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function runScan() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await request('/admin/mojibake-scan');
      setResult(data);
    } catch (err) {
      setError(err.message || '진단 실패');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="diag-section">
      <div className="diag-section__title">데이터 진단</div>
      <div className="diag-section__desc">
        과거 cp949 인코딩으로 저장된 깨진 한글이 있는지 검사합니다. 신규 데이터는 utf-8이라 영향 없음.
      </div>
      <button className="diag-section__btn" onClick={runScan} disabled={loading}>
        {loading ? '검사 중...' : '깨진 한글 검사'}
      </button>

      {error && <div className="diag-section__error">{error}</div>}

      {result && (
        <div className="diag-section__result">
          <div className={`diag-section__summary${result.total_suspect_rows > 0 ? ' diag-section__summary--warn' : ' diag-section__summary--ok'}`}>
            {result.total_suspect_rows === 0
              ? '✅ 의심 데이터 0건 — 변환 작업 불필요'
              : `⚠️ 의심 행 ${result.total_suspect_rows}건 발견`}
          </div>
          <div className="diag-section__meta">검사: {new Date(result.scanned_at).toLocaleString('ko-KR')}</div>
          {Object.entries(result.results).map(([key, r]) => (
            <div key={key} className="diag-section__group">
              <div className="diag-section__group-title">{key}</div>
              {r.error ? (
                <div className="diag-section__group-err">에러: {r.error}</div>
              ) : r.suspectCount === 0 ? (
                <div className="diag-section__group-ok">정상</div>
              ) : (
                <ul className="diag-section__samples">
                  {r.samples.map(s => (
                    <li key={s.id}>#{s.id}: {s.preview}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
