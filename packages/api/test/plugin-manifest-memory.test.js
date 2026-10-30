import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { validateManifest } from '@clowder-ai/plugin-contract';

const execFileAsync = promisify(execFile);

function manifest() {
  return {
    pluginId: 'dev.clowder.manifest-memory-fixture',
    version: '1.0.0',
    contractVersion: '0.2.0',
    name: 'Manifest memory fixture',
    features: [{ id: 'fixture', name: 'Fixture', resources: [] }],
    runtime: { transport: 'builtin' },
    configuration: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        required: true,
        default: 'a',
        options: ['a', 'b', 'c'].map((value) => ({ value, label: value })),
      },
    ],
    configurationVariants: {
      discriminator: 'mode',
      branches: [
        { id: 'a', when: { properties: { mode: { const: 'a' } } }, fields: [] },
        { id: 'bc', when: { properties: { mode: { enum: ['b', 'c'] } } }, fields: [] },
      ],
    },
  };
}

test('repeated manifest validation keeps retained heap bounded across freshly read configurations', async () => {
  // The production failure retained newly compiled branch schemas in a global Ajv.
  // A separate process permits GC without disturbing the test runner or any API.
  const child = `
    import assert from 'node:assert/strict';
    import { setImmediate } from 'node:timers/promises';
    import { validateManifest } from '@clowder-ai/plugin-contract';
    const input = ${JSON.stringify(manifest())};
    const validate = () => assert.equal(validateManifest(structuredClone(input)).valid, true);
    for (let i = 0; i < 200; i++) validate();
    await setImmediate();
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 4000; i++) validate();
    await setImmediate();
    global.gc(); global.gc();
    const after = process.memoryUsage().heapUsed;
    console.log(JSON.stringify({ before, after, growth: after - before }));
  `;
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=256', '--input-type=module', '--eval', child],
    { cwd: new URL('..', import.meta.url), env, timeout: 20_000, maxBuffer: 64 * 1024 },
  );
  const memory = JSON.parse(stdout);
  assert.ok(memory.growth < 8 * 1024 * 1024, `retained manifest validation heap grew: ${JSON.stringify(memory)}`);
});

test('variant exclusivity remains current when a previously valid manifest changes', () => {
  const input = manifest();
  assert.equal(validateManifest(input).valid, true);

  input.configurationVariants.branches[1].when.properties.mode.enum = ['a', 'b', 'c'];
  let result = validateManifest(input);
  assert.equal(result.valid, false, 'overlapping const and enum branches must fail');
  assert.equal(result.errors[0].keyword, 'completeExclusiveBranches');

  input.configurationVariants.branches[1].when.properties.mode.enum = ['b'];
  result = validateManifest(input);
  assert.equal(result.valid, false, 'every declared option still needs a branch');
  assert.equal(result.errors[0].keyword, 'completeExclusiveBranches');

  input.configurationVariants.branches[1].when.properties.mode.enum = ['b', 'c'];
  assert.equal(validateManifest(input).valid, true, 'restoring a valid branch must succeed');
});
