import React, { useState } from 'react';
import request from '../../api/client';
import { getSyncStatus } from '../../api/sync';
import { describeTableColumn } from '../../utils/fieldLabels';
import './DiagnosticsSection.css';

export default function DiagnosticsSection() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [syncResult, setSyncResult] = useState(null);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState(null);

  async function runSyncCheck() {
    setSyncLoading(true);
    setSyncError(null);
    try {
      const data = await getSyncStatus();
      setSyncResult(data);
    } catch (err) {
      setSyncError(err.message || '동기화 상태 조회 실패');
    } finally {
      setSyncLoading(false);
    }
  }

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

  const hasSyncBacklog = Boolean(
    syncResult && (
      (syncResult.append?.pending || 0) > 0
      || (syncResult.append?.failed || 0) > 0
      || (syncResult.shipping?.pending || 0) > 0
      || (syncResult.shipping?.failed || 0) > 0
    )
  );

  return (
    <div className="diag-section">
      <div className="diag-section__title">시트 동기화 상태 점검</div>
      <div className="diag-section__desc">
        구글 시트 등록·출고 동기화 큐에 대기 중이거나 지연·실패한 주문이 있는지 확인합니다.
      </div>
      <button className="diag-section__btn" onClick={runSyncCheck} disabled={syncLoading}>
        {syncLoading ? '조회 중...' : '시트 동기화 상태 확인'}
      </button>

      {syncError && <div className="diag-section__error">{syncError}</div>}

      {syncResult && (
        <div className="diag-section__result">
          <div className={`diag-section__summary${hasSyncBacklog ? ' diag-section__summary--warn' : ' diag-section__summary--ok'}`}>
            {syncResult.message || '동기화 상태 확인 완료'}
          </div>
          {syncResult.lastSync && (
            <div className="diag-section__meta">
              최근 성공: {new Date(syncResult.lastSync).toLocaleString('ko-KR')}
            </div>
          )}
          <div className="diag-section__sync-grid">
            <div className="diag-section__group">
              <div className="diag-section__group-title">신규 등록 시트 반영</div>
              <div className="diag-section__sync-counts">
                대기 {syncResult.append?.pending ?? 0} · 실패 {syncResult.append?.failed ?? 0} · 시간초과 {syncResult.append?.errors?.timeout ?? 0} · 완료 {syncResult.append?.synced ?? 0}
              </div>
            </div>
            <div className="diag-section__group">
              <div className="diag-section__group-title">출고 완료 시트 반영</div>
              <div className="diag-section__sync-counts">
                대기 {syncResult.shipping?.pending ?? 0} · 실패 {syncResult.shipping?.failed ?? 0} · 시간초과 {syncResult.shipping?.errors?.timeout ?? 0} · 완료 {syncResult.shipping?.synced ?? 0}
              </div>
            </div>
          </div>
        </div>
      )}

      <hr className="diag-section__divider" />

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
              <div className="diag-section__group-title">{describeTableColumn(key)}</div>
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
