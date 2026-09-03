import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertFrictionSubmittedPacketMatches } from '../../dist/infrastructure/harness-eval/friction/friction-submitted-packet-guard.js';

describe('friction submitted packet server-owned fields', () => {
  it('rejects caller-owned child routing fields at the generator boundary', () => {
    assert.throws(
      () =>
        assertFrictionSubmittedPacketMatches(
          {
            domainId: 'eval:friction',
            harnessUnderEval: { featureId: 'F245' },
            findingBinding: {},
            repairTarget: {},
          },
          { domainId: 'eval:friction', handoffTargetResolver: { featureId: 'F245' } },
        ),
      /server_owned_fields/,
    );
  });
});
