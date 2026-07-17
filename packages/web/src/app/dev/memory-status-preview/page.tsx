/**
 * F188 Phase K dev preview — AC-K7 pre-merge UI dogfood support.
 *
 * Renders DegradedBanner with the reporter clowder-ai#880 fixture so we
 * can take a real UI screenshot in the feature worktree *before* merging
 * to main (五条铁律 #4: 未合入改动在 feature worktree 自测). The full
 * Memory Center alpha verification still happens post-merge against the
 * real backend; this page only locks the visual contract pre-merge.
 *
 * Dev-only:
 *   - Returns notFound() unless NODE_ENV === 'development'
 *   - Not linked from any nav surface
 *   - Path is intentionally under /dev/ so it never appears in prod sitemaps
 *
 * Spec: docs/features/F188-library-stewardship.md Phase K AC-K7
 */

'use client';

import { notFound } from 'next/navigation';
import { type ConfigWarning, DegradedBanner } from '@/components/memory/IndexStatus';

const REPORTER_880_WARNINGS: ConfigWarning[] = [
  {
    code: 'embedding_disabled',
    message: 'No embedding model is configured — semantic recall is offline.',
    suggestedAction:
      'Install and start the recommended local embedding service in Memory Center, then rebuild the index.',
  },
  {
    code: 'vectors_empty',
    message: 'Documents are indexed (10) but the vector index is empty — semantic recall will not return results.',
    suggestedAction:
      'Run a full reindex (Memory Center → Rebuild Index) to compute vectors for the ingested documents.',
  },
  {
    code: 'graph_empty',
    message: 'Documents are indexed (10) but the knowledge graph has no edges — graph-aware recall will be limited.',
    suggestedAction:
      'Run graph extraction (Memory Center → Rebuild Index). If edges remain empty after rebuild, check the extractor logs for failures.',
  },
  {
    code: 'vec_table_missing',
    message: 'Passage vector table is unavailable (sqlite-vec not loaded or embedding service not ready).',
    suggestedAction:
      'Open the local embedding service controls to start or reinstall it; unsupported platforms will show a platform-specific error.',
  },
];

export default function MemoryStatusPreviewPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <div className="min-h-screen bg-[var(--cafe-surface)] p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <header>
          <h1 className="text-base font-semibold text-cafe-black">F188 Phase K dev preview</h1>
          <p className="text-micro text-cafe-secondary">
            Reporter clowder-ai#880 fixture (4 warnings). Dev-only — used for pre-merge UI dogfood screenshots.
          </p>
        </header>
        <DegradedBanner
          warnings={REPORTER_880_WARNINGS}
          onWarningClick={(code) => {
            // Preview-only handler — log to console so screenshot reviewer can
            // verify click handler is wired without the real scroll target.
            console.log(`[preview] warning click: ${code}`);
          }}
        />
      </div>
    </div>
  );
}
