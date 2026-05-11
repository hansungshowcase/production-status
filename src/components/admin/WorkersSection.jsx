import React, { useState, useEffect, useCallback } from 'react';
import { getWorkers, createWorker, deleteWorker } from '../../api/workers';
import { DEPARTMENTS } from '../../constants';
import './WorkersSection.css';

export default function WorkersSection() {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterDept, setFilterDept] = useState('all');
  const [newName, setNewName] = useState('');
  const [newDept, setNewDept] = useState(DEPARTMENTS[0]);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const fetchWorkers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getWorkers();
      setWorkers(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(err.message || '작업자 목록을 불러올 수 없습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWorkers(); }, [fetchWorkers]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) {
      setError('작업자 이름을 입력하세요');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createWorker({ name, department: newDept });
      setNewName('');
      await fetchWorkers();
    } catch (err) {
      setError(err.message || '작업자 추가 실패');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setError(null);
    try {
      await deleteWorker(id);
      setWorkers(prev => prev.filter(w => w.id !== id));
    } catch (err) {
      setError(err.message || '작업자 삭제 실패');
    } finally {
      setConfirmDeleteId(null);
    }
  }

  const filtered = filterDept === 'all'
    ? workers
    : workers.filter(w => w.department === filterDept);

  // Group by department for display
  const groups = {};
  filtered.forEach(w => {
    if (!groups[w.department]) groups[w.department] = [];
    groups[w.department].push(w);
  });

  return (
    <div className="workers-section">
      <div className="workers-section__title">작업자 관리</div>

      {/* 추가 폼 */}
      <div className="workers-section__add">
        <input
          type="text"
          className="workers-section__input"
          placeholder="작업자 이름"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          disabled={saving}
        />
        <select
          className="workers-section__select"
          value={newDept}
          onChange={(e) => setNewDept(e.target.value)}
          disabled={saving}
        >
          {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button
          className="workers-section__add-btn"
          onClick={handleAdd}
          disabled={saving || !newName.trim()}
        >
          {saving ? '추가 중...' : '+ 추가'}
        </button>
      </div>

      {error && <div className="workers-section__error">{error}</div>}

      {/* 필터 */}
      <div className="workers-section__filter-row">
        <button
          className={`workers-section__filter-btn${filterDept === 'all' ? ' workers-section__filter-btn--active' : ''}`}
          onClick={() => setFilterDept('all')}
        >
          전체 ({workers.length})
        </button>
        {DEPARTMENTS.map(d => {
          const count = workers.filter(w => w.department === d).length;
          if (count === 0) return null;
          return (
            <button
              key={d}
              className={`workers-section__filter-btn${filterDept === d ? ' workers-section__filter-btn--active' : ''}`}
              onClick={() => setFilterDept(d)}
            >
              {d} ({count})
            </button>
          );
        })}
      </div>

      {/* 목록 */}
      {loading ? (
        <div className="workers-section__loading">로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div className="workers-section__empty">
          {filterDept === 'all' ? '등록된 작업자가 없습니다' : `${filterDept} 부서에 작업자가 없습니다`}
        </div>
      ) : (
        <div className="workers-section__groups">
          {Object.keys(groups).sort().map(dept => (
            <div key={dept} className="workers-section__group">
              <div className="workers-section__group-title">{dept} ({groups[dept].length})</div>
              <div className="workers-section__chips">
                {groups[dept].map(w => (
                  <div key={w.id} className="workers-section__chip">
                    <span className="workers-section__chip-name">{w.name}</span>
                    {confirmDeleteId === w.id ? (
                      <>
                        <button
                          className="workers-section__chip-yes"
                          onClick={() => handleDelete(w.id)}
                        >
                          삭제
                        </button>
                        <button
                          className="workers-section__chip-no"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          취소
                        </button>
                      </>
                    ) : (
                      <button
                        className="workers-section__chip-del"
                        onClick={() => setConfirmDeleteId(w.id)}
                        title="삭제"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
