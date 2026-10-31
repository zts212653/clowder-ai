import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const adapterRoot = new URL('../../src/infrastructure/harness-eval/', import.meta.url);
const adapters = [
  'publish-verdict/a2a-generator-adapter.ts',
  'publish-verdict/anchor-telemetry-generator-adapter.ts',
  'publish-verdict/capability-wakeup-generator-adapter.ts',
  'publish-verdict/design-gate-generator-adapter.ts',
  'publish-verdict/freshness-generator-adapter.ts',
  'publish-verdict/friction-generator-adapter.ts',
  'publish-verdict/memory-generator-adapter.ts',
  'publish-verdict/qc-generator-adapter.ts',
  'publish-verdict/sop-generator-adapter.ts',
  'publish-verdict/task-outcome-generator-adapter.ts',
  'trajectory-inspector/trajectory-inspector-generator-adapter.ts',
];

describe('publish-verdict generator clock wiring', () => {
  for (const adapter of adapters) {
    it(`${adapter} consumes the request-scoped publication clock`, () => {
      const source = readFileSync(new URL(adapter, adapterRoot), 'utf8');
      assert.match(source, /deps\.publicationTime/);
      assert.doesNotMatch(source, /new Date\s*\(/);
    });
  }
});
