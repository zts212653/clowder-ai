import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const phaseCFiles = [
  'src/domains/cats/services/session/CanonicalInvocationTrajectoryResolver.ts',
  'src/routes/invocation-trajectory-routes.ts',
  'src/routes/session-transcript.ts',
  '../web/src/components/workspace/trajectory/InvocationTrajectoryDetail.tsx',
  '../web/src/components/workspace/trajectory/InvocationEvidenceLinks.tsx',
  '../web/src/components/workspace/trajectory/canonical-trajectory-resolution.ts',
  '../web/src/components/workspace/trajectory/invocation-evidence-ref.ts',
  '../web/src/components/workspace/trajectory/trajectory-navigation.ts',
  '../web/src/components/eval-workspace/EvalWorkspaceEventCard.tsx',
  '../web/src/components/HubEvalVerdictCard.tsx',
];

describe('F299 Phase C architecture boundary', () => {
  it('does not introduce an evidence manifest, store, registry, or alternate invocation grammar', async () => {
    const sources = await Promise.all(
      phaseCFiles.map((path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')),
    );
    const joined = sources.join('\n');

    assert.doesNotMatch(joined, /Evidence(?:Manifest|Store|Registry)/);
    assert.doesNotMatch(joined, /session:[^\n]*\/invocation:/);
    assert.doesNotMatch(joined, /attribution:[^\n]*(?:invocation|inv):/);
    assert.doesNotMatch(joined, /(?:localStorage|sessionStorage|indexedDB)/);
  });
});
