import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `--pure` is not a universal OpenCode flag: v2.0.28 advertises `--standalone`,
 * `--agent`, `--format` and `--session`, but not `--pure`, and passing it makes the
 * CLI print help and exit without ever sending a request. Verified directly:
 *
 *   opencode run --pure --agent a --format json -m fixture/none 'hi'   → help, exit 0
 *   opencode run        --agent a --format json -m fixture/none 'hi'   → JSON event stream
 *
 * So the flag has to be probed like `--standalone` already is, instead of being
 * injected unconditionally. What must NOT change is the no-tool guarantee itself:
 * that comes from the config channels, not from argv.
 */
const here = dirname(fileURLToPath(import.meta.url));
const serviceSource = readFileSync(
  join(here, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers', 'OpenCodeAgentService.ts'),
  'utf8',
);
const recoverySource = readFileSync(
  join(here, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers', 'opencode-recovery.ts'),
  'utf8',
);

describe('no-tool safety does not depend on --pure', () => {
  test('the finalizer config denies every tool through the config channel', () => {
    assert.match(recoverySource, /export const OPENCODE_NO_TOOL_PERMISSION/, 'permission table must exist');
    assert.match(recoverySource, /'\*':\s*'deny'/, 'the wildcard permission must default to deny');
    for (const tool of ['bash', 'edit', 'write', 'apply_patch']) {
      assert.match(
        recoverySource,
        new RegExp(`${tool}:\\s*'deny'`),
        `${tool} must be denied by config, not only by a CLI flag`,
      );
    }
  });

  test('the finalizer config disables every tool and pins the agent', () => {
    assert.match(recoverySource, /default_agent:\s*finalizerAgent/, 'the config pins the finalizer agent');
    for (const tool of ['bash', 'edit', 'write', 'apply_patch']) {
      assert.match(
        recoverySource,
        new RegExp(`${tool}:\\s*false`),
        `${tool} must be disabled in the tools block`,
      );
    }
  });

  test('both no-tool config channels are still injected into the finalizer env', () => {
    assert.match(serviceSource, /OPENCODE_CONFIG_CONTENT_ENV\]:\s*JSON\.stringify\(buildOpenCodeNoToolFinalizerConfig/);
    assert.match(serviceSource, /OPENCODE_PERMISSION_ENV\]:\s*JSON\.stringify\(OPENCODE_NO_TOOL_PERMISSION\)/);
  });

  test('the read-only run keeps its own deny-all-but-read permission table', () => {
    assert.match(serviceSource, /export const OPENCODE_READ_ONLY_PERMISSION|const OPENCODE_READ_ONLY_PERMISSION/);
    assert.match(serviceSource, /edit:\s*'deny'/);
    assert.match(serviceSource, /bash:\s*'deny'/);
  });
});
