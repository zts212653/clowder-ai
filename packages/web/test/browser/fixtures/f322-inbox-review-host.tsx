import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { createRoot } from 'react-dom/client';
import '../../../src/app/theme-tokens.css';
import '../../../src/app/console-tokens.css';
import '../../../src/app/console-controls.css';
import '../../../src/app/globals.css';
import '../../../src/app/shell-v2.css';
import { createApprovalSessions } from '../../../src/components/shell/mailbox/approval-sessions';
import { MailboxRow } from '../../../src/components/shell/mailbox/MailboxRow';
import { parseUnifiedAttentionRead } from '../../../src/components/shell/parse-unified-attention';
import { ShellDocumentLanguage } from '../../../src/components/shell/ShellDocumentLanguage';
import { ThemeProvider } from '../../../src/components/ThemeProvider';

declare global {
  interface Window {
    __F322_REVIEW_READ__: UnifiedAttentionReadV1;
  }
}

// Controlled server projection supplied by the original Node producer; no client count or source inference.
const read = parseUnifiedAttentionRead(window.__F322_REVIEW_READ__);
if (!read) throw new Error('The original owner projection could not be decoded');
const item = read.items.find((item) => item.decisionRef.startsWith('f309.content_review:'));
if (!item || read.identity.ownerUserId !== 'operator')
  throw new Error('The controlled current review was not projected');
const sessions = createApprovalSessions({
  readsStarted: () => 1,
  refetch: () => {},
  refreshStore: async () => {},
  storeItems: () => [],
  attempts: () => ({}),
  now: Date.now,
  latestRead: () => ({ result: { kind: 'ok', read }, generation: 1 }),
});
const root = document.getElementById('root');
if (!root) throw new Error('The mounted consumer needs its root element');
// Activate the original role aliases; this fixture does not claim to mount AppShell.
document.documentElement.dataset.shell = 'v2';
createRoot(root).render(
  <ThemeProvider>
    <ShellDocumentLanguage />
    <main
      style={{ width: 'min(430px, calc(100vw - 52px))', marginLeft: 52, padding: 16, background: 'var(--shell-frame)' }}
    >
      <ul className="list-none space-y-3 p-0">
        <MailboxRow
          item={item}
          rowKey={item.decisionRef}
          stale={false}
          expanded={false}
          hosted={{ ownerUserId: read.identity.ownerUserId, sessions }}
          onToggle={() => {}}
          onOpen={() => {}}
        />
      </ul>
    </main>
  </ThemeProvider>,
);
