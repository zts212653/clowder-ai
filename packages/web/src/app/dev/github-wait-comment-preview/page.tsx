'use client';

import { ConnectorBubble } from '@/components/ConnectorBubble';
import type { ChatMessage } from '@/stores/chat-types';

const message: ChatMessage = {
  id: 'github-wait-comment-preview',
  type: 'connector',
  content: [
    '🔔 **PR wait satisfied** — zts212653/clowder-ai#1420',
    '',
    '- conversation comment #5564124487 by chatgpt-codex-connector[bot] — [UNTRUSTED EXTERNAL CONTENT]',
    "> Codex Review: Didn't find any major issues. Another round soon, please!",
    '>',
    '> **Reviewed commit:** `96be44ee86`',
    '',
    'Matched reason: `matched`',
    'Next: 核对 exact-HEAD Codex review、CI、maintainer 评论与审批。',
    '_Tracking re-armed for the next event._',
  ].join('\n'),
  source: {
    connector: 'github-wait',
    label: 'GitHub Wait',
    icon: 'github',
    url: 'https://github.com/zts212653/clowder-ai/pull/1420',
  },
  timestamp: Date.UTC(2026, 8, 7, 2, 18),
};

export default function GitHubWaitCommentPreview() {
  return (
    <main
      data-github-wait-preview="ready"
      className="mx-auto min-h-screen max-w-6xl bg-cafe-bg px-8 py-12 text-cafe-primary"
    >
      <h1 className="mb-6 text-lg font-semibold">GitHub wait comment rendering</h1>
      <ConnectorBubble message={message} />
    </main>
  );
}
