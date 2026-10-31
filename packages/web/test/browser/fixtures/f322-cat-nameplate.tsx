import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ChatMessage } from '@/components/ChatMessage';
import { CoCreatorHueInjector } from '@/components/CoCreatorHueInjector';
import { OklchTuner } from '@/components/dev/OklchTuner';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '@/components/dev/oklch-tuner-engine';
import { MessageViewportBoundary } from '@/components/MessageViewportBoundary';
import { ThemeApplier } from '@/components/ThemeApplier';
import { ThemeProvider } from '@/components/ThemeProvider';
import { useCatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { getActiveTheme, useThemeStore } from '@/stores/themeStore';
import { ActualProbe, themeApplied } from './f322-theme-applied';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 B segment 1 probe fixture: the REAL ChatMessage, MessageBubble, CatNameplate, CatAvatar, CatHueInjector,
 * CoCreatorHueInjector and the REAL theme pipeline (theme store -> `ThemeApplier` -> `applyThemeCSS`, resolved against the
 * cats and human colour that really exist) on a column the width of the reading column or the Studio chat bar. Only the
 * registry request (`/api/cats`) and the avatar files are answered by the journey; nothing talks to a service.
 *
 * `window.__nameplate.applyTheme` changes the theme the way the Tuner does: through the real theme store, so the real
 * `ThemeApplier` applies it. `applied()` resolves once what is on the page is that theme, resolved against the catalogue.
 */
primeCoCreatorConfigCache({
  name: 'Fixture Owner',
  aliases: [],
  mentionPatterns: ['@fixture-owner'],
  color: { primary: '#555555', secondary: '#eeeeee' },
});
useChatStore.setState({ currentThreadId: 'thread-nameplate' });

const T0 = Date.UTC(2026, 9, 1, 20, 41);
const LONG_NAME_CAT_ID = 'glm52';

const messages: ChatMessageData[] = [
  {
    from: { kind: 'user', userId: 'default-user' },
    id: 'm-user',
    type: 'user',
    content: '三版封面，暖一点。',
    timestamp: T0 - 60_000,
  },
  {
    from: { kind: 'agent', catId: 'opus' },
    id: 'm-opus',
    type: 'assistant',
    catId: 'opus',
    content: '好，我先生成三版，生成图片要一会儿。',
    timestamp: T0,
  },
  {
    from: { kind: 'agent', catId: 'codex' },
    id: 'm-codex',
    type: 'assistant',
    catId: 'codex',
    content:
      '改了登录页的配色，截图在下面。这一段故意写长一点，用来看正文在窄栏里怎么换行，以及它的左边是不是和名片牌的左边在同一条线上。',
    timestamp: T0 + 60_000,
  },
  {
    from: { kind: 'agent', catId: 'gemini' },
    id: 'm-gemini',
    type: 'assistant',
    catId: 'gemini',
    content:
      '```ts\nconst veryLongLineOfCode = renderTheWholeCoverGalleryWithAllThreeVariantsAndTheirCaptions(options);\n```\n\n代码块要留在栏里，不能把整条消息撑出去。',
    timestamp: T0 + 120_000,
  },
  {
    from: { kind: 'agent', catId: LONG_NAME_CAT_ID },
    id: 'm-streaming',
    type: 'assistant',
    catId: LONG_NAME_CAT_ID,
    content: '正在对比两版的色阶……',
    timestamp: T0 + 180_000,
    isStreaming: true,
  },
];

function params(base: 'light' | 'dark', overrides?: (p: TunerState) => void): TunerState {
  const next = structuredClone(base === 'light' ? INIT_LIGHT : INIT_DARK);
  overrides?.(next);
  return next;
}

/** What the Tuner can save for the cat-name role and the plate's surface step, on top of a built-in theme. */
export interface SavedThemeConfig {
  base: 'light' | 'dark';
  surfaceL: number;
  surfaceCmul: number;
  nameH: number;
  nameL: number;
  nameC: number;
  /** The page layers of that mode, when the saved theme moves them (a "page base" the Tuner allows). */
  elev?: { sunken: number; base: number; elevated: number; canvas: number };
}

declare global {
  interface Window {
    __nameplate: {
      applyTheme: (base: 'light' | 'dark', variant?: 'default' | 'tuned') => void;
      /** Saves a custom theme through the real theme store (the Tuner's save path), as "自定义1" cloned from the base. */
      saveCustomTheme: (config: SavedThemeConfig) => void;
      /** Publishes a co-creator config (or none) through the real cache the Hub editor writes, as the product does. */
      setConfig: (color: { primary: string; secondary: string } | null) => void;
      /** Resolves once the page shows the store's active theme, resolved against the catalogue; rejects after 4s. */
      applied: () => Promise<void>;
    };
  }
}

window.__nameplate = {
  applyTheme(base, variant = 'default') {
    const store = useThemeStore.getState();
    if (variant !== 'tuned') {
      store.setActive(base);
      return;
    }
    // A Tuner-adjusted theme: richer surfaces and a name role that moves with the user's slider.
    if (!store.createCustom('Tuned', base)) throw new Error('could not create the tuned theme');
    useThemeStore.getState().updateParams(
      params(base, (p) => {
        p.surfaceChroma = 2.2;
        const side = p[base];
        side.surface = { L: base === 'light' ? 0.78 : 0.36, Cmul: base === 'light' ? 0.9 : 0.5 };
      }),
    );
  },
  saveCustomTheme(config) {
    const store = useThemeStore.getState();
    const id = store.createCustom('自定义1', config.base);
    if (!id) throw new Error('could not create the custom theme');
    const active = getActiveTheme(useThemeStore.getState());
    const next = structuredClone(active.params);
    next[config.base].surface = { L: config.surfaceL, Cmul: config.surfaceCmul };
    if (config.elev) next[config.base].elev = config.elev;
    next.catTextH = config.nameH;
    next.catTextC = config.nameC;
    if (config.base === 'light') next.catTextLightL = config.nameL;
    else next.catTextDarkL = config.nameL;
    useThemeStore.getState().updateParams(next);
  },
  setConfig(color) {
    primeCoCreatorConfigCache({
      name: 'Fixture Owner',
      aliases: [],
      mentionPatterns: ['@fixture-owner'],
      ...(color ? { color } : {}),
    });
  },
  applied: themeApplied,
};

function Thread() {
  const { getCatById } = useCatData();
  const params = new URLSearchParams(window.location.search);
  const width = Number(params.get('w') ?? '720');
  const deferredProbe = params.has('deferred');
  return (
    <div
      data-testid="column"
      style={{ width, padding: '16px 20px', background: 'var(--shell-work)', color: 'var(--cafe-text)' }}
    >
      {deferredProbe ? (
        <div data-testid="deferred-placeholder-stack">
          <MessageViewportBoundary messageId="deferred-probe-a">
            <div>deferred A</div>
          </MessageViewportBoundary>
          <MessageViewportBoundary messageId="deferred-probe-b">
            <div>deferred B</div>
          </MessageViewportBoundary>
        </div>
      ) : null}
      {/* Each row sits in the production row boundary (content-visibility:auto paint-contains it): the face hangs above the
          plate, so a row that did not leave it room would lose the top of the face, and only on a real list. */}
      {messages.map((message) => (
        <MessageViewportBoundary key={message.id}>
          <ChatMessage
            message={message}
            threadId="thread-nameplate"
            getCatById={getCatById}
            onEditCat={() => undefined}
          />
        </MessageViewportBoundary>
      ))}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing nameplate fixture root');
// What AppShell does: only the new presentation marks <html>. A classic page must not carry the marker, or the page
// behind the messages would be the new shell's, not the classic one's.
if (window.localStorage.getItem('cat-cafe:shell-presentation') === 'v2') {
  document.documentElement.setAttribute('data-shell', 'v2');
}
createRoot(root).render(
  <ThemeProvider>
    <CatHueInjector />
    <CoCreatorHueInjector />
    <ThemeApplier />
    <ActualProbe />
    <Thread />
    {/* The real Tuner panel beside the thread (?tuner=1): the hint it shows is what the journey reads. */}
    {new URLSearchParams(window.location.search).has('tuner') ? <OklchTuner onClose={() => undefined} /> : null}
  </ThemeProvider>,
);
