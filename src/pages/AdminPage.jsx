import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ExportSection from '../components/admin/ExportSection';
import ImportSection from '../components/admin/ImportSection';
import DataOverview from '../components/admin/DataOverview';
import request from '../api/client';
import './AdminPage.css';

export default function AdminPage() {
  const navigate = useNavigate();
  const [salesPersons, setSalesPersons] = useState([]);

  useEffect(() => {
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
  }, []);

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
        <ExportSection salesPersons={salesPersons} />
        <ImportSection />
      </div>

      <div className="admin-footer">
        한성쇼케이스 제작현황 v1.0
      </div>
    </div>
  );
}
