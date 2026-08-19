import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { clampProgressCardGeometry } from '../DesktopUpdateProgressCard';
import { DesktopUpdatePrompt } from '../DesktopUpdatePrompt';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('DesktopUpdatePrompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let promptListener: ((prompt: DesktopUpdatePromptPayload) => void) | undefined;
  let unsubscribe: Mock<() => void>;
  let unsubscribeProgress: Mock<() => void>;
  let ready: Mock<() => Promise<DesktopUpdatePromptPayload | null>>;
  let sendAction: Mock<(action: DesktopUpdatePromptAction, version: string) => void>;
  let progressListener: ((progress: DesktopUpdateProgressPayload | null) => void) | undefined;
  let underlyingButton: HTMLButtonElement;

  beforeEach(() => {
    underlyingButton = document.createElement('button');
    underlyingButton.textContent = 'Underlying action';
    document.body.appendChild(underlyingButton);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    unsubscribe = vi.fn();
    unsubscribeProgress = vi.fn();
    ready = vi.fn(async () => null);
    sendAction = vi.fn();
    window.desktopBridge = {
      onStatus: () => () => {},
      onUpdatePrompt: (listener) => {
        promptListener = listener;
        return unsubscribe;
      },
      onUpdateProgress: (listener) => {
        progressListener = listener;
        return unsubscribeProgress;
      },
      updatePromptReady: ready,
      sendUpdatePromptAction: sendAction,
      getUpdateSettings: vi.fn(async () => ({ autoCheck: true })),
      setUpdateAutoCheck: vi.fn(async (enabled) => ({ autoCheck: enabled })),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    underlyingButton.remove();
    delete window.desktopBridge;
    vi.clearAllMocks();
  });

  function renderPrompt() {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({
        kind: 'available',
        version: '0.12.0',
        currentVersion: '0.10.0',
        platform: 'windows',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
        releaseNotes:
          '## Highlights\n\n- Faster startup\n- Better Windows updater\n\n[Migration guide](https://github.com/zts212653/clowder-ai)\n\n![Remote screenshot](https://example.com/tracker.png)',
      } as DesktopUpdatePromptPayload);
    });
  }

  it('requests pending-prompt replay and cleans up its subscription', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    expect(ready).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });

  it('hydrates a prompt returned by the trusted renderer-readiness invoke', async () => {
    ready.mockResolvedValueOnce({ kind: 'up-to-date', version: '0.12.0' } as DesktopUpdatePromptPayload);

    await act(async () => root.render(<DesktopUpdatePrompt />));

    expect(container.textContent).toContain("You're up to date");
    expect(container.textContent).toContain('Clowder AI v0.12.0');
  });

  it('shows an in-app up-to-date result and dismisses it explicitly', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({ kind: 'up-to-date', version: '0.12.0' } as DesktopUpdatePromptPayload);
    });

    expect(container.textContent).toContain("You're up to date");
    expect(container.textContent).toContain('Clowder AI v0.12.0');
    expect(container.textContent).toContain('No update is required.');
    const ok = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'OK');

    act(() => ok?.click());

    expect(sendAction).toHaveBeenCalledWith('dismiss' as DesktopUpdatePromptAction, '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows an in-app failed result with the canonical Releases path', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({
        kind: 'check-failed',
        version: '0.12.0-rc.1105.7',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases',
      } as DesktopUpdatePromptPayload);
    });

    expect(container.textContent).toContain("Couldn't check for updates");
    expect(container.textContent).toContain('You can view the latest releases on GitHub.');
    const releases = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'View Releases',
    );
    const ok = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'OK');

    act(() => releases?.click());
    expect(sendAction).toHaveBeenCalledWith('open-release', '0.12.0-rc.1105.7');
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    act(() => ok?.click());
    expect(sendAction).toHaveBeenCalledWith('dismiss' as DesktopUpdatePromptAction, '0.12.0-rc.1105.7');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('recommends only the selected Windows installer and links the exact release', () => {
    renderPrompt();

    expect(container.querySelector('[role="dialog"]')?.className).toContain('max-w-2xl');
    expect(container.querySelector('[role="dialog"]')?.className).toContain('max-h-[calc(100vh-2rem)]');
    expect(container.textContent).toContain('Recommended for Windows');
    expect(container.textContent).toContain('ClowderAI-Setup-0.12.0.exe');
    expect(container.textContent).not.toContain('.dmg');
    expect(container.textContent).toContain('Release notes');
    expect(container.textContent).toContain('Faster startup');
    expect(container.querySelector('[data-testid="desktop-update-release-notes"]')?.className).toContain(
      'overflow-y-auto',
    );
    const releaseNotesLink = Array.from(
      container.querySelectorAll('[data-testid="desktop-update-release-notes"] a'),
    ).find((link) => link.textContent === 'Migration guide');
    expect(releaseNotesLink?.getAttribute('target')).toBe('_blank');
    expect(releaseNotesLink?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.querySelector('[data-testid="desktop-update-release-notes"] img')).toBeNull();
    expect(container.textContent).toContain('Release image omitted: Remote screenshot');

    const eyebrow = container.querySelector('[data-testid="desktop-update-eyebrow"]');
    expect(eyebrow?.className).toContain('text-cafe-accent');
    expect(eyebrow?.className).not.toContain('text-semantic-info');

    const releaseLink = container.querySelector('[data-testid="desktop-update-release-link"]') as HTMLAnchorElement;
    expect(releaseLink.textContent).toBe('v0.12.0');
    expect(releaseLink.href).toBe('https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0');
    expect(releaseLink.className).toContain('console-inline-link');
    expect(releaseLink.className).not.toContain('text-semantic-info');

    const downloadButton = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Download Windows Setup',
    );
    expect(downloadButton?.className).toContain('console-button-primary');
    expect(downloadButton?.className).not.toContain('bg-semantic-info');

    act(() => releaseLink.click());
    expect(sendAction).toHaveBeenCalledWith('open-release', '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it('uses the shared dark-blue console link token instead of the teal status token', () => {
    const controls = readFileSync(path.join(process.cwd(), 'src/app/console-controls.css'), 'utf8');
    const inlineLinkRule = controls.match(/\.console-inline-link\s*\{([^}]+)\}/)?.[1] ?? '';

    expect(inlineLinkRule).toContain('var(--conn-blue-text)');
    expect(inlineLinkRule).not.toContain('var(--cafe-crosspost)');
  });

  it('recommends only the selected macOS architecture image', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({
        kind: 'available',
        version: '0.12.0',
        currentVersion: '0.10.0',
        platform: 'macos',
        assetName: 'ClowderAI-0.12.0-arm64.dmg',
        releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
        releaseNotes: '## Highlights\n\nNative macOS package.',
      } as DesktopUpdatePromptPayload);
    });

    expect(container.textContent).toContain('Recommended for macOS');
    expect(container.textContent).toContain('ClowderAI-0.12.0-arm64.dmg');
    expect(container.textContent).not.toContain('.exe');
    expect(
      Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Download macOS DMG'),
    ).toBe(true);
  });

  it('uses the warm renderer modal for Ready to Install', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      promptListener?.({
        kind: 'ready-to-install',
        version: '0.12.0',
        platform: 'windows',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
      } as DesktopUpdatePromptPayload);
    });

    expect(container.textContent).toContain('Ready to install');
    expect(container.textContent).toContain('Clowder AI v0.12.0 is ready');
    expect(container.textContent).toContain('The app will close and the installer will run.');
    const install = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Restart & Upgrade',
    );
    expect(install?.className).toContain('console-button-primary');

    act(() => install?.click());
    expect(sendAction).toHaveBeenCalledWith('install' as DesktopUpdatePromptAction, '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    ['Download Windows Setup', 'download'],
    ['Later', 'later'],
    ['Skip This Version', 'skip'],
  ] as const)('sends %s as a version-bound terminal action', (label, action) => {
    renderPrompt();
    const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label);

    act(() => button?.click());

    expect(sendAction).toHaveBeenCalledWith(action, '0.12.0');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('moves focus into the modal, traps Tab, and restores the previous focus on close', () => {
    underlyingButton.focus();
    renderPrompt();

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    const first = focusable[0];
    const last = focusable.at(-1);

    expect(document.activeElement).toBe(dialog);
    expect(dialog.tabIndex).toBe(-1);

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })));
    expect(document.activeElement).toBe(last);

    last?.focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })));
    expect(document.activeElement).toBe(first);

    first?.focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })));
    expect(document.activeElement).toBe(last);

    underlyingButton.focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })));
    expect(document.activeElement).toBe(first);

    const later = focusable.find((element) => element.textContent === 'Later');
    act(() => later?.click());
    expect(document.activeElement).toBe(underlyingButton);
  });

  it('renders nothing in an ordinary browser without the desktop bridge', () => {
    delete window.desktopBridge;
    act(() => root.render(<DesktopUpdatePrompt />));
    expect(container.textContent).toBe('');
  });

  it('shows one draggable in-app progress card with the selected asset and percentage', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      progressListener?.({
        phase: 'downloading',
        version: '0.12.0',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        progress: 0.42,
      });
    });

    const card = container.querySelector('[data-testid="desktop-update-progress"]');
    const bar = container.querySelector('[role="progressbar"]');
    const dot = container.querySelector('[data-testid="desktop-update-progress-dot"]');
    const percent = container.querySelector('[data-testid="desktop-update-progress-percent"]');
    const fill = container.querySelector('[data-testid="desktop-update-progress-fill"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('Downloading update');
    expect(card?.textContent).toContain('ClowderAI-Setup-0.12.0.exe');
    expect(card?.textContent).toContain('42%');
    expect(bar?.getAttribute('aria-valuenow')).toBe('42');
    expect(container.querySelector('[data-testid="desktop-update-progress-rnd"]')).toBeTruthy();
    expect(dot?.className).toContain('bg-cafe-accent');
    expect(percent?.className).toContain('text-cafe-accent');
    expect(fill?.className).toContain('bg-cafe-accent');
  });

  it('collapses or hides only the projection while the main-owned transfer keeps updating', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    act(() => {
      progressListener?.({
        phase: 'downloading',
        version: '0.12.0',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        progress: 0.2,
      });
    });

    const collapse = container.querySelector('[aria-label="Collapse download progress"]') as HTMLButtonElement;
    act(() => collapse.click());
    expect(container.querySelector('[data-testid="desktop-update-progress"]')?.textContent).toContain('20%');
    expect(container.querySelector('[data-testid="desktop-update-progress-details"]')).toBeNull();

    const hide = container.querySelector(
      '[aria-label="Hide download progress; download continues"]',
    ) as HTMLButtonElement;
    act(() => hide.click());
    expect(container.querySelector('[data-testid="desktop-update-progress"]')).toBeNull();
    expect(sendAction).not.toHaveBeenCalled();

    act(() => {
      progressListener?.({
        phase: 'downloading',
        version: '0.12.0',
        assetName: 'ClowderAI-Setup-0.12.0.exe',
        progress: 0.7,
      });
    });
    expect(container.querySelector('[data-testid="desktop-update-progress"]')).toBeNull();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it('resurfaces a same-version retry after the previous transfer reaches idle', () => {
    act(() => root.render(<DesktopUpdatePrompt />));
    const transfer = {
      phase: 'downloading' as const,
      version: '0.12.0',
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      progress: 0.2,
    };
    act(() => progressListener?.(transfer));
    const hide = container.querySelector(
      '[aria-label="Hide download progress; download continues"]',
    ) as HTMLButtonElement;
    act(() => hide.click());

    act(() => progressListener?.(null));
    act(() => progressListener?.({ ...transfer, progress: 0 }));

    expect(container.querySelector('[data-testid="desktop-update-progress"]')).toBeTruthy();
    expect(container.textContent).toContain('0%');
  });

  it('re-clamps stale progress-card geometry after expansion or viewport shrink', () => {
    expect(clampProgressCardGeometry({ width: 320, x: 1000, y: 680 }, 116, { width: 1200, height: 720 })).toEqual({
      width: 320,
      x: 880,
      y: 604,
    });
    expect(clampProgressCardGeometry({ width: 320, x: 850, y: 500 }, 116, { width: 900, height: 600 })).toEqual({
      width: 320,
      x: 580,
      y: 484,
    });
  });
});
