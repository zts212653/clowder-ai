import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { handlePublishVerdict } from '../../dist/infrastructure/harness-eval/publish-verdict/publish-verdict.js';
import { setupHarnessFeedback } from './eval-manual-trigger-fixtures.js';
import { buildPacket } from './publish-verdict-fixtures.js';

function stubTrace(overrides = {}) {
  return {
    sessionId: 'sess-sop-source-ref-test',
    sopDefinitionId: 'development',
    observedStage: 'review',
    commands: [
      {
        command: 'pnpm convention-graph:code-consumers --domain mcp-tool --name callback-tools',
        exitCode: 0,
        timestamp: 1000,
      },
    ],
    changedFiles: ['packages/mcp-server/src/tools/callback-tools.ts'],
    changedFileEvents: [{ path: 'packages/mcp-server/src/tools/callback-tools.ts', eventNo: 5 }],
    envSnapshot: {},
    gitState: { branch: 'feat/f242', ahead: 0, behind: 0, clean: true },
    handles: { author: 'codex' },
    shaContext: {},
    ...overrides,
  };
}

describe('publish-verdict sop sourceRefs validation', () => {
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns 400 invalid_source_ref before generator dispatch for malformed changedFileEvents ordering', async () => {
    const result = await handlePublishVerdict(
      { harnessFeedbackRoot: root },
      {
        packet: buildPacket({ domainId: 'eval:sop' }),
        domain: 'eval:sop',
        catId: 'codex',
        sourceRefs: {
          kind: 'sop-trace-eval',
          sopDefinitionId: 'development',
          trace: stubTrace(),
        },
      },
    );

    assert.ok('error' in result);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'invalid_source_ref');
    assert.match(result.detail, /changedFileEvents/);
    assert.match(result.detail, /shared eventNo or timestamp/);
  });
});
