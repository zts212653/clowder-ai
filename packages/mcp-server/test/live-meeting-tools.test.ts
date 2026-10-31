import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { CANONICAL_TOOL_SOURCES } from '../src/canonical-server-tools.js';
import { buildCanonicalToolRegistry, projectCanonicalToolRegistry } from '../src/canonical-tool-registry.js';
import { resolveToolGovernanceEvidence } from '../src/tool-governance-evidence.js';
import { resolveMcpImplementationCatalog } from '../src/tool-governance-implementation.js';
import { validateToolGovernance } from '../src/tool-governance-validation.js';
import { liveMeetingTools } from '../src/tools/live-meeting-tools.js';

test('canonical registration exposes only five bounded Live capabilities, with no microphone or owner/call selector', () => {
  const registry = buildCanonicalToolRegistry(CANONICAL_TOOL_SOURCES);
  const live = projectCanonicalToolRegistry(registry, { desktopMode: 'live-companion' });
  const meeting = live.filter((t) => t.policy.resourceFamily === 'live-meeting');
  assert.deepEqual(
    meeting.map((t) => t.name),
    [
      'cat_cafe_meeting_attach',
      'cat_cafe_meeting_sources',
      'cat_cafe_meeting_start',
      'cat_cafe_meeting_status',
      'cat_cafe_meeting_stop',
    ],
  );
  assert.equal(
    live.some((t) => t.serverFamily === 'audio'),
    false,
  );
  for (const env of [
    { readonly: true },
    { desktopMode: 'fable-phase0' },
    { desktopMode: 'cloud-pro-phase0' },
    { readonly: true, hasAgentKey: true, agentKeyUnion: true },
  ])
    assert.equal(
      projectCanonicalToolRegistry(registry, env).some((t) => t.policy.resourceFamily === 'live-meeting'),
      false,
    );
  for (const tool of meeting) {
    for (const forbidden of ['userId', 'owner', 'callId', 'threadId', 'meetingId', 'mic', 'inputs', 'mode']) {
      if (forbidden === 'meetingId' && tool.name === 'cat_cafe_meeting_stop') continue;
      assert.equal(forbidden in tool.inputSchema, false, `${tool.name}:${forbidden}`);
    }
  }
});

test('start and existing-transcript attachment declare separate actions and effects', () => {
  const start = liveMeetingTools.find((t) => t.name === 'cat_cafe_meeting_start');
  const attach = liveMeetingTools.find((t) => t.name === 'cat_cafe_meeting_attach');
  assert.ok(start);
  assert.ok(attach);
  assert.deepEqual(start.actionInventory, ['start']);
  assert.deepEqual(attach.actionInventory, ['attach']);
  assert.equal(start.annotations.readOnlyHint, false);
  assert.equal(attach.annotations.readOnlyHint, false);
  assert.equal(liveMeetingTools.find((t) => t.name === 'cat_cafe_meeting_status')?.annotations.readOnlyHint, true);
});

test('candidate can enter the canonical registry with real admitted evidence and compiler/runtime export identity', async () => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
  const evidenceCatalog = await resolveToolGovernanceEvidence({
    repoRoot,
    refs: [
      'architecture-cell:live-meeting',
      'architecture-cell:mcp-surface-governance',
      'file:packages/mcp-server/src/tools/live-meeting-tools.ts',
      'test:packages/mcp-server/test/tool-registration.test.js',
    ],
  });
  const implementationCatalog = await resolveMcpImplementationCatalog({
    repoRoot,
    definitions: liveMeetingTools,
    loadRuntimeModule: async () => import('../src/tools/live-meeting-tools.js'),
  });
  const result = validateToolGovernance(liveMeetingTools, {
    evidenceCatalog,
    implementationCatalog,
    protectedBase: new Map(),
  });
  assert.equal(result.ok, true, JSON.stringify(result.findings));
});

test('opaque legacy meeting IDs can be echoed verbatim as the optimistic stop target', () => {
  const stop = liveMeetingTools.find((t) => t.name === 'cat_cafe_meeting_stop');
  assert.ok(stop);
  const schema = z.object(stop.inputSchema);
  for (const meetingId of ['meeting:2026-10-09', 'Meeting with spaces 与中文', 'legacy-' + 'a'.repeat(200)])
    assert.equal(schema.safeParse({ meetingId }).success, true, meetingId);
});
