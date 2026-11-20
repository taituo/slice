import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MapView } from './MapView';
// Self-hosted fonts: no third-party font requests (a GDPR issue in the EU).
import '@fontsource/bagel-fat-one';
import '@fontsource-variable/instrument-sans';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(location.search).get('view') === 'map' ? <MapView /> : <App />}
  </StrictMode>,
);
