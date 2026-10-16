import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './src/App';
import {PrivacyPolicy} from './src/privacy/PrivacyPolicy';
import {ThemeProvider} from './src/theme';

const root = document.getElementById('root');
if (!root) {
  throw new Error('missing #root element');
}

// /privacy is the privacy policy as a page of its own (linked from app
// stores), readable without an account or unlocking anything.
const isPrivacyPage =
  window.location.pathname.replace(/\/+$/, '') === '/privacy';
if (isPrivacyPage) document.title = 'Privacy policy · Super Chat';

ReactDOM.createRoot(root).render(
  isPrivacyPage ? (
    <ThemeProvider>
      <PrivacyPolicy />
    </ThemeProvider>
  ) : (
    <App />
  ),
);
