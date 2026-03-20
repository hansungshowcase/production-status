import React from 'react';
import { useNavigate } from 'react-router-dom';
import './HomePage.css';

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="home-container">
      <div className="home-header">
        <div className="home-logo">
          <div className="home-logo-icon">HS</div>
          <div>
            <div className="home-title">한성쇼케이스</div>
            <div className="home-subtitle">제작현황 관리 시스템</div>
          </div>
        </div>
      </div>

      <div className="home-content">
        {/* ── Hero: 새 주문 등록 ── */}
        <button
          className="home-hero-order"
          onClick={() => navigate('/orders/new')}
        >
          <div className="home-hero-order__badge">바로 시작</div>
          <div className="home-hero-order__icon">📋</div>
          <div className="home-hero-order__title">작업 등록하기</div>
          <div className="home-hero-order__desc">
            신규 제작 발주를 빠르게 등록하세요<br />
            거래처·납기일·사양을 한 번에 입력
          </div>
          <div className="home-hero-order__cta">작업 등록하기 &rarr;</div>
        </button>

        <p className="home-desc">또는 화면을 선택하세요</p>

        {/* ── Row 1: 현장작업자 · 영업관리 ── */}
        <div className="home-cards home-cards--row">
          <button
            className="home-card home-card-worker"
            onClick={() => {
              sessionStorage.removeItem('selected_worker');
              sessionStorage.removeItem('selected_department');
              navigate('/worker/select', { state: { redirectTo: '/worker/station' } });
            }}
          >
            <div className="home-card-icon">&#x1F477;</div>
            <div className="home-card-title">현장 작업자</div>
            <div className="home-card-desc">
              공정 시작/완료 처리<br />
              작업 사진 첨부 및 이슈 보고<br />
              내 담당 작업 현황 확인
            </div>
            <div className="home-card-arrow">&rarr;</div>
          </button>

          <button
            className="home-card home-card-sales"
            onClick={() => navigate('/sales')}
          >
            <div className="home-card-icon">&#x1F4BC;</div>
            <div className="home-card-title">영업 관리</div>
            <div className="home-card-desc">
              전체 발주 현황 추적<br />
              납기일 관리 및 진행률 확인<br />
              실시간 피드 및 거래처 정보
            </div>
            <div className="home-card-arrow">&rarr;</div>
          </button>
        </div>
      </div>

      <div className="home-footer">
        <span>HANSUNGSHOWCASE</span>
        <span className="home-footer__motto">잘 만든 제품은 고객의 삶을 바꿉니다.</span>
      </div>
    </div>
  );
}
