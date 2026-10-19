import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { type HarnessHistoryFailureCode, harnessHistoryCommitSchema } from '@cat-cafe/shared';
import {
  type RequestReviewHarnessLineageIndex,
  requestReviewHarnessLineageIndexSchema,
} from './request-review-harness-lineage-schema.js';
import { collectRequestReviewHarnessV3UnknownFieldPaths } from './request-review-harness-lineage-v3-schema.js';

export const HARNESS_HISTORY_INDEX_PATH = 'docs/discussions/f314-incident-archive/lineage/lineage-index.json';
export class HarnessHistorySourceError extends Error {
  constructor(readonly code: HarnessHistoryFailureCode) {
    super(code);
  }
}
export interface HarnessHistorySource {
  baseline(): Promise<string>;
  read(revision: string): Promise<RequestReviewHarnessLineageIndex>;
  acquire(revision: string): Promise<RequestReviewHarnessLineageIndex>;
  ignoredFieldPaths?(revision: string): Promise<string[]>;
}

function sourcePath(raw: string) {
  const path = posix.normalize(raw.split('#', 1)[0]);
  if (!/^(docs|cat-cafe-skills)\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').includes('..'))
    throw new HarnessHistorySourceError('invalid_history');
  return path;
}

/** Match the archive generator's anchored case bytes, including original trailing newlines. */
function caseText(text: string, anchor?: string) {
  if (!anchor) return text;
  const start = text.indexOf(`<a id="${anchor}"></a>`);
  if (start < 0) throw new HarnessHistorySourceError('invalid_history');
  const nextAnchor = text.indexOf('<a id="', start + 10);
  const heading = /^##\s+/m.exec(text.slice(start + 10));
  const ends = [nextAnchor, heading ? start + 10 + heading.index : -1].filter((value) => value >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
}

/** The repository and remote are deployment configuration, never caller-controlled arguments. */
export function createHarnessHistoryGitSource(options: { repoRoot: string }): HarnessHistorySource {
  const git = (args: string[], timeout = 10_000): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: options.repoRoot,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
  let refreshing: Promise<void> | undefined;
  const ignoredFieldsByRevision = new Map<string, string[]>();
  async function refreshMain() {
    if (!refreshing)
      refreshing = git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], 30_000)
        .then(() => undefined)
        .finally(() => {
          refreshing = undefined;
        });
    await refreshing;
  }
  async function readIndex(revision: string) {
    harnessHistoryCommitSchema.parse(revision);
    let text: string;
    try {
      text = await git(['show', `${revision}:${HARNESS_HISTORY_INDEX_PATH}`]);
    } catch {
      // Callers have already established that this commit exists locally.
      throw new HarnessHistorySourceError('invalid_history');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HarnessHistorySourceError('invalid_history');
    }
    if (
      typeof raw === 'object' &&
      raw &&
      'schemaVersion' in raw &&
      raw.schemaVersion !== 1 &&
      raw.schemaVersion !== 2 &&
      raw.schemaVersion !== 3
    )
      throw new HarnessHistorySourceError('unsupported_history_schema');
    const ignoredFieldPaths = collectRequestReviewHarnessV3UnknownFieldPaths(raw);
    const parsed = requestReviewHarnessLineageIndexSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessHistorySourceError('invalid_history');
    ignoredFieldsByRevision.set(revision, ignoredFieldPaths);
    return parsed.data;
  }
  async function verifyEvidence(index: RequestReviewHarnessLineageIndex) {
    const files = new Map<string, string>();
    const fileAt = async (revision: string, path: string) => {
      const [, anchor, ...extra] = path.split('#');
      if (anchor === '' || extra.length) throw new HarnessHistorySourceError('invalid_history');
      const key = `${revision}:${sourcePath(path)}`;
      let content = files.get(key);
      if (content === undefined) {
        try {
          content = await git(['show', key]);
        } catch {
          // Evidence commits were acquired before reference verification.
          throw new HarnessHistorySourceError('invalid_history');
        }
        files.set(key, content);
      }
      // Archive fragments use explicit stable <a id="…"></a> anchors, just like case links.
      // Validate each reference even when another fragment already cached the same file.
      if (anchor !== undefined) caseText(content, anchor);
      return content;
    };
    for (const entry of index.cases) {
      const [path, anchor] = entry.link?.split('#', 2) ?? [];
      const text = path
        ? caseText(
            await fileAt(index.snapshotCommit, posix.join('docs/discussions/f314-incident-archive', path)),
            anchor,
          )
        : '';
      if (createHash('sha256').update(text).digest('hex') !== entry.sourceTextSha256)
        throw new HarnessHistorySourceError('invalid_history');
    }
    for (const source of index.story?.sources ?? []) await fileAt(index.snapshotCommit, source.path);
    await fileAt(index.ownerReviewCommit, index.ownerReviewRef);
  }
  async function acquireEvidence(index: RequestReviewHarnessLineageIndex) {
    // Squash-merged history can cite reviewed branch cuts absent from main's object graph.
    // Fetch only fixed commit IDs from the schema-validated, main-owned index.
    for (const commit of new Set([index.snapshotCommit, index.ownerReviewCommit])) {
      try {
        await git(['cat-file', '-e', `${commit}^{commit}`]);
      } catch {
        await git(['fetch', '--no-tags', 'origin', commit], 30_000);
      }
    }
  }
  async function acquireIndex(revision: string) {
    harnessHistoryCommitSchema.parse(revision);
    try {
      await refreshMain();
      try {
        await git(['merge-base', '--is-ancestor', revision, 'refs/remotes/origin/main']);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 1)
          throw new HarnessHistorySourceError('source_not_on_main');
        throw error;
      }
      const index = await readIndex(revision);
      await git(['update-ref', `refs/cat-cafe/harness-history/${revision}`, revision]);
      return index;
    } catch (error) {
      if (error instanceof HarnessHistorySourceError) throw error;
      throw new HarnessHistorySourceError('source_unavailable');
    }
  }
  async function acquire(revision: string) {
    const index = await acquireIndex(revision);
    try {
      await acquireEvidence(index);
      await verifyEvidence(index);
      // Keep immutable sources reachable even if other worktrees/branches are later removed.
      for (const commit of new Set([revision, index.snapshotCommit, index.ownerReviewCommit]))
        await git(['update-ref', `refs/cat-cafe/harness-history/${commit}`, commit]);
      return index;
    } catch (error) {
      if (error instanceof HarnessHistorySourceError) throw error;
      throw new HarnessHistorySourceError('source_unavailable');
    }
  }
  return {
    async baseline() {
      return harnessHistoryCommitSchema.parse((await git(['rev-parse', 'HEAD'])).trim());
    },
    async read(revision) {
      harnessHistoryCommitSchema.parse(revision);
      try {
        await git(['cat-file', '-e', `${revision}^{commit}`]);
      } catch {
        // The owner only passes its bundled or successfully published journal selections.
        // The main-owned index contains the complete reading, so restoring that reading
        // must not depend on re-admitting evidence branches that may since have disappeared.
        return acquireIndex(revision);
      }
      return readIndex(revision);
    },
    acquire,
    async ignoredFieldPaths(revision) {
      harnessHistoryCommitSchema.parse(revision);
      if (!ignoredFieldsByRevision.has(revision)) await readIndex(revision);
      return [...(ignoredFieldsByRevision.get(revision) ?? [])];
    },
  };
}
