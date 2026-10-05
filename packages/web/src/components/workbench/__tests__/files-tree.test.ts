import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@/hooks/useWorkspace';
import { normalizeRevealPath, planFilesReveal, revealDisplayPath, revealFailureReason } from '../files-tree';
import { createFilesSurface, createWorkspaceModeSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

describe('files surface reveal descriptor', () => {
  const origin = {
    kind: 'settings' as const,
    href: '/settings?s=system',
    anchorId: 'settings-dir:packages/api/uploads',
    viewportOffsetPx: 0,
  };
  const saved = (surface: ReturnType<typeof createFilesSurface>) =>
    JSON.parse(JSON.stringify(createInitialWorkbenchState([surface])));

  it('keeps a revealed tree and its Settings origin across a reload', () => {
    const surface = createFilesSurface('wt-1', {
      reveal: { path: 'packages/api/uploads', request: 7 },
      navigationOrigin: origin,
    });
    const restored = restoreWorkbenchState(saved(surface)).surfaces[0];
    expect(restored?.filesReveal).toEqual({ path: 'packages/api/uploads', request: 7 });
    expect(restored?.navigationOrigin).toEqual(origin);
  });

  it.each([
    ['an empty path', { path: '', request: 1 }],
    ['a non-positive request', { path: 'docs', request: 0 }],
    ['a non-integer request', { path: 'docs', request: 1.5 }],
  ])('drops a files surface whose reveal has %s', (_name, reveal) => {
    const state = saved(createFilesSurface('wt-1'));
    state.surfaces[0].filesReveal = reveal;
    expect(restoreWorkbenchState(state).surfaces).toEqual([]);
  });

  it('keeps the listing coordinate a Settings tree was minted under, and drops it anywhere else', () => {
    const tree = createFilesSurface('b603ff_alpha', { repoRoot: '/repo/alpha' });
    expect(restoreWorkbenchState(saved(tree)).surfaces[0]?.filesRepoRoot).toBe('/repo/alpha');
    const blank = saved(createFilesSurface('wt-1'));
    blank.surfaces[0].filesRepoRoot = '';
    expect(restoreWorkbenchState(blank).surfaces).toEqual([]);
    const mode = JSON.parse(JSON.stringify(createInitialWorkbenchState([createWorkspaceModeSurface('artifacts')])));
    mode.surfaces[0].filesRepoRoot = '/repo/alpha';
    expect(restoreWorkbenchState(mode).surfaces).toEqual([]);
  });

  it('drops a reveal attached to a workspace surface that is not a file tree', () => {
    const state = JSON.parse(JSON.stringify(createInitialWorkbenchState([createWorkspaceModeSurface('artifacts')])));
    state.surfaces[0].filesReveal = { path: 'docs', request: 1 };
    expect(restoreWorkbenchState(state).surfaces).toEqual([]);
  });
});

const dir = (path: string, children?: TreeNode[]): TreeNode => ({
  name: path.split('/').at(-1) ?? path,
  path,
  type: 'directory',
  ...(children ? { children } : {}),
});
const file = (path: string): TreeNode => ({ name: path.split('/').at(-1) ?? path, path, type: 'file' });

describe('planFilesReveal', () => {
  it('waits until the root listing has loaded', () => {
    expect(planFilesReveal([], false, 'packages/api/uploads')).toEqual({ kind: 'wait' });
  });

  it('reveals a directory whose ancestors are loaded, expanding the chain and the directory itself', () => {
    const tree = [dir('packages', [dir('packages/api', [dir('packages/api/uploads', []), file('packages/api/a.ts')])])];
    expect(planFilesReveal(tree, true, 'packages/api/uploads')).toEqual({
      kind: 'revealed',
      expand: ['packages', 'packages/api', 'packages/api/uploads'],
      selected: 'packages/api/uploads',
    });
  });

  it('reveals a file by expanding only its ancestors', () => {
    const tree = [dir('docs', [file('docs/README.md')])];
    expect(planFilesReveal(tree, true, 'docs/README.md')).toEqual({
      kind: 'revealed',
      expand: ['docs'],
      selected: 'docs/README.md',
    });
  });

  it('asks for the first ancestor whose children have not been listed yet', () => {
    const tree = [dir('packages', [dir('packages/api', [dir('packages/api/data')])])];
    expect(planFilesReveal(tree, true, 'packages/api/data/logs/api')).toEqual({
      kind: 'load',
      directory: 'packages/api/data',
    });
  });

  it('reports the first segment that a loaded listing does not contain', () => {
    const tree = [dir('packages', [dir('packages/api', [])])];
    expect(planFilesReveal(tree, true, 'packages/api/uploads')).toEqual({
      kind: 'absent',
      path: 'packages/api/uploads',
    });
    expect(planFilesReveal([file('README.md')], true, '.cat-cafe/logs')).toEqual({ kind: 'absent', path: '.cat-cafe' });
  });

  it('treats a file where a directory is expected as absent', () => {
    const tree = [file('notes')];
    expect(planFilesReveal(tree, true, 'notes/today')).toEqual({ kind: 'absent', path: 'notes' });
  });

  it('ignores redundant slashes and current-directory segments in the target', () => {
    const tree = [dir('docs', [])];
    expect(planFilesReveal(tree, true, '/docs/')).toEqual({ kind: 'revealed', expand: ['docs'], selected: 'docs' });
    expect(planFilesReveal(tree, true, './docs/.')).toEqual({ kind: 'revealed', expand: ['docs'], selected: 'docs' });
  });

  // Review P1 (#4741): the navigate resolver names an absolute worktree root as '.', which is the tree itself.
  it.each(['.', './', '', '/'])('treats %j as the worktree root, which is always shown', (target) => {
    expect(planFilesReveal([file('README.md')], true, target)).toEqual({ kind: 'revealed', expand: [], selected: '' });
    expect(normalizeRevealPath(target)).toBe('');
  });
});

describe('revealFailureReason', () => {
  it('names each owner answer instead of folding them into one message', () => {
    expect(revealFailureReason('packages/api/uploads', { status: 404 })).toContain('工作区里没有 packages/api/uploads');
    expect(revealFailureReason('.env.d', { status: 403 })).toContain('受工作区安全策略保护');
    expect(revealFailureReason('.cat-cafe', { status: 200, hiddenFromTree: true })).toContain('文件树不显示');
    expect(revealFailureReason('x', { status: 500 })).toContain('暂时无法确认');
    expect(revealFailureReason('x', { status: null })).toContain('暂时无法确认');
  });

  it('does not claim a hiding rule from a bare 200: only the owner can say the tree leaves it out', () => {
    expect(revealFailureReason('docs/new', { status: 200 })).toContain('暂时无法确认');
    expect(revealFailureReason('docs/new', { status: 200, hiddenFromTree: false })).toContain('暂时无法确认');
  });

  it('names the root in words rather than an empty path', () => {
    expect(revealFailureReason('', { status: null })).toContain('工作区根目录');
    expect(revealDisplayPath('')).toBe('工作区根目录');
    expect(revealDisplayPath('docs')).toBe('docs');
  });
});
