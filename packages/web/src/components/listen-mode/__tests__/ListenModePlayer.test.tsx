// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  togglePlayback: vi.fn(),
  previous: vi.fn(),
  next: vi.fn(),
  setPlaybackRate: vi.fn(),
  setRetention: vi.fn(),
  clearAudio: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@/services/DocumentListenController', () => ({ documentListenController: controls }));

import { useChatStore } from '@/stores/chatStore';
import { useListenModeStore } from '@/stores/listenModeStore';
import { ListenModePlayer } from '../ListenModePlayer';
import playerStyles from '../ListenModePlayer.module.css';

const originalSetWorkspaceOpenFile = useChatStore.getState().setWorkspaceOpenFile;
const originalSetCurrentProject = useChatStore.getState().setCurrentProject;

describe('ListenModePlayer', () => {
  let container: HTMLDivElement;
  let root: Root;
  const setWorkspaceOpenFile = vi.fn();
  const setCurrentProject = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    useChatStore.setState({
      currentProjectPath: '/other',
      workspaceOpenFilePath: null,
      workspaceWorktreeId: null,
      workspaceSurface: 'home',
      rightPanelMode: 'status',
      setWorkspaceOpenFile,
      setCurrentProject,
    });
    useListenModeStore.setState({
      session: {
        identity: { projectPath: '/repo', relativePath: 'docs/research.md', contentDigest: 'sha' },
        title: 'research.md',
        worktreeId: 'cat-cafe',
        sentences: [
          {
            anchor: 'sentence-0',
            occurrence: 0,
            index: 0,
            text: '第一句。',
            normalizedText: '第一句。',
            sourceStart: 0,
            sourceEnd: 4,
            fragments: [{ start: 0, end: 4 }],
            container: 'paragraph',
          },
        ],
        phase: 'playing',
        currentIndex: 0,
        currentTime: 2,
        duration: 8,
        playbackRate: 1,
        retention: '7d',
        cachedAnchors: ['sentence-0'],
        cacheBytes: 2048,
        error: null,
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useListenModeStore.setState({ session: null });
    useChatStore.setState({
      setWorkspaceOpenFile: originalSetWorkspaceOpenFile,
      setCurrentProject: originalSetCurrentProject,
    });
  });

  it('survives away from Workspace and returns through the canonical Files/detail transition', async () => {
    await act(async () => root.render(<ListenModePlayer />));
    const returnButton = [...container.querySelectorAll('button')].find(
      ({ textContent }) => textContent === '返回正文',
    );

    await act(async () => returnButton?.click());

    expect(setCurrentProject).toHaveBeenCalledWith('/repo');
    expect(setWorkspaceOpenFile).toHaveBeenCalledWith('docs/research.md', null, 'cat-cafe');
    expect(container.textContent).toContain('已缓存 1 句');
  });

  it('occupies normal Workspace flow instead of floating over the chat composer', async () => {
    await act(async () => root.render(<ListenModePlayer />));

    const player = container.querySelector('[data-testid="listen-mode-player"]');
    expect(player).not.toBeNull();
    expect(player?.classList.contains('fixed')).toBe(false);
    expect(player?.classList.contains('bottom-4')).toBe(false);
    expect(player?.className).toContain('flex-shrink-0');
  });

  it('responds to the Workspace container width and wraps controls before they overlap', async () => {
    await act(async () => root.render(<ListenModePlayer />));

    const player = container.querySelector('[data-testid="listen-mode-player"]');
    const layout = player?.firstElementChild;
    const actionRow = container.querySelector('[aria-label="播放速度"]')?.parentElement;

    expect(player?.classList.contains(playerStyles.container)).toBe(true);
    expect(layout?.classList.contains(playerStyles.layout)).toBe(true);
    expect(layout?.className).not.toContain('sm:grid-cols');
    expect(actionRow?.className).toContain('flex-wrap');
    expect(actionRow?.classList.contains(playerStyles.actions)).toBe(true);
    expect(actionRow?.className).not.toContain('sm:col-span-1');

    const responsiveCss = readFileSync(
      resolve(process.cwd(), 'src/components/listen-mode/ListenModePlayer.module.css'),
      'utf8',
    );
    expect(responsiveCss).toContain('container-type: inline-size');
    expect(responsiveCss).toContain('@container (min-width: 42rem)');
    expect(responsiveCss).toContain('grid-column: 1 / -1');
  });

  it('opens cache settings below the top-mounted Workspace player', async () => {
    await act(async () => root.render(<ListenModePlayer />));
    const cacheButton = [...container.querySelectorAll('button')].find(
      ({ textContent }) => textContent === '已缓存 1 句',
    );

    await act(async () => cacheButton?.click());

    const cacheDialog = container.querySelector('[role="dialog"][aria-label="此文档缓存"]');
    expect(cacheDialog?.className).toContain('top-full');
    expect(cacheDialog?.className).not.toContain('bottom-full');
  });

  it('shows the synthesis error instead of hiding it behind the current sentence', async () => {
    useListenModeStore.setState((state) => ({
      session: state.session
        ? {
            ...state.session,
            phase: 'error',
            error: 'Failed to fetch: CORS response header missing',
          }
        : null,
    }));

    await act(async () => root.render(<ListenModePlayer />));

    expect(container.textContent).toContain('Failed to fetch: CORS response header missing');
    expect(container.querySelector('p[title="Failed to fetch: CORS response header missing"]')).not.toBeNull();
  });

  it('keeps a compact pause entry reachable away from Workspace without covering the composer', async () => {
    await act(async () => root.render(<ListenModePlayer variant="mini" workspaceVisible={false} />));

    const player = container.querySelector('[data-testid="listen-mode-mini-player"]');
    const pauseButton = container.querySelector<HTMLButtonElement>('button[aria-label="暂停"]');

    expect(player).not.toBeNull();
    expect(player?.className).toContain('fixed');
    expect(player?.className).toContain('bottom-24');
    expect(player?.classList.contains('bottom-4')).toBe(false);

    await act(async () => pauseButton?.click());
    expect(controls.togglePlayback).toHaveBeenCalledOnce();

    await act(async () => root.render(<ListenModePlayer variant="mini" workspaceVisible />));
    expect(container.querySelector('[data-testid="listen-mode-mini-player"]')).toBeNull();
  });
});
