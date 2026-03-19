import React, { useRef, useState } from 'react';
import './PhotoCapture.css';

export default function PhotoCapture({ onCapture, disabled }) {
  const fileInputRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [uploading, setUploading] = useState(false);

  const handleClick = () => {
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Show preview
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPreview(ev.target.result);
    };
    reader.readAsDataURL(file);

    // Notify parent
    if (onCapture) {
      setUploading(true);
      try {
        await onCapture(file);
      } finally {
        setUploading(false);
      }
    }

    // Reset input so the same file can be re-selected
    e.target.value = '';
  };

  const clearPreview = (e) => {
    e.stopPropagation();
    setPreview(null);
  };

  return (
    <div className="photo-capture">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="photo-input-hidden"
        onChange={handleFileChange}
      />

      {preview ? (
        <div className="photo-preview-wrap" onClick={handleClick}>
          <img src={preview} alt="미리보기" className="photo-preview-img" />
          <button className="photo-clear-btn" onClick={clearPreview}>
            &times;
          </button>
          {uploading && (
            <div className="photo-uploading-overlay">
              <div className="photo-upload-spinner" />
            </div>
          )}
        </div>
      ) : (
        <button
          className={`photo-capture-btn ${disabled ? 'photo-btn-disabled' : ''}`}
          onClick={handleClick}
          disabled={disabled}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
          <span>사진</span>
        </button>
      )}
    </div>
  );
}
