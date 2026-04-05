import { BrowserRouter, Route, Routes } from 'react-router-dom';

import { Layout } from '@/components/Layout';
import { ThemeProvider } from '@/hooks/use-theme';
import { Dashboard } from '@/pages/Dashboard';
import { ReviewPage } from '@/pages/ReviewPage';

export function App(): React.ReactElement {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pr/:id" element={<ReviewPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
