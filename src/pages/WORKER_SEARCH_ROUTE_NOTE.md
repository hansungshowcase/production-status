Add to App.jsx:

```jsx
import WorkerSearchPage from './pages/WorkerSearchPage';
import WorkerUpdatePage from './pages/WorkerUpdatePage';

<Route path='/worker/search' element={<WorkerSearchPage />} />
<Route path='/worker/update/:id' element={<WorkerUpdatePage />} />
```
