import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { CollectiveClient } from './CollectiveClient.js';
import { startHostAppearance } from './host-appearance.js';
import '../../web/src/app/theme-tokens.css';
import '../../web/src/app/console-tokens.css';
import './styles/tokens.css';
import './styles/shell.css';
import './styles/shell-footer.css';
import './styles/channel.css';
import './styles/channel-message.css';
import './styles/message-reactions.css';
import './styles/collaboration.css';
import './styles/roadmap.css';
import './styles/roadmap-projections.css';
import './styles/roadmap-details.css';
import './styles/vote.css';
import './styles/binding-vote.css';
import './styles/composer.css';
import './styles/members.css';
import './styles/onboarding.css';
import './styles/first-entry.css';

const root = document.getElementById('collective-root');
if (!root) throw new Error('Collective client root is missing');

// Classic, light and cocoa until a valid host says otherwise; never the OS (web's dark tokens key on data-theme, which only a
// host's say-so sets). Started before the first render so the handshake can find the receiver already listening.
startHostAppearance();

createRoot(root).render(
  <StrictMode>
    <CollectiveClient />
  </StrictMode>,
);
