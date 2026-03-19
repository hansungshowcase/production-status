import React from 'react';
import './FormField.css';

export default function FormField({
  label,
  required,
  error,
  children,
  className = '',
}) {
  return (
    <div className={`form-field ${error ? 'form-field--error' : ''} ${className}`}>
      <label className="form-field__label">
        {label}
        {required && <span className="form-field__required">*</span>}
      </label>
      <div className="form-field__control">
        {children}
      </div>
      {error && <p className="form-field__error">{error}</p>}
    </div>
  );
}
