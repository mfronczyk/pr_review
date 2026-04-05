import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { Layout } from '@/components/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { ReviewPage } from '@/pages/ReviewPage';

export function App(): React.ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/pr/:id" element={<ReviewPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
