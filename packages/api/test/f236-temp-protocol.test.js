import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { test } from 'node:test';
import {
  appendEvalEvent,
  isAnchorModeActive,
  recordFileState,
  resolveEvalFilePath,
  resolveModeFilePath,
  resolveStateFilePath,
} from '../../../.claude/hooks/f236-anchor-posttool.mjs';
import { handleSetReadMode } from '../../mcp-server/dist/tools/callback-tools.js';
import {
  cleanupSessionFiles,
  resolveModeFilePath as resolveBridgeMode,
  resolveStateFilePath as resolveBridgeState,
  resolveEvalJsonlPath,
} from '../dist/domains/cats/services/agents/providers/AnchorEvalBridgeConsumer.js';

test('anchor writer, hook and eval bridge share the native temporary directory', async (t) => {
  const invocationId = `temp-protocol-${randomUUID()}`;
  const env = { CAT_CAFE_INVOCATION_ID: invocationId };
  const modePath = resolveModeFilePath(env);
  const evalPath = resolveEvalFilePath(env);
  const statePath = resolveStateFilePath(env);
  t.after(() => cleanupSessionFiles(evalPath, modePath, statePath));
  const expectedRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  for (const path of [modePath, evalPath, statePath]) assert.equal(dirname(path), expectedRoot);
  assert.equal(resolveBridgeMode(invocationId), modePath);
  assert.equal(resolveEvalJsonlPath(invocationId), evalPath);
  assert.equal(resolveBridgeState(invocationId), statePath);

  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.CAT_CAFE_INVOCATION_ID = invocationId;
  process.env.CAT_CAFE_CALLBACK_TOKEN = 'fixture-only';
  process.env.CAT_CAFE_CREDENTIAL_FILE = `${modePath}.missing-credential`;
  const result = await handleSetReadMode({ mode: 'anchor' });
  assert.equal(result.isError, undefined);
  assert.equal(isAnchorModeActive(modePath), true);
  appendEvalEvent(env, { tool: 'Read', originalChars: 20, returnedChars: 5, itemIds: ['fixture'] });
  assert.equal(JSON.parse(readFileSync(resolveEvalJsonlPath(invocationId), 'utf8')).tool, 'cc-read');
  recordFileState(env, [import.meta.filename]);
  assert.ok(JSON.parse(readFileSync(resolveBridgeState(invocationId), 'utf8'))[import.meta.filename]);
  await handleSetReadMode({ mode: 'full' });
  assert.equal(isAnchorModeActive(modePath), false);
});
