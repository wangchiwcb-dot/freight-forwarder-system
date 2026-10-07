import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App';
import './styles/global.css';

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5 * 60 * 1000, retry: 1 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
    </HashRouter>
  </StrictMode>,
);
