import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const dataElement = document.getElementById('__INITIAL_DATA__');
let initialData = {};
try {
  initialData = JSON.parse(dataElement?.textContent || '{}');
} catch {
  // The app can recover by loading the public catalogue in the browser.
}

hydrateRoot(
  document.getElementById('root'),
  <React.StrictMode><App initialData={initialData} /></React.StrictMode>
);
