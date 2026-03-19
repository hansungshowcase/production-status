import React from 'react';
import { useNavigate } from 'react-router-dom';
import { getDaysUntilDue } from '../../utils/dateUtils';
import { PROCESS_STEPS } from '../../constants';
import './SearchResultCard.css';

export default function SearchResultCard({ order }) {
  const navigate = useNavigate();

  const days = getDaysUntilDue(order.dueDate);
  const isOverdue = days !== null && days < 0;
  const isDueSoon = days !== null && days >= 0 && days <= 3;

  const borderClass = isOverdue
    ? 'src-overdue'
    : isDueSoon
    ? 'src-due-soon'
    : '';

  const currentStepName = order.currentStepName || PROCESS_STEPS[order.currentStep] || '-';

  const getStatusLabel = () => {
    if (order.isCompleted) return '완료';
    if (order.isActive) return '진행중';
    return '대기';
  };

  const getStatusClass = () => {
    if (order.isCompleted) return 'src-status-done';
    if (order.isActive) return 'src-status-progress';
    return 'src-status-waiting';
  };

  const handleClick = () => {
    navigate(`/worker/update/${order.id}`);
  };

  const displaySpec = order.productType
    ? `${order.productType}${order.doorType ? ' / ' + order.doorType : ''}`
    : order.product || '-';

  const dimensions =
    order.width && order.depth && order.height
      ? `${order.width}x${order.depth}x${order.height}`
      : null;

  return (
    <div className={`search-result-card ${borderClass}`} onClick={handleClick} role="button" tabIndex={0}>
      <div className="src-header">
        <span className="src-client">{order.client}</span>
        {isOverdue && (
          <span className="src-badge src-badge-red">D+{Math.abs(days)}</span>
        )}
        {isDueSoon && (
          <span className="src-badge src-badge-orange">D-{days}</span>
        )}
      </div>
      <div className="src-spec">{displaySpec}</div>
      <div className="src-details">
        {dimensions && <span className="src-detail-item">{dimensions}</span>}
        {order.color && <span className="src-detail-item">{order.color}</span>}
      </div>
      <div className="src-footer">
        <span className={`src-status ${getStatusClass()}`}>
          {currentStepName} {getStatusLabel()}
        </span>
        {order.dueDate && (
          <span className="src-due">
            납기 {typeof order.dueDate === 'string' ? order.dueDate.slice(0, 10) : ''}
          </span>
        )}
      </div>
    </div>
  );
}
