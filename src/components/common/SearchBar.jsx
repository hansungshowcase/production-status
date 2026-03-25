import React, { useState, useRef, useEffect, useCallback } from 'react';
import { getOrders } from '../../api/orders';
import { PROCESS_STEPS } from '../../constants';
import './SearchBar.css';

export default function SearchBar({ placeholder = '검색', onSelect, onSearch }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const timerRef = useRef(null);

  // Debounced search
  const search = useCallback((text) => {
    if (timerRef.current) clearTimeout(timerRef.current);

    // Local filter mode: just pass query text back
    if (onSearch) {
      timerRef.current = setTimeout(() => onSearch(text), 300);
      return;
    }

    if (!text.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await getOrders({ search: text.trim(), limit: 10 });
        const orders = Array.isArray(res) ? res : (res.orders || []);
        setResults(orders);
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [onSearch]);

  const handleChange = (e) => {
    const val = e.target.value;
    setQuery(val);
    search(val);
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    setOpen(false);
    if (onSearch) onSearch('');
  };

  const handleSelect = (order) => {
    setOpen(false);
    setQuery('');
    setResults([]);
    if (onSelect) onSelect(order);
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Cleanup timer
  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const getDueInfo = (order) => {
    if (!order.due_date) return { label: '-', className: '' };
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const due = new Date(order.due_date);
    due.setHours(0, 0, 0, 0);
    const diff = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    const dateStr = due.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' });
    if (diff === 0) return { label: `${dateStr} (D-Day)`, className: 'searchbar-overdue' };
    if (diff < 0) return { label: `${dateStr} (D+${Math.abs(diff)})`, className: 'searchbar-overdue' };
    if (diff <= 3) return { label: `${dateStr} (D-${diff})`, className: 'searchbar-duesoon' };
    return { label: dateStr, className: '' };
  };

  const getStepInfo = (order) => {
    const completed = order.completed_steps || 0;
    const total = order.total_steps || PROCESS_STEPS.length;
    if (completed >= total) return '완료';
    return `${completed}/${total}`;
  };

  return (
    <div className="searchbar" ref={wrapRef}>
      <div className="searchbar-input-wrap">
        <svg className="searchbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          className="searchbar-input"
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={handleChange}
        />
        {query && (
          <button className="searchbar-clear" onClick={handleClear} aria-label="초기화">
            <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="2" y1="2" x2="10" y2="10" />
              <line x1="10" y1="2" x2="2" y2="10" />
            </svg>
          </button>
        )}
      </div>

      {open && !onSearch && (
        <div className="searchbar-results">
          {loading && <div className="searchbar-loading">검색중...</div>}
          {!loading && results.length === 0 && (
            <div className="searchbar-empty">검색 결과가 없습니다</div>
          )}
          {!loading && results.map((order) => {
            const due = getDueInfo(order);
            const step = getStepInfo(order);
            const clientName = order.client_name || '-';
            return (
              <button
                key={order.id}
                className="searchbar-item"
                onClick={() => handleSelect(order)}
              >
                <div className="searchbar-item-top">
                  <span className="searchbar-client">{clientName}</span>
                  <span className="searchbar-step">{step}</span>
                </div>
                <div className="searchbar-item-bottom">
                  <span>{order.product_type || '-'}</span>
                  <span className="searchbar-sep">·</span>
                  <span>{order.sales_person || '-'}</span>
                  <span className="searchbar-sep">·</span>
                  <span className={due.className}>{due.label}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
