import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ExportSection from '../components/admin/ExportSection';
import ImportSection from '../components/admin/ImportSection';
import DataOverview from '../components/admin/DataOverview';
import WorkersSection from '../components/admin/WorkersSection';
import DiagnosticsSection from '../components/admin/DiagnosticsSection';
import request from '../api/client';
import { fetchAuthStatus, login, getRole, getToken } from '../utils/authClient';
import './AdminPage.css';

export default function AdminPage() {
  const navigate = useNavigate();
  const [salesPersons, setSalesPersons] = useState([]);
  const [authState, setAuthState] = useState({ checking: true, needLogin: false });
  const [pwd, setPwd] = useState('');
  const [loginErr, setLoginErr] = useState(null);
  const [logging, setLogging] = useState(false);

  useEffect(() => {
    fetchAuthStatus().then(s => {
      if (!s.enabled) {
        // 인증 비활성 — 기존 동작
        setAuthState({ checking: false, needLogin: false });
        return;
      }
      // 활성 — admin 토큰 있어야 통과
      const t = getToken();
      if (t && getRole() === 'admin') {
        setAuthState({ checking: false, needLogin: false });
      } else {
        setAuthState({ checking: false, needLogin: true });
      }
    });
  }, []);

  const authorized = !authState.checking && !authState.needLogin;

  useEffect(() => {
    if (!authorized) return;
    const fetchSalesPersons = async () => {
      try {
        const res = await request('/orders');
        const orders = res.orders || res.data || res || [];
        const persons = [...new Set(
          (Array.isArray(orders) ? orders : [])
            .map((o) => o.sales_person)
            .filter(Boolean)
        )].sort();
        setSalesPersons(persons);
      } catch (err) {
        console.error('담당자 목록 조회 실패:', err);
      }
    };
    fetchSalesPersons();
  }, [authorized]);

  async function submitAdminPwd() {
    if (logging) return;
    if (!pwd.trim()) { setLoginErr('비밀번호를 입력하세요'); return; }
    setLogging(true);
    setLoginErr(null);
    try {
      await login('admin', { password: pwd });
      setAuthState({ checking: false, needLogin: false });
    } catch (err) {
      setLoginErr(err.message || '로그인 실패');
    } finally {
      setLogging(false);
    }
  }

  if (authState.checking) {
    return <div className="admin-container"><div className="admin-content">확인 중...</div></div>;
  }

  if (authState.needLogin) {
    return (
      <div className="admin-container">
        <div className="admin-header">
          <button className="admin-back-btn" onClick={() => navigate('/')}>&#8592;</button>
          <div className="admin-header-title">관리자 로그인</div>
        </div>
        <div className="admin-content" style={{ maxWidth: 380, margin: '40px auto' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', marginBottom: 14 }}>관리자 비밀번호</div>
            <input
              type="password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAdminPwd(); }}
              placeholder="비밀번호"
              autoFocus
              disabled={logging}
              style={{ width: '100%', padding: 12, fontSize: 16, borderRadius: 10, border: '1px solid #cbd5e1', minHeight: 48, fontFamily: 'inherit' }}
            />
            {loginErr && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: '#fee2e2', color: '#b91c1c', borderRadius: 8, fontSize: 13, fontWeight: 600 }}>
                {loginErr}
              </div>
            )}
            <button
              onClick={submitAdminPwd}
              disabled={logging || !pwd}
              style={{ marginTop: 14, width: '100%', padding: 12, background: '#0369a1', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 700, minHeight: 48, cursor: 'pointer' }}
            >
              {logging ? '확인 중...' : '확인'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-container">
      <div className="admin-header">
        <button className="admin-back-btn" onClick={() => navigate(-1)}>
          &#8592;
        </button>
        <div className="admin-header-title">데이터 관리</div>
        <div className="admin-header-badge">관리자</div>
      </div>

      <div className="admin-content">
        <DataOverview />
        <WorkersSection />
        <ExportSection salesPersons={salesPersons} />
        <ImportSection />
        <DiagnosticsSection />
      </div>

      <div className="admin-footer">
        한성쇼케이스 제작현황 v1.0
      </div>
    </div>
  );
}
