import { FEATURE_DEMOS } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STREAMING_TIP_CONTEXTS, REVIEW_STREAMING_TIP_CONTEXTS } from '../capability-tip-placement';

// The mocked inventory is one array that each test refills, because module mocks are cached across resets.
const shown = vi.hoisted(() => [] as { id: string; contexts: string[] }[]);
vi.mock('@/lib/capability-tips.seed.json', () => ({ default: shown }));
vi.mock('@/lib/feature-demo-trial', () => ({ openFeatureDemoTrial: vi.fn(async () => true) }));
vi.mock('@/lib/capabilityTipEvents', () => ({ recordCapabilityTipEvent: vi.fn(() => true) }));

const WAITING = new Set<string>([...DEFAULT_STREAMING_TIP_CONTEXTS, ...REVIEW_STREAMING_TIP_CONTEXTS]);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

// F331: attaching a film is one entry in feature-demos.json; every entry must play from its own tip.
describe('every film in feature-demos.json', () => {
  for (const [demoId, demo] of Object.entries(FEATURE_DEMOS)) {
    it(`${demoId} plays from ${demo.tipId} while a cat is working and tries its own prompt`, async () => {
      const { default: tips } = await vi.importActual<{ default: { id: string; contexts: string[] }[] }>(
        '@/lib/capability-tips.seed.json',
      );
      shown.splice(0, shown.length, ...tips.filter((tip) => tip.id === demo.tipId));
      vi.resetModules();
      const { CapabilityTipStrip } = await import('../CapabilityTipStrip');
      const { FeatureDemoHost } = await import('../FeatureDemoHost');
      const { openFeatureDemoTrial } = await import('@/lib/feature-demo-trial');
      const context = shown[0]?.contexts.find((value) => WAITING.has(value));
      expect(context).toBeDefined();
      await act(async () =>
        root.render(
          <>
            <CapabilityTipStrip
              surface="pending_bubble"
              contexts={[context as (typeof DEFAULT_STREAMING_TIP_CONTEXTS)[number]]}
              firstDelayMs={0}
            />
            <FeatureDemoHost />
          </>,
        ),
      );
      act(() => container.querySelector<HTMLButtonElement>('[data-testid="capability-tip-watch-demo"]')?.click());
      expect(document.querySelector('video')?.getAttribute('src')).toBe(demo.src);
      expect(document.body.textContent).toContain(demo.title);
      const tryButton = [...document.querySelectorAll('button')].find((node) => node.textContent === '立即试用');
      await act(async () => tryButton?.click());
      expect(openFeatureDemoTrial).toHaveBeenCalledWith(demo.tryPrompt, expect.any(AbortSignal));
    });
  }
});
