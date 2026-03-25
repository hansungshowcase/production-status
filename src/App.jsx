import { lazy, Suspense, useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import OfflineBanner from './components/common/OfflineBanner';
import InstallPrompt from './components/common/InstallPrompt';
import PageLoader from './components/common/PageLoader';
import SplashScreen from './components/common/SplashScreen';
import ChunkErrorBoundary from './components/common/ChunkErrorBoundary';

const HomePage = lazy(() => import('./pages/HomePage'));
const WorkerPage = lazy(() => import('./pages/WorkerPage'));
const SalesPage = lazy(() => import('./pages/SalesPage'));
const TabletWorkerPage = lazy(() => import('./pages/TabletWorkerPage'));
const AdminPage = lazy(() => import('./pages/AdminPage'));
const WorkerSearchPage = lazy(() => import('./pages/WorkerSearchPage'));
const WorkerUpdatePage = lazy(() => import('./pages/WorkerUpdatePage'));
const WorkerSelectPage = lazy(() => import('./pages/WorkerSelectPage'));
const WorkerStationPage = lazy(() => import('./pages/WorkerStationPage'));
const WorkerStationViewPage = lazy(() => import('./pages/WorkerStationViewPage'));
const OrderEntryPage = lazy(() => import('./pages/OrderEntryPage'));
const SalesLoginPage = lazy(() => import('./pages/SalesLoginPage'));
const SalesMyPage = lazy(() => import('./pages/SalesMyPage'));

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function MobileHeaderBar() {
  const location = useLocation();
  const isWorker = location.pathname.startsWith('/worker');

  if (!isWorker) return null;

  return (
    <div className="mobile-header-bar mobile-header-bar--visible">
      한성쇼케이스 생산 현황
    </div>
  );
}

function AnimatedPage({ children }) {
  const location = useLocation();

  return (
    <div key={location.pathname} className="page-transition-enter-active" style={{
      animation: 'fadeInUp 0.3s cubic-bezier(0.32, 0.72, 0, 1) both',
    }}>
      {children}
    </div>
  );
}

function AppRoutes() {
  return (
    <AnimatedPage>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/worker" element={<WorkerPage />} />
        <Route path="/worker/select" element={<WorkerSelectPage />} />
        <Route path="/worker/search" element={<WorkerSearchPage />} />
        <Route path="/worker/update/:id" element={<WorkerUpdatePage />} />
        <Route path="/worker/station" element={<WorkerStationPage />} />
        <Route path="/worker/station/:stepName" element={<WorkerStationViewPage />} />
        <Route path="/tablet" element={<TabletWorkerPage />} />
        <Route path="/orders/new" element={<OrderEntryPage />} />
        <Route path="/sales" element={<SalesPage />} />
        <Route path="/sales/login" element={<SalesLoginPage />} />
        <Route path="/sales/my" element={<SalesMyPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AnimatedPage>
  );
}

export default function App() {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [appReady, setAppReady] = useState(false);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Signal app ready after mount
    const timer = setTimeout(() => {
      setAppReady(true);
      window.dispatchEvent(new Event('app-ready'));
    }, 100);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearTimeout(timer);
    };
  }, []);

  return (
    <BrowserRouter>
      <ScrollToTop />
      {!appReady && <SplashScreen />}
      <MobileHeaderBar />
      <OfflineBanner show={isOffline} />
      <InstallPrompt />
      <ChunkErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <AppRoutes />
        </Suspense>
      </ChunkErrorBoundary>
      <footer className="app-footer-brand">잘 만든 제품은 고객의 삶을 바꿉니다.</footer>
    </BrowserRouter>
  );
}
