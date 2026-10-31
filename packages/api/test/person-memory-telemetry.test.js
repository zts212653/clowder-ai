import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  personMemoryMetricAttributes,
  recordPersonMemoryStage,
} from '../dist/domains/memory/people/person-memory-telemetry.js';

describe('F276 person-memory telemetry', () => {
  it('exports only bounded stage and outcome attributes', () => {
    const attributes = personMemoryMetricAttributes('materialize', 'success');

    assert.deepEqual(attributes, {
      'operation.name': 'person_memory.materialize',
      status: 'success',
    });
    assert.doesNotMatch(JSON.stringify(attributes), /personId|candidateId|claimId|messageId|threadId|hash/i);
    assert.deepEqual(personMemoryMetricAttributes('capture', 'replayed'), {
      'operation.name': 'person_memory.capture',
      status: 'replayed',
    });
    assert.deepEqual(personMemoryMetricAttributes('deferred_daily', 'not_available'), {
      'operation.name': 'person_memory.deferred_daily',
      status: 'not_available',
    });
  });

  it('rejects unknown dimensions and ignores caller identifiers by construction', () => {
    assert.throws(() => personMemoryMetricAttributes('person_123', 'success'), /invalid person-memory telemetry stage/);
    assert.throws(() => recordPersonMemoryStage('recall', 'person_123', 5), /invalid person-memory telemetry outcome/);
  });
});
