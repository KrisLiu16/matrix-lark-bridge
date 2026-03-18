import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initLocale } from './i18n';
import './stores/theme-store'; // Initialize theme before first paint
import './index.css';

// Detect system locale before rendering
initLocale().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
