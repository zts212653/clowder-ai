import { useEffect, useRef, useState } from 'react';
import type { TreeNode, WorktreeEntry } from '@/hooks/useWorkspace';
import { apiFetch } from '@/utils/api-client';

/** The F307 Files surface's model of one worktree's tree: owner reads, lazy merges, and reveal. */

export function mergeSubtree(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath && node.type === 'directory') return { ...node, children };
    if (!node.children || !targetPath.startsWith(`${node.path}/`)) return node;
    return { ...node, children: mergeSubtree(node.children, targetPath, children) };
  });
}

export function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return undefined;
}

/** A tree read the owner did not answer with a listing; `status` is null when no answer arrived. */
export class TreeRequestError extends Error {
  constructor(readonly status: number | null) {
    super(`workspace tree owner unavailable: ${status ?? 'no response'}`);
  }
}

export async function requestTree(worktreeId: string, path?: string): Promise<TreeNode[]> {
  const params = new URLSearchParams({ worktreeId, depth: '3' });
  if (path) params.set('path', path);
  let response: Response;
  try {
    response = await apiFetch(`/api/workspace/tree?${params}`);
  } catch {
    throw new TreeRequestError(null);
  }
  if (!response.ok) throw new TreeRequestError(response.status);
  const payload = (await response.json()) as { tree?: TreeNode[] };
  return payload.tree ?? [];
}

export async function requestWorktrees(projectPath: string): Promise<WorktreeEntry[]> {
  const params = new URLSearchParams();
  if (projectPath && projectPath !== 'default') params.set('repoRoot', projectPath);
  const query = params.toString();
  const response = await apiFetch(`/api/workspace/worktrees${query ? `?${query}` : ''}`);
  if (!response.ok) throw new Error(`worktree identity unavailable: ${response.status}`);
  const payload = (await response.json()) as { worktrees?: unknown } | null;
  // A body we cannot read says nothing about the list: it fails, it is never an empty list. One unreadable
  // entry fails the whole read too: a partial list cannot prove which entries the id matches.
  const listed = payload?.worktrees;
  const entries = Array.isArray(listed) ? listed.map(readWorktreeEntry) : [null];
  if (!entries.every((entry): entry is WorktreeEntry => entry !== null))
    throw new Error('worktree identity response unreadable');
  return entries;
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const epoch = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const absentOr = (value: unknown, valid: (present: unknown) => boolean) => value === undefined || valid(value);

/** One listed worktree, only when every field the Files surface reads has the type it is read as. */
export function readWorktreeEntry(value: unknown): WorktreeEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as Record<string, unknown>;
  const readable =
    nonEmptyString(entry.id) &&
    nonEmptyString(entry.root) &&
    nonEmptyString(entry.branch) &&
    // `git worktree list` names no HEAD for a bare repository; the listing says so with an empty string.
    typeof entry.head === 'string' &&
    absentOr(entry.canonicalId, (id) => id === null || nonEmptyString(id)) &&
    absentOr(entry.resolvedRoot, nonEmptyString) &&
    absentOr(entry.rootEpoch, epoch) &&
    absentOr(entry.connectionEpoch, epoch) &&
    absentOr(entry.removable, (flag) => typeof flag === 'boolean') &&
    absentOr(entry.legacyAliases, (aliases) => Array.isArray(aliases) && aliases.every(nonEmptyString));
  return readable ? (entry as unknown as WorktreeEntry) : null;
}

export function ownsWorktreeIdentity(entry: WorktreeEntry, worktreeId: string): boolean {
  return (
    entry.id === worktreeId || entry.canonicalId === worktreeId || Boolean(entry.legacyAliases?.includes(worktreeId))
  );
}

/** One explicit request to show a path in a worktree's file tree. `request` makes every request re-run. */
export interface FilesRevealTarget {
  path: string;
  request: number;
}

export type FilesRevealPlan =
  | { kind: 'wait' }
  | { kind: 'load'; directory: string }
  | { kind: 'revealed'; expand: string[]; selected: string }
  | { kind: 'absent'; path: string };

export type FilesRevealState =
  | { status: 'idle' }
  | { status: 'revealing'; path: string }
  | { status: 'revealed'; path: string; selected: string }
  | { status: 'failed'; path: string; reason: string };

export type SubtreeLoad = { ok: true } | { ok: false; status: number | null };

const LOAD_BUDGET = 32;

/** A workspace-relative path in its tree form; the worktree root (`.`, `./`, ``) becomes ``. */
export function normalizeRevealPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment && segment !== '.')
    .join('/');
}

export function revealDisplayPath(path: string): string {
  return path || '工作区根目录';
}

/**
 * Next step towards showing `target`, given what the tree has listed so far. A segment missing from a
 * listing that has loaded is `absent`; why it is absent is the owner's answer, not something to guess here.
 * The worktree root is the tree itself and is always shown.
 */
export function planFilesReveal(tree: readonly TreeNode[], rootLoaded: boolean, target: string): FilesRevealPlan {
  if (!rootLoaded) return { kind: 'wait' };
  const normalized = normalizeRevealPath(target);
  if (!normalized) return { kind: 'revealed', expand: [], selected: '' };
  const parts = normalized.split('/');
  const expand: string[] = [];
  let level: readonly TreeNode[] = tree;
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index + 1).join('/');
    const node = level.find((candidate) => candidate.path === prefix);
    const last = index === parts.length - 1;
    if (!node || (!last && node.type !== 'directory')) return { kind: 'absent', path: prefix };
    if (last) {
      return { kind: 'revealed', expand: node.type === 'directory' ? [...expand, prefix] : expand, selected: prefix };
    }
    expand.push(prefix);
    if (node.children === undefined) return { kind: 'load', directory: prefix };
    level = node.children;
  }
  return { kind: 'absent', path: parts.join('/') };
}

/** The owner's answer about one path: HTTP status, and for a listable path whether the tree omits it by rule. */
export interface OwnerAnswer {
  status: number | null;
  hiddenFromTree?: boolean;
}

/** What the workspace owner answered for `path`, in words; an unconfirmed answer stays unconfirmed. */
export function revealFailureReason(path: string, answer: OwnerAnswer): string {
  const shown = revealDisplayPath(path);
  if (answer.status === 404) return `工作区里没有 ${shown}，它可能已被移动或删除。`;
  if (answer.status === 403) return `${shown} 受工作区安全策略保护，不能在 Hub 中打开。`;
  if (answer.status === 200 && answer.hiddenFromTree === true) {
    return `${shown} 存在，但文件树不显示这类目录（以 . 开头的目录或 node_modules 等）。`;
  }
  return `暂时无法确认 ${shown} 的状态，请稍后重试。`;
}

async function askOwner(worktreeId: string, path: string): Promise<OwnerAnswer> {
  try {
    const params = new URLSearchParams({ worktreeId, path, depth: '1' });
    const response = await apiFetch(`/api/workspace/tree?${params}`);
    if (!response.ok) return { status: response.status };
    const body = (await response.json().catch(() => null)) as { hiddenFromTree?: unknown } | null;
    const hidden = body?.hiddenFromTree;
    return typeof hidden === 'boolean' ? { status: response.status, hiddenFromTree: hidden } : { status: null };
  } catch {
    return { status: null };
  }
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/** Walks the file tree towards one requested path using the surface's own lazy loads. */
export function useFilesReveal({
  worktreeId,
  target,
  tree,
  rootState,
  loadSubtree,
  expand,
}: {
  worktreeId: string | null;
  target: FilesRevealTarget | undefined;
  tree: readonly TreeNode[];
  rootState: 'loading' | 'loaded' | 'failed';
  loadSubtree: (path: string) => Promise<SubtreeLoad>;
  expand: (paths: readonly string[]) => void;
}): FilesRevealState {
  const [state, setState] = useState<FilesRevealState>({ status: 'idle' });
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  const relisted = useRef(new Set<string>());
  const steps = useRef(0);
  const targetPath = target ? normalizeRevealPath(target.path) : '';
  const requestKey = target && worktreeId ? `${worktreeId}\u0000${target.request}\u0000${targetPath}` : null;

  // A new request (worktree, request number or path) starts over; answers for an older one are ignored.
  useEffect(() => {
    generation.current += 1;
    inFlight.current = new Set();
    relisted.current = new Set();
    steps.current = 0;
    setState(requestKey ? { status: 'revealing', path: targetPath } : { status: 'idle' });
  }, [requestKey, targetPath]);

  useEffect(() => {
    if (!worktreeId || (state.status !== 'revealing' && state.status !== 'failed')) return;
    const { path } = state;
    const plan = planFilesReveal(tree, rootState === 'loaded', path);
    // The tree is the truth: whatever was answered before, a tree that shows the path has revealed it.
    if (plan.kind === 'revealed') {
      expand(plan.expand);
      setState({ status: 'revealed', path, selected: plan.selected });
      return;
    }
    if (state.status === 'failed') return;
    const mine = generation.current;
    // An answer lands only while this same request is still looking; a reveal that happened meanwhile wins.
    const fail = (subject: string, answer: OwnerAnswer) =>
      setState((current) =>
        mine === generation.current && current.status === 'revealing' && current.path === path
          ? { status: 'failed', path, reason: revealFailureReason(subject, answer) }
          : current,
      );
    if (rootState === 'failed') return fail(path, { status: null });
    if (plan.kind === 'wait') return;
    const subject = plan.kind === 'load' ? plan.directory : plan.path;
    const key = `${plan.kind}:${subject}`;
    if (inFlight.current.has(key)) return;
    if (steps.current >= LOAD_BUDGET) return fail(subject, { status: null });
    steps.current += 1;
    inFlight.current.add(key);
    const settle = () => inFlight.current.delete(key);
    if (plan.kind === 'load') {
      void loadSubtree(plan.directory).then((result) => {
        settle();
        if (!result.ok) fail(plan.directory, { status: result.status });
      });
      return;
    }
    void askOwner(worktreeId, plan.path).then((answer) => {
      settle();
      const listable = answer.status === 200 && answer.hiddenFromTree === false;
      if (!listable) return fail(plan.path, answer);
      // The owner lists it now, so the listing we hold is older than the path. List the parent once more;
      // if even a fresh listing leaves it out, the reason stays unconfirmed rather than guessed.
      if (relisted.current.has(plan.path)) return fail(plan.path, { status: null });
      relisted.current.add(plan.path);
      const parent = parentOf(plan.path);
      void loadSubtree(parent).then((result) => {
        if (!result.ok) fail(parent || plan.path, { status: result.status });
      });
    });
  }, [expand, loadSubtree, rootState, state, tree, worktreeId]);

  return state;
}
