import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { EntityNudgeService } = await import('../../dist/domains/memory/EntityNudgeService.js');
const { formatInjectionProvenance, hasInjectionProvenance } = await import(
  '../../dist/domains/memory/injection-provenance.js'
);

describe('F263 AC-B5 injection provenance renderer invariant', () => {
  it('rejects provenance labels that have no drillable coordinate', () => {
    assert.throws(() => formatInjectionProvenance({ source: 'manual' }), /requires a drillable coordinate/);
  });

  it('recognizes rendered source pointers with document or message coordinates', () => {
    assert.equal(
      hasInjectionProvenance(
        formatInjectionProvenance({ source: 'memory', anchor: 'F263', sourcePath: 'docs/features/F263.md' }),
      ),
      true,
    );
    assert.equal(hasInjectionProvenance(formatInjectionProvenance({ threadId: 'thread-1', messageId: 'msg-7' })), true);
  });

  it('never renders a nudge carrying provenance as pointer-free text', () => {
    const rendered = EntityNudgeService.formatForPrompt({
      nudges: [
        {
          text: '📌 「F263」→ feature:F263（feature）',
          kind: 'entity_nudge',
          entityId: 'feature:F263',
          matchedAlias: 'F263',
          storable: false,
          indexable: false,
          provenance: [{ source: 'feature-index', anchor: 'docs/features/F263.md' }],
          telemetry: {
            entityId: 'feature:F263',
            sourceFamily: 'entity_registry',
            aliasClass: 'feature',
            confidence: 1,
          },
        },
      ],
      detectedCount: 1,
      suppressedCount: 0,
      privacyBlockedCount: 0,
    });

    assert.equal(hasInjectionProvenance(rendered), true, rendered);
    assert.ok(rendered.includes('anchor=docs/features/F263.md'), rendered);
  });
});
