import { createRoot } from 'react-dom/client';
import { CatHueInjector } from '@/components/CatHueInjector';
import { ChatMessage } from '@/components/ChatMessage';
import { INIT_DARK, INIT_LIGHT, type TunerState } from '@/components/dev/oklch-tuner-engine';
import { useCatData } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { applyThemeCSS, getActiveTheme, useThemeStore } from '@/stores/themeStore';
import '@/app/cat-persona-tokens.css';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

/**
 * F322 B segment 1 probe fixture: the REAL ChatMessage, MessageBubble, CatNameplate, CatAvatar, CatHueInjector and
 * the real theme CSS builder (`applyThemeCSS`) on a column the width of the reading column or the Studio chat bar.
 * Only the registry request (`/api/cats`) and the avatar files are answered by the journey; nothing talks to a service.
 *
 * `window.__nameplate.applyTheme` is how the journey changes the theme the way the Tuner does: real tuner params through
 * the real CSS builder, and the base mode on <html>.
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
    id: 'm-user',
    type: 'user',
    content: '三版封面，暖一点。',
    timestamp: T0 - 60_000,
  },
  { id: 'm-opus', type: 'assistant', catId: 'opus', content: '好，我先生成三版，生成图片要一会儿。', timestamp: T0 },
  {
    id: 'm-codex',
    type: 'assistant',
    catId: 'codex',
    content:
      '改了登录页的配色，截图在下面。这一段故意写长一点，用来看正文在窄栏里怎么换行，以及它的左边是不是和名片牌的左边在同一条线上。',
    timestamp: T0 + 60_000,
  },
  {
    id: 'm-gemini',
    type: 'assistant',
    catId: 'gemini',
    content:
      '```ts\nconst veryLongLineOfCode = renderTheWholeCoverGalleryWithAllThreeVariantsAndTheirCaptions(options);\n```\n\n代码块要留在栏里，不能把整条消息撑出去。',
    timestamp: T0 + 120_000,
  },
  {
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
}

declare global {
  interface Window {
    __nameplate: {
      applyTheme: (base: 'light' | 'dark', variant?: 'default' | 'tuned') => void;
      /** Saves a custom theme through the real theme store (the Tuner's save path), as "自定义1" cloned from the base. */
      saveCustomTheme: (config: SavedThemeConfig) => void;
      /** What ThemeApplier does on boot: the active theme from the real store, its base on <html>, its CSS injected. */
      restoreSavedTheme: () => void;
    };
  }
}

window.__nameplate = {
  applyTheme(base, variant = 'default') {
    document.documentElement.setAttribute('data-theme', base);
    applyThemeCSS(
      params(base, (p) => {
        if (variant !== 'tuned') return;
        // A Tuner-adjusted theme: richer surfaces and a name role that moves with the user's slider.
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
    next.catTextH = config.nameH;
    next.catTextC = config.nameC;
    if (config.base === 'light') next.catTextLightL = config.nameL;
    else next.catTextDarkL = config.nameL;
    useThemeStore.getState().updateParams(next);
  },
  restoreSavedTheme() {
    const active = getActiveTheme(useThemeStore.getState());
    document.documentElement.setAttribute('data-theme', active.base);
    applyThemeCSS(active.params);
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
          threadId="thread-nameplate"
          getCatById={getCatById}
          onEditCat={() => undefined}
        />
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
// A theme saved by an earlier visit (the real store reads it back from localStorage) wins over the plain default.
if (window.localStorage.getItem('cat-cafe:themes')) window.__nameplate.restoreSavedTheme();
else window.__nameplate.applyTheme('light');
createRoot(root).render(
  <>
    <CatHueInjector />
    <Thread />
  </>,
);
