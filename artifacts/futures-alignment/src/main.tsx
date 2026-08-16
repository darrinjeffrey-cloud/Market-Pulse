import { createRoot } from 'react-dom/client';
import { setAuthTokenGetter } from '@workspace/api-client-react';

import App from './App';
import { ErrorBoundary } from '@/components/error-boundary';
import { getStoredToken } from '@/lib/auth';

import './index.css';

// Wire the runtime token (from sessionStorage, never from the JS bundle)
// into the generated API client so all useQuery hooks and SSE probes
// send Authorization: Bearer <token>.
setAuthTokenGetter(() => getStoredToken());

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
