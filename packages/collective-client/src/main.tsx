import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { CollectiveClient } from './CollectiveClient.js';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/channel.css';
import './styles/channel-message.css';
import './styles/onboarding.css';

const root = document.getElementById('collective-root');
if (!root) throw new Error('Collective client root is missing');

createRoot(root).render(
  <StrictMode>
    <CollectiveClient />
  </StrictMode>,
);
