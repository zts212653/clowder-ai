import { join } from 'node:path';
import { createWorkspaceContentSource } from '../../workspace/workspace-content-source-factory.js';
import { WorkspaceContentReviewService } from './service.js';
import { WorkspaceContentReviewStore } from './store.js';

/** Compose the task-free F309 aggregate beside — never inside — Task artifact review. */
export function createWorkspaceContentReviewComposition(options: {
  readonly dataDir: string;
  readonly ownerUserId: string;
}) {
  const source = createWorkspaceContentSource(options.ownerUserId);
  const store = new WorkspaceContentReviewStore(
    join(options.dataDir, 'collaborative-content', 'workspace-content-reviews.sqlite'),
  );
  const reviews = new WorkspaceContentReviewService({ store, source });
  return { source, store, reviews };
}
