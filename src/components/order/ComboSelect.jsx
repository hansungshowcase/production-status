import React, { useState, useRef, useEffect } from 'react';
import './ComboSelect.css';

export default function ComboSelect({
  value,
  onChange,
  options = [],
  placeholder = '선택 또는 직접 입력',
  hasError = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value || '');
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    setInputValue(value || '');
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleChipClick = (option) => {
    onChange(option);
    setInputValue(option);
    setIsOpen(false);
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInputValue(val);
    onChange(val);
    if (!isOpen) setIsOpen(true);
  };

  const handleInputFocus = () => {
    setIsOpen(true);
  };

  const filteredOptions = options.filter(
    (opt) => !inputValue || opt.includes(inputValue)
  );

  return (
    <div className="combo-select" ref={wrapperRef}>
      <div className="combo-select__chips">
        {options.slice(0, 8).map((opt) => (
          <button
            key={opt}
            type="button"
            className={`combo-select__chip ${value === opt ? 'combo-select__chip--active' : ''}`}
            onClick={() => handleChipClick(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
      <div className="combo-select__input-wrap">
        <input
          ref={inputRef}
          type="text"
          className={`combo-select__input ${hasError ? 'combo-select__input--error' : ''}`}
          value={inputValue}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          placeholder={placeholder}
        />
        {inputValue && (
          <button
            type="button"
            className="combo-select__clear"
            onClick={() => { setInputValue(''); onChange(''); }}
            aria-label="지우기"
          >
            &times;
          </button>
        )}
      </div>
      {isOpen && filteredOptions.length > 0 && (
        <ul className="combo-select__dropdown">
          {filteredOptions.map((opt) => (
            <li
              key={opt}
              className={`combo-select__option ${value === opt ? 'combo-select__option--selected' : ''}`}
              onMouseDown={() => handleChipClick(opt)}
            >
              {opt}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
