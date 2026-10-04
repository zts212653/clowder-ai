import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ChatMessage } from '@/components/ChatMessage';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '@/components/dev/oklch-tuner-engine';
import { HubCoCreatorOverviewCard } from '@/components/HubMemberOverviewCard';
import { ReplyPill } from '@/components/ReplyPill';
import { ReplyPreviewBar } from '@/components/ReplyPreviewBar';
import { useCatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache, useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { applyThemeCSS } from '@/stores/themeStore';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 B segment 1 (human message) probe fixture: the REAL ChatMessage, MessageBubble, CoCreatorHueInjector and the real
 * theme builder (`applyThemeCSS`) on a column the width of the reading column or the Studio chat bar. The config the
 * human colour comes from is set through the real co-creator cache (`primeCoCreatorConfigCache`), the way the Hub editor
 * publishes it. Nothing talks to a service.
 *
 * The cats that answer in between come from the registry request (`/api/cats`), so the conversation reads as it does in the
 * product: your blocks on the right, the cats' nameplates on the left.
 *
 * `window.__human.applyTheme` changes the theme the way the Tuner does (real tuner params through the real CSS builder, and
 * the base mode on <html>); `window.__human.setColor` publishes a config with or without a colour.
 */
useChatStore.setState({ currentThreadId: 'thread-human' });

// Reads as 20:41 on 10/01 in the journey's browser (Asia/Shanghai).
const T0 = Date.UTC(2026, 9, 1, 12, 41);
const minute = 60_000;

const SHORT = '三版封面，暖一点。';
const LONG =
  '这一段故意写得很长，用来看一条很长的话会不会撑满阅读栏：它应该最多占到栏宽的八成，左边留出空来，字在气泡里左对齐，换行以后每一行的左边在同一条线上。再多写几句让它一定换行，免得在宽栏里一行就放下了。';
const CODE =
  '看这段：\n\n```ts\nconst aVeryLongLineOfCodeThatIsMuchWiderThanTheBlockCanBe = renderTheWholeCoverGallery(options, more, args);\n```';

const messages: ChatMessageData[] = [
  { id: 'h-short', type: 'user', content: SHORT, timestamp: T0 },
  { id: 'c-1', type: 'assistant', catId: 'opus', content: '好，我先生成三版。', timestamp: T0 + minute },
  { id: 'h-run-a', type: 'user', content: '再来一版。', timestamp: T0 + 2 * minute },
  { id: 'h-run-b', type: 'user', content: LONG, timestamp: T0 + 3 * minute },
  { id: 'h-code', type: 'user', content: CODE, timestamp: T0 + 4 * minute },
  { id: 'c-2', type: 'assistant', catId: 'codex', content: '收到。', timestamp: T0 + 5 * minute },
  {
    id: 'h-whisper',
    type: 'user',
    content: '悄悄告诉你一件事。',
    timestamp: T0 + 6 * minute,
    visibility: 'whisper',
    whisperTo: ['codex'],
  },
];

function params(base: 'light' | 'dark', overrides?: (p: TunerState) => void): TunerState {
  const next = structuredClone(base === 'light' ? INIT_LIGHT : INIT_DARK);
  overrides?.(next);
  return next;
}

type Color = { primary: string; secondary: string };

declare global {
  interface Window {
    __human: {
      applyTheme: (base: 'light' | 'dark', variant?: 'default' | 'tuned') => void;
      setColor: (color: Color | null) => void;
    };
  }
}

window.__human = {
  applyTheme(base, variant = 'default') {
    document.documentElement.setAttribute('data-theme', base);
    applyThemeCSS(
      params(base, (p) => {
        if (variant !== 'tuned') return;
        // A Tuner-adjusted theme: richer surfaces, and a surface step that moves with the user's slider.
        p.surfaceChroma = 2.2;
        p[base].surface = { L: base === 'light' ? 0.78 : 0.36, Cmul: base === 'light' ? 0.9 : 0.5 };
      }),
    );
  },
  setColor(color) {
    primeCoCreatorConfigCache({
      name: 'You',
      aliases: [],
      mentionPatterns: ['@co-creator'],
      ...(color ? { color } : {}),
    });
  },
};

function Thread() {
  const { getCatById } = useCatData();
  const width = Number(new URLSearchParams(window.location.search).get('w') ?? '720');
  return (
    <div
      data-testid="column"
      style={{ width, padding: '16px 20px', background: 'var(--shell-work)', color: 'var(--cafe-text)' }}
    >
      {messages.map((message) => (
        <ChatMessage
          key={message.id}
          message={message}
          threadId="thread-human"
          timelineMessages={messages}
          getCatById={getCatById}
          onEditCoCreator={() => undefined}
        />
      ))}
    </div>
  );
}

/**
 * The other places that write in the human's identity colour, so the probe can measure their text: the reply pill in a
 * message, the reply bar over the composer, the owner card in the Hub (its avatar initials and its mention line), and the
 * lineage focus ring over each page layer it can appear on. `?consumers=1` renders these instead of the thread.
 */
function Consumers() {
  const { cats, getCatById } = useCatData();
  const coCreator = useCoCreatorConfig();
  // The message list's layers, a cat's own bubble and the human block (a focused message sits on the list; a receipt or
  // absorption dock sits inside the bubble of the message it belongs to), and the sunken layer for the record.
  const layers = [
    '--cafe-surface-canvas',
    '--cafe-surface',
    '--cafe-surface-elevated',
    '--color-opus-surface',
    '--color-codex-surface',
    '--color-cocreator-surface',
    '--cafe-surface-sunken',
  ];
  return (
    <div data-testid="consumers" style={{ width: 720, padding: '16px 20px', background: 'var(--shell-work)' }}>
      <div data-consumer="reply-pill" style={{ padding: 12 }}>
        <ReplyPill
          replyPreview={{ senderCatId: null, content: '三版封面，暖一点。' }}
          replyToId="h-short"
          getCatById={getCatById}
        />
      </div>
      <div data-consumer="reply-bar" style={{ padding: 12 }}>
        <ReplyPreviewBar
          replyToMessage={{ id: 'h-short', senderCatId: null, content: '三版封面，暖一点。' }}
          cats={cats}
          onClear={() => undefined}
        />
      </div>
      <div data-consumer="owner-card" style={{ padding: 12 }}>
        <HubCoCreatorOverviewCard coCreator={coCreator} />
      </div>
      {layers.map((layer) => (
        <div key={layer} data-layer={layer} style={{ background: `var(${layer})`, padding: 20 }}>
          <div data-lineage-focus="true" style={{ height: 24 }} />
        </div>
      ))}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing human-message fixture root');
// What AppShell does: the new presentation marks <html>; the classic UI does not.
if (window.localStorage.getItem('cat-cafe:shell-presentation') === 'v2') {
  document.documentElement.setAttribute('data-shell', 'v2');
}
window.__human.applyTheme('light');
createRoot(root).render(
  <>
    <CatHueInjector />
    <CoCreatorHueInjector />
    {new URLSearchParams(window.location.search).has('consumers') ? <Consumers /> : <Thread />}
  </>,
);
