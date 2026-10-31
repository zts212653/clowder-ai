import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { nativeRuntimeReadiness } from '../src/routes/native-runtime-readiness.js';
import { probeRuntimeCatalog } from '../src/routes/runtime-catalog-probe.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'codex-discovery-'));
  const state = join(root, 'native-history-state');
  const transcript = join(root, 'commands.jsonl');
  const program = join(root, 'codex.cjs');
  const command = join(root, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  writeFileSync(state, 'original native history');
  writeFileSync(
    program,
    `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(args)+'\\n');
if (args[0] === 'login' && args[1] === 'status') {
  console.error('Logged in using ChatGPT');
} else if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({models:[
    {slug:'test-model',display_name:'Test model',visibility:'list',supported_reasoning_levels:[{effort:'low',description:'Low effort'}],base_instructions:'private native instructions'},
    {slug:'hidden-model',visibility:'hide'}
  ]}));
} else {
  fs.writeFileSync(${JSON.stringify(state)}, 'interrupted backfill');
  process.exit(1);
}
`,
  );
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${program}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${program}" "$@"\n`,
  );
  chmodSync(command, 0o755);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, command, state, transcript, program };
}

test('Codex login discovery does not initialize or interrupt native history', async (t) => {
  const f = fixture(t);
  const value = await nativeRuntimeReadiness({ id: 'codex', installed: true, command: f.command }, f.root, true);
  assert.equal(readFileSync(f.state, 'utf8'), 'original native history');
  assert.equal(value.status, 'configured');
  assert.deepEqual(
    readFileSync(f.transcript, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [['login', 'status']],
  );
});

test('Codex model discovery preserves native history and exposes only catalog metadata', async (t) => {
  const f = fixture(t);
  const value = await probeRuntimeCatalog({ kind: 'codex', command: f.command, args: [], cwd: f.root });
  assert.equal(readFileSync(f.state, 'utf8'), 'original native history');
  assert.equal(value.status, 'live');
  assert.deepEqual(value.models, [
    {
      value: 'test-model',
      label: 'Test model',
      description: undefined,
      efforts: [{ value: 'low', label: 'low', description: 'Low effort' }],
    },
  ]);
  assert.doesNotMatch(JSON.stringify(value), /private native instructions|hidden-model/);
  assert.deepEqual(
    readFileSync(f.transcript, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [['debug', 'models']],
  );
});

for (const scenario of [
  { output: 'Logged in using an API key - private-sentinel', code: 0, expected: 'configured' },
  {
    output: 'WARNING: unable to create PATH alias - private-sentinel\nLogged in using ChatGPT',
    code: 0,
    expected: 'configured',
  },
  { output: 'Not logged in', code: 1, expected: 'login_required' },
  { output: 'Logged in using ChatGPT', code: 1, expected: 'unknown' },
  { output: 'network failure private-sentinel', code: 2, expected: 'unknown' },
]) {
  test(`Codex login status handles exit ${scenario.code}: ${scenario.expected}`, async (t) => {
    const f = fixture(t);
    writeFileSync(f.program, `console.error(${JSON.stringify(scenario.output)});process.exit(${scenario.code});`);
    const result = await nativeRuntimeReadiness({ id: 'codex', installed: true, command: f.command }, f.root, true);
    assert.equal(result.status, scenario.expected);
    assert.doesNotMatch(JSON.stringify(result), /private-sentinel|network failure/);
  });
}

test('unsupported native catalog command remains unavailable without an App Server fallback', async (t) => {
  const f = fixture(t);
  writeFileSync(f.program, `console.error('unknown debug command private-sentinel');process.exit(2);`);
  await assert.rejects(probeRuntimeCatalog({ kind: 'codex', command: f.command, args: [], cwd: f.root }), {
    message: 'catalog_unavailable',
  });
  assert.equal(readFileSync(f.state, 'utf8'), 'original native history');
});

for (const profile of [false, true]) {
  test(`a native third-party provider without OpenAI auth does not require ChatGPT login (profile=${profile})`, async (t) => {
    const f = fixture(t);
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = f.root;
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    });
    writeFileSync(
      join(f.root, 'config.toml'),
      `${profile ? 'profile="fixture"\n[profiles.fixture]\n' : ''}model_provider="fixture"\n[model_providers.fixture]\nname="Fixture"\nwire_api="responses"\nrequires_openai_auth=false\n`,
    );
    writeFileSync(f.program, "console.error('Not logged in');process.exit(1);");
    const result = await nativeRuntimeReadiness({ id: 'codex', installed: true, command: f.command }, f.root, true);
    assert.equal(result.status, 'configured');
    assert.equal(readFileSync(f.state, 'utf8'), 'original native history');
  });
}
