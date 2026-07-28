import { createRoot } from 'react-dom/client';

import App from './App';

import './index.css';

// Offline app shell: the generated service worker precaches the SPA so the
// merchant Scan Perk screen keeps loading with no connectivity. Registration
// is a no-op in dev (SW is only generated at build time).
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(<App />);
