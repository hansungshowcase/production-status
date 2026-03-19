import React, { useState, useRef } from 'react';
import { uploadCsv } from '../../api/exportImport';
import './ImportSection.css';

export default function ImportSection() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const parsePreview = (csvFile) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const lines = text.split('\n').filter((l) => l.trim());
      const headers = lines[0].split(',').map((h) => h.trim());
      const rows = lines.slice(1, 6).map((line) =>
        line.split(',').map((cell) => cell.trim())
      );
      setPreview({ headers, rows, totalRows: lines.length - 1 });
    };
    reader.readAsText(csvFile, 'UTF-8');
  };

  const handleFile = (f) => {
    if (!f) return;
    if (!f.name.endsWith('.csv')) {
      alert('CSV 파일만 업로드 가능합니다.');
      return;
    }
    setFile(f);
    setResult(null);
    parsePreview(f);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    handleFile(f);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => setDragOver(false);

  const handleRemove = () => {
    setFile(null);
    setPreview(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await uploadCsv(file);
      setResult({ type: 'success', message: `${res.imported || 0}건 등록 완료` });
      setFile(null);
      setPreview(null);
    } catch (err) {
      setResult({ type: 'error', message: 'CSV 업로드 실패: ' + err.message });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="import-section">
      <h2>CSV 가져오기</h2>
      <p className="section-desc">CSV 파일을 업로드하여 주문을 일괄 등록합니다.</p>

      <input
        type="file"
        accept=".csv"
        ref={inputRef}
        style={{ display: 'none' }}
        onChange={(e) => handleFile(e.target.files[0])}
      />

      {!file && (
        <div
          className={`import-dropzone${dragOver ? ' drag-over' : ''}`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onClick={() => inputRef.current?.click()}
        >
          <div className="import-dropzone-icon">&#128196;</div>
          <div className="import-dropzone-text">
            파일을 끌어다 놓거나 <strong>클릭하여 선택</strong>
          </div>
        </div>
      )}

      {file && (
        <div className="import-file-info">
          <span className="import-file-name">{file.name}</span>
          <button className="import-file-remove" onClick={handleRemove}>
            제거
          </button>
        </div>
      )}

      {preview && (
        <div className="import-preview">
          <table>
            <thead>
              <tr>
                {preview.headers.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="import-preview-note">
            상위 {preview.rows.length}건 미리보기 (전체 {preview.totalRows}건)
          </div>
        </div>
      )}

      {file && (
        <button
          className="import-upload-btn"
          onClick={handleUpload}
          disabled={loading}
        >
          {loading ? '업로드 중...' : 'CSV 가져오기'}
        </button>
      )}

      {result && (
        <div className={`import-result ${result.type}`}>{result.message}</div>
      )}
    </div>
  );
}
