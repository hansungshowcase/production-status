Add to App.jsx:

```jsx
import SalesLoginPage from './pages/SalesLoginPage';
import SalesMyPage from './pages/SalesMyPage';

<Route path='/sales/login' element={<SalesLoginPage />} />
<Route path='/sales/my' element={<SalesMyPage />} />
```
