import React from 'react';
import { renderToString } from 'react-dom/server';
import App from './App.jsx';

export function render(initialData) {
  return renderToString(
    <React.StrictMode><App initialData={initialData} /></React.StrictMode>
  );
}
