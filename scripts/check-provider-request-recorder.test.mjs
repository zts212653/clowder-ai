import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertProviderRequestRecorderCoverage,
  scanProviderRequestRecorderCoverage,
} from './check-provider-request-recorder.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'f299-provider-census-'));
  const providerRoot = join(root, 'packages/api/src/domains/cats/services/agents/providers');
  mkdirSync(providerRoot, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(providerRoot, name), source);
  if (!files['CodexAppServerClient.ts']) writeFileSync(join(providerRoot, 'CodexAppServerClient.ts'), 'export {};');
  return root;
}

test('discovers AgentService implementers from source instead of an allowlist', () => {
  const root = fixture({
    'NewCarrier.ts': `
      class NewCarrier implements AgentService {
        async invoke(options) {
          await options.beforeProviderLaunch(request);
          return spawnCli(request.message.body);
        }
      }
    `,
  });
  const result = assertProviderRequestRecorderCoverage(root);
  assert.deepEqual(result.implementers, ['packages/api/src/domains/cats/services/agents/providers/NewCarrier.ts']);
});

test('rejects a newly added direct provider launch without an awaited recorder fence', () => {
  const root = fixture({
    'UnsafeCarrier.ts': `
      class UnsafeCarrier implements L0InjectableAgentService {
        invoke(request) { return fetch(request.url); }
      }
    `,
  });
  const result = scanProviderRequestRecorderCoverage(root);
  assert.match(result.issues.join('\n'), /UnsafeCarrier\.ts: 1 direct provider launch/);
});

test('rejects a second launch site that reuses the file-level fence of the first site', () => {
  const root = fixture({
    'UnsafeCarrier.ts': `
      class UnsafeCarrier implements AgentService {
        async invoke(options) {
          await options.beforeProviderLaunch(request);
          spawnCli(request.message.body);
          return spawnCli('unrecorded-follow-up');
        }
      }
    `,
  });
  const result = scanProviderRequestRecorderCoverage(root);
  assert.match(result.issues.join('\n'), /2 direct provider launch sites but only 1 awaited/);
});

test('guards the app-server turn/start submission boundary', () => {
  const root = fixture({
    'SafeCarrier.ts': `
      class SafeCarrier implements AgentService {
        invoke() { return delegated.invoke(); }
      }
    `,
    'CodexAppServerClient.ts': `class Client { run() { return this.request('turn/start', {}); } }`,
  });
  const result = scanProviderRequestRecorderCoverage(root);
  assert.match(result.issues.join('\n'), /CodexAppServerClient\.ts: turn\/start/);
});
