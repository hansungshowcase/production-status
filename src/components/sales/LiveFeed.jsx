import React, { useState } from 'react';
import './LiveFeed.css';

export default function LiveFeed({ items }) {
  const feedData = items || [];
  const [expanded, setExpanded] = useState(false);

  // 모바일: 기본 3개만 보여주고 펼치기 가능
  const PREVIEW_COUNT = 3;
  const hasMore = feedData.length > PREVIEW_COUNT;
  const visibleItems = expanded ? feedData : feedData.slice(0, PREVIEW_COUNT);

  return (
    <div className={`live-feed ${expanded ? 'live-feed--expanded' : ''}`}>
      <button className="live-feed-header" onClick={() => setExpanded(!expanded)}>
        <div className="live-badge">
          <div className="live-dot" />
          실시간 업데이트
          <span className="live-count">{feedData.length}</span>
        </div>
        {hasMore && (
          <span className="live-toggle">
            {expanded ? '접기' : '더보기'}
            <span className={`live-toggle-arrow ${expanded ? 'up' : ''}`}>›</span>
          </span>
        )}
      </button>
      <div className="live-feed-list">
        {visibleItems.map((item, idx) => (
          <div
            key={idx}
            className="feed-item"
            style={{ animationDelay: `${idx * 0.05}s` }}
          >
            <span className="feed-time">{item.time}</span>
            <div className="feed-icon" style={{ background: item.iconBg }}>
              {item.icon}
            </div>
            <div className="feed-text">
              <strong>{item.title}</strong>
              <span>{item.desc}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
