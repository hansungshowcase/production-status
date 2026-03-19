import '../../styles/transitions.css';

export default function PageLoader() {
  return (
    <div className="page-loader">
      <div style={{ width: '100%', maxWidth: 480, padding: '16px 20px' }}>
        {/* Header skeleton */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div className="skeleton" style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 18, width: '50%', marginBottom: 6 }} />
            <div className="skeleton" style={{ height: 12, width: '30%' }} />
          </div>
          <div className="skeleton" style={{ width: 34, height: 34, borderRadius: '50%', flexShrink: 0 }} />
        </div>
        {/* Card skeletons */}
        <div className="skeleton" style={{ height: 140, marginBottom: 14, borderRadius: 16 }} />
        <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
          <div className="skeleton" style={{ height: 100, flex: 1, borderRadius: 16 }} />
          <div className="skeleton" style={{ height: 100, flex: 1, borderRadius: 16 }} />
        </div>
        <div className="skeleton" style={{ height: 100, marginBottom: 14, borderRadius: 16 }} />
        <div className="skeleton" style={{ height: 80, borderRadius: 16 }} />
      </div>
    </div>
  );
}
