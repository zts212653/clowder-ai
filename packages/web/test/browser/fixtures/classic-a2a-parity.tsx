import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppendedInputReceipts } from '@/components/AppendedInputReceipts';
import { ChatInputAddMenu } from '@/components/ChatInputAddMenu';
import { ReplyPill } from '@/components/ReplyPill';
import { useShellPresentation, writeShellPresentation } from '@/components/shell/shell-presentation';
import type { CatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage } from '@/stores/chat-types';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

// Real controls, overflow measurement, theme CSS and navigation. Only data/preference transport is a fixture.
primeCoCreatorConfigCache({
  name: 'lang',
  aliases: [],
  mentionPatterns: [],
  color: { primary: '#6C5543', secondary: '#E9DCCF' },
});
const getCatById = (id: string) =>
  id === 'opus' ? ({ id, displayName: 'Astra', color: { primary: '#8B5CF6' } } as CatData) : undefined;
const content = '先看消息来源，再确认读取时间。'.repeat(35) + ' END';
const from = { kind: 'agent', catId: 'opus' } as const;
const inputs: ChatMessage[] = [
  { id: 'human', type: 'user', from: { kind: 'user', userId: 'owner' }, content, timestamp: 2000 },
  { id: 'member', type: 'assistant', from, content, timestamp: 2100 },
  {
    id: 'external',
    type: 'user',
    from: { kind: 'external', connectorId: 'unknown' },
    content: 'unknown source',
    timestamp: 2200,
  },
];
const response: ChatMessage = {
  from: { kind: 'agent', catId: 'codex' },
  id: 'response',
  type: 'assistant',
  content: '回执示例',
  timestamp: 1000,
  lifecycle: {
    kind: 'response',
    orderKey: '1',
    invocationId: 'inv',
    targetId: 'codex',
    inputEntryIds: ['initial', 'human', 'member', 'external'],
    inputMessageIds: ['initial', 'human', 'member', 'external'],
    status: 'completed',
    startedAt: 1000,
    completedAt: 3000,
  },
};

function Proof() {
  const presentation = useShellPresentation();
  const [open, setOpen] = useState(false);
  const [effective, setEffective] = useState<'next_work' | 'continue_current'>('next_work');
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4 text-cafe-primary">
      <div className="flex gap-4">
        <button
          onClick={() => {
            writeShellPresentation(presentation === 'classic' ? 'v2' : 'classic');
            document.documentElement.toggleAttribute('data-shell', false);
            if (presentation === 'classic') document.documentElement.setAttribute('data-shell', 'v2');
          }}
        >
          switch shell
        </button>
        <button
          onClick={() =>
            document.documentElement.setAttribute(
              'data-theme',
              document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark',
            )
          }
        >
          switch theme
        </button>
      </div>
      <article data-message-id="source-1" className="rounded-lg bg-cafe-surface p-3">
        原文
      </article>
      <div data-testid="long-pill">
        <ReplyPill replyPreview={{ from, senderCatId: 'opus', content }} replyToId="source-1" getCatById={getCatById} />
      </div>
      <div data-testid="short-pill">
        <ReplyPill
          replyPreview={{ from, senderCatId: 'opus', content: '短文' }}
          replyToId="source-1"
          getCatById={getCatById}
        />
      </div>
      <div data-testid="deleted-pill">
        <ReplyPill
          replyPreview={{ from, senderCatId: 'opus', content: '', deleted: true }}
          replyToId="source-1"
          getCatById={getCatById}
        />
      </div>
      <AppendedInputReceipts response={response} timelineMessages={inputs} getCatById={getCatById} />
      <div className="mt-auto pt-96">
        <button ref={trigger} aria-label="添加内容" onClick={() => setOpen(!open)} className="h-8 w-8">
          +
        </button>
      </div>
      {open && (
        <ChatInputAddMenu
          presentation={presentation}
          hasActiveInvocation
          triggerRef={trigger}
          messageDisposition={{
            snapshot: { productDefault: 'next_work', thread: null, global: null, effective, source: 'product' },
            effective,
            source: 'product',
            oneShot: effective,
            setOneShot: (value) => setEffective(value),
            clearOneShot: () => setEffective('next_work'),
            loading: false,
            error: null,
            setPreference: async () => {
              throw new Error('One-shot choices must not save a preference');
            },
          }}
          onClose={() => setOpen(false)}
          onAddContext={() => {}}
          onAttach={() => {}}
          onWhisperToggle={() => {}}
        />
      )}
    </main>
  );
}
document.documentElement.style.setProperty('--color-cocreator-primary', '#D16A45');
document.documentElement.style.setProperty('--color-opus-primary', '#5176B8');
createRoot(document.getElementById('root')!).render(<Proof />);
