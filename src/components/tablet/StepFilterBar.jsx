import { PROCESS_STEPS } from '../../constants';
import './StepFilterBar.css';

const STEPS = [
  { key: '전체', label: '전체' },
  ...PROCESS_STEPS.map((step) => ({ key: step, label: step })),
];

export default function StepFilterBar({ activeStep, onStepChange, stepCounts = {} }) {
  return (
    <div className="step-filter-bar">
      {STEPS.map((step) => {
        const count = step.key === '전체'
          ? Object.values(stepCounts).reduce((s, c) => s + c, 0)
          : (stepCounts[step.key] || 0);

        return (
          <button
            key={step.key}
            className={`step-filter-btn ${activeStep === step.key ? 'step-filter-btn--active' : ''}`}
            onClick={() => onStepChange(step.key)}
          >
            {step.label}
            <span className="step-filter-badge">{count}</span>
          </button>
        );
      })}
    </div>
  );
}
