Add to App.jsx:

```jsx
import WorkerStationPage from './pages/WorkerStationPage';
import WorkerStationViewPage from './pages/WorkerStationViewPage';

<Route path='/worker/station' element={<WorkerStationPage />} />
<Route path='/worker/station/:stepName' element={<WorkerStationViewPage />} />
```
