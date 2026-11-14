import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureInvocationMcpSources } from '../src/config/capabilities/invoke-mcp-config.js';
import { captureMcpEnvironment } from '../src/config/capabilities/mcp-environment-capture.js';
import { memberEnvironmentSchema, resolveMemberEnvironment } from '../src/config/member-environment.js';
import { acpConstructionEnvironment } from '../src/domains/cats/services/agents/providers/acp/configuration/acp-construction-environment.js';
import {
  captureEnvironmentReferences,
  resolveEnvReferences,
  withEnvironmentReferenceOverrides,
} from '../src/utils/env-references.js';

test('admission observes only referenced sources, including absent-to-present and races', async (t) => {
  const names = ['ROLE_CAPTURE_VALUE', 'ROLE_CAPTURE_OTHER'];
  const old = names.map((name) => process.env[name]);
  t.after(() =>
    names.forEach((name, index) => {
      if (old[index] === undefined) delete process.env[name];
      else process.env[name] = old[index];
    }),
  );
  delete process.env.ROLE_CAPTURE_VALUE;
  const capture = await captureInvocationMcpSources(() => resolveEnvReferences({ VALUE: '${ROLE_CAPTURE_VALUE}' }));
  assert.equal(capture.value.VALUE, '');
  process.env.ROLE_CAPTURE_OTHER = 'unrelated';
  assert.equal(capture.isCurrent(), true);
  process.env.ROLE_CAPTURE_VALUE = 'first';
  assert.equal(capture.isCurrent(), false);
  const hostRead = await withEnvironmentReferenceOverrides({ ROLE_CAPTURE_VALUE: 'admitted-MCP-value' }, () =>
    captureInvocationMcpSources(() => resolveMemberEnvironment({ VALUE: '${ROLE_CAPTURE_VALUE}' })),
  );
  assert.equal(hostRead.value.VALUE, 'first', 'a member declaration reads its Host source, not the derived MCP view');
  process.env.ROLE_CAPTURE_VALUE = 'second';
  assert.equal(hostRead.isCurrent(), false);
  process.env.ROLE_CAPTURE_VALUE = 'first';
  const raced = await captureEnvironmentReferences(async () => {
    resolveEnvReferences({ VALUE: '${ROLE_CAPTURE_VALUE}' });
    process.env.ROLE_CAPTURE_VALUE = 'second';
    resolveEnvReferences({ VALUE: '${ROLE_CAPTURE_VALUE}' });
    process.env.ROLE_CAPTURE_VALUE = 'first';
  });
  assert.equal(raced.isCurrent(), false, 'an ABA change observed during capture is not a stable source');
});

test('all MCP projections use the admitted account/member value and do not re-expand secret bytes', () => {
  const plan = withEnvironmentReferenceOverrides({ ROLE_CAPTURE_VALUE: 'admitted-${LITERAL_BYTES}' }, () =>
    captureMcpEnvironment({
      command: 'fixture',
      env: { VALUE: '${ROLE_CAPTURE_VALUE}' },
      headers: { Authorization: 'Bearer ${ROLE_CAPTURE_VALUE}' },
      environment: { OPENCODE_VALUE: '${ROLE_CAPTURE_VALUE}' },
    }),
  );
  assert.equal(plan.env.VALUE, 'admitted-${LITERAL_BYTES}');
  assert.equal(plan.headers.Authorization, 'Bearer admitted-${LITERAL_BYTES}');
  assert.equal(plan.environment.OPENCODE_VALUE, 'admitted-${LITERAL_BYTES}');
});

test('concurrent invocations retain distinct account/member reference scopes across asynchronous capture', async () => {
  const views = await Promise.all(
    ['account-A', 'account-B'].map((value) =>
      withEnvironmentReferenceOverrides(Object.freeze({ ROLE_CONCURRENT_VALUE: value }), () =>
        captureInvocationMcpSources(async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return captureMcpEnvironment({ headers: { Authorization: 'Bearer ${ROLE_CONCURRENT_VALUE}' } });
        }),
      ),
    ),
  );
  assert.deepEqual(
    views.map(({ value }) => value.headers.Authorization),
    ['Bearer account-A', 'Bearer account-B'],
  );
  assert.ok(views.every((view) => view.isCurrent()));
});

test('member env declarations reject Host authority keys and references, retaining ordinary compatibility', () => {
  for (const env of [
    { CAT_CAFE_CALLBACK_TOKEN: 'forbidden' },
    { VALUE: '${CAT_CAFE_CALLBACK_TOKEN}' },
    { VALUE: '${CLOWDER_PLUGIN_123_ACTION_TOKEN}' },
    { VALUE: '${CODEX_CAT_EXPECTED_USER_ID}' },
    { VALUE: '${cat_cafe_callback_token}' },
    { 'bad-key': 'invalid' },
  ])
    assert.equal(memberEnvironmentSchema.safeParse(env).success, false);
  assert.deepEqual(resolveMemberEnvironment({ https_proxy: 'http://proxy.example.test', CUSTOM_ARGUMENT: 'literal' }), {
    https_proxy: 'http://proxy.example.test',
    CUSTOM_ARGUMENT: 'literal',
  });
});

test('Windows process dependencies follow native case-insensitive and first-sorted-key semantics', () => {
  const before = acpConstructionEnvironment('acp', { Path: 'original-path', SystemRoot: 'original-root' }, {}, 'win32');
  assert.equal(before.PATH, 'original-path');
  assert.equal(before.SYSTEMROOT, 'original-root');
  const after = acpConstructionEnvironment('acp', { Path: 'changed-path', SystemRoot: 'original-root' }, {}, 'win32');
  assert.notDeepEqual(before, after);
  const duplicates = acpConstructionEnvironment('acp', { Path: 'shadowed', PATH: 'effective' }, {}, 'win32');
  assert.equal(duplicates.PATH, 'effective');
  const reordered = acpConstructionEnvironment('acp', { PATH: 'effective', Path: 'shadowed' }, {}, 'win32');
  assert.deepEqual(duplicates, reordered);
});
