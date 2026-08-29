import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const { isClaudeProjectHookCarrierReady } = await import(
  '../dist/domains/cats/services/session/claude-project-hook-readiness.js'
);

const roots = [];

function projectRoot() {
  const root = mkdtempSync(join(tmpdir(), 'f296-claude-hook-carrier-'));
  roots.push(root);
  return root;
}

function writeSettings(root, command = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/f24-pre-compact.sh') {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreCompact: [{ matcher: 'manual|auto', hooks: [{ type: 'command', command }] }],
      },
    }),
  );
}

function writeAuthenticatedHook(root, { executable = true, legacyBearer = false, omitCallbackHeader = false } = {}) {
  const hookDir = join(root, '.claude', 'hooks');
  mkdirSync(hookDir, { recursive: true });
  const hookPath = join(hookDir, 'f24-pre-compact.sh');
  const shellExpansion = (name) => `\${${name}}`;
  const legacyBearerLine = legacyBearer ? `HOOK_TOKEN="${shellExpansion('CAT_CAFE_HOOK_TOKEN:-')}"` : '';
  const callbackHeader = omitCallbackHeader ? '' : `-H "X-Callback-Token: ${shellExpansion('CALLBACK_TOKEN')}"`;
  writeFileSync(
    hookPath,
    `#!/bin/bash
INVOCATION_ID="\${CAT_CAFE_INVOCATION_ID:-}"
CALLBACK_TOKEN="\${CAT_CAFE_CALLBACK_TOKEN:-}"
${legacyBearerLine}
curl -X POST http://localhost:3004/api/sessions/seal \\
  -H "X-Invocation-Id: \${INVOCATION_ID}" \\
  ${callbackHeader}
`,
  );
  chmodSync(hookPath, executable ? 0o755 : 0o644);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('F296 Claude project hook carrier readiness', () => {
  test('fails closed when the active project has no matching carrier assets', () => {
    assert.equal(isClaudeProjectHookCarrierReady(undefined), false);

    const missingSettings = projectRoot();
    assert.equal(isClaudeProjectHookCarrierReady(missingSettings), false);

    const wrongCommand = projectRoot();
    writeSettings(wrongCommand, 'echo no-precompact-carrier');
    writeAuthenticatedHook(wrongCommand);
    assert.equal(isClaudeProjectHookCarrierReady(wrongCommand), false);

    const missingScript = projectRoot();
    writeSettings(missingScript);
    assert.equal(isClaudeProjectHookCarrierReady(missingScript), false);
  });

  test('requires an executable invocation-authenticated seal hook, not the retired bearer shape', () => {
    const nonExecutable = projectRoot();
    writeSettings(nonExecutable);
    writeAuthenticatedHook(nonExecutable, { executable: false });
    assert.equal(isClaudeProjectHookCarrierReady(nonExecutable), false);

    const legacyBearer = projectRoot();
    writeSettings(legacyBearer);
    writeAuthenticatedHook(legacyBearer, { legacyBearer: true });
    assert.equal(isClaudeProjectHookCarrierReady(legacyBearer), false);

    const staleCallbackContract = projectRoot();
    writeSettings(staleCallbackContract);
    writeAuthenticatedHook(staleCallbackContract, { omitCallbackHeader: true });
    assert.equal(isClaudeProjectHookCarrierReady(staleCallbackContract), false);

    const ready = projectRoot();
    writeSettings(ready);
    writeAuthenticatedHook(ready);
    assert.equal(isClaudeProjectHookCarrierReady(ready), true);
  });
});
