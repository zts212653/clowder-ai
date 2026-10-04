import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workspaceContentReviewSchema } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { applyWorkspaceReviewAction } from '../src/domains/collaborative-content/workspace-review/workspace-review-actions.js';
import {
  toWorkspaceReviewSource,
  workspaceReviewIdentity,
} from '../src/domains/collaborative-content/workspace-review/workspace-review-anchors.js';
import { appendWorkspaceSourceHistory } from '../src/domains/collaborative-content/workspace-review/workspace-review-mutations.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { workspaceTextDigest } from '../src/domains/workspace/workspace-content-source-utils.js';

export const roots: string[] = [];

export async function cleanupFixtureRoots() {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
}

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f309-workspace-review-'));
  roots.push(root);
  await writeFile(join(root, 'notes.md'), '# Notes\n\nA unique source quote.\n');
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async (id) => {
      if (id !== 'worktree-a') throw new Error('unknown worktree');
      return { root, canonicalWorktreeId: id };
    },
  });
  const dbPath = join(root, 'workspace-content-reviews.sqlite');
  const store = new WorkspaceContentReviewStore(dbPath);
  const reviews = new WorkspaceContentReviewService({
    store,
    source,
    now: () => '2026-09-16T00:00:00.000Z',
  });
  return { root, source, store, reviews, dbPath };
}

export const principal = { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } };
export const locator = { worktreeId: 'worktree-a', path: 'notes.md' };

export {
  assert,
  mkdtemp,
  tmpdir,
  writeFile,
  join,
  workspaceContentReviewSchema,
  Database,
  WorkspaceContentReviewError,
  WorkspaceContentReviewService,
  WorkspaceContentReviewStore,
  applyWorkspaceReviewAction,
  toWorkspaceReviewSource,
  workspaceReviewIdentity,
  appendWorkspaceSourceHistory,
  WorkspaceContentSourceService,
  workspaceTextDigest,
  sharp,
};
