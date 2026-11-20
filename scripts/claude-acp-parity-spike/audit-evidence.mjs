import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve('.cat-cafe/tmp/claude-acp-parity');
const output = resolve('artifacts/claude-acp-parity-spike');
await mkdir(output, { recursive: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sha = async (file) => hash(await readFile(file));
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const currentRun = await readFile('scripts/claude-acp-parity-spike/run.mjs', 'utf8');
// Recover pre-edit runners only if the BEFORE-execution hash matches exactly.
const combinedRun = currentRun
  .replace("const hooksOnly = process.argv.includes('--hooks-only');\n", '')
  .replace("  scenario: hooksOnly ? 'hooks-only' : 'combined',\n", '')
  .replace('  if (!hooksOnly) {\n  const appendStart', '  const appendStart')
  .replace(/ {2}\} else \{\n {4}const primerStart[\s\S]*?\n {2}\}\n {2}const compactStart/, '  const compactStart');
const earlyRun = combinedRun
  .replace("import { appendFileSync } from 'node:fs';\n", '')
  .replace("  appendFileSync(join(state.dir, 'event-stream.jsonl'), `${JSON.stringify(event)}\\n`);\n", '')
  .replace(/const completedAndIdle = \(id, t\) => \{[\s\S]*?\n\};\n/, '')
  .replace('completedAndIdle(append, appendStart)', 'idleAfter(acceptedAt)')
  .replace('completedAndIdle(steered, steerStart)', 'idleAfter(steerStart)')
  .replace('completedAndIdle(follow, afterCompact)', 'idleAfter(afterCompact)')
  .replace(/ {2}const boundary = nativeAfter\(compactStart\)[^\n]*\n {2}assert\(boundary[^\n]*\n/, '');
const runs = ['sdk-original-2', 'sdk-matching-1', 'acp-1', 'sdk-original-hooks-1'];
const index = {
  observedAt: new Date().toISOString(),
  scope: 'bounded standalone real SDK/native versus ACP prototype; not Clowder product migration',
  noProductionChange: true,
  candidateFallbacks: 0,
  runs: [],
};
for (const run of runs) {
  const dir = join(root, 'runs', run);
  const result = await readJson(join(dir, 'result.json'));
  const before = await readJson(join(dir, 'manifest-before.json'));
  const events = await readJson(join(dir, 'events.json'));
  const snapshots = join(dir, 'executed-sources');
  await mkdir(snapshots, { recursive: true });
  const sources = [];
  for (const entry of before.sources) {
    const current = await readFile(`scripts/claude-acp-parity-spike/${entry.file}`, 'utf8');
    const preserved = await readFile(join(snapshots, entry.file), 'utf8').catch(() => undefined);
    const candidates = entry.file === 'run.mjs' ? [current, preserved, combinedRun, earlyRun] : [current, preserved];
    const actual = candidates.find((value) => value !== undefined && hash(value) === entry.sha256);
    assert(actual, `Cannot recover the exact executed source: ${run}/${entry.file}`);
    await writeFile(join(snapshots, entry.file), actual);
    sources.push({ file: entry.file, sha256: entry.sha256, matchedBeforeExecutionHash: true });
  }
  const accepted = events.filter((event) => event.kind === 'accepted');
  const selected = events.filter(
    (event) =>
      event.kind === 'accepted' ||
      event.kind.startsWith('hostHook') ||
      event.kind === 'bridgeSpawn' ||
      event.kind === 'bridgeExit' ||
      event.kind === 'transportError' ||
      (event.kind === 'native' &&
        (event.raw.type === 'result' ||
          event.raw.subtype === 'compact_boundary' ||
          event.raw.subtype === 'session_state_changed')),
  );
  await writeFile(
    join(output, `${run}.selected.jsonl`),
    selected.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  const hooks = events.filter((event) => event.kind.startsWith('hostHook'));
  const boundary = events.find((event) => event.kind === 'native' && event.raw.subtype === 'compact_boundary');
  if (result.cases.compaction?.success) {
    assert.equal(hooks.length, 4);
    assert(boundary.t >= hooks[3].t);
    assert(hooks[1].t - hooks[0].t >= 1400 && hooks[3].t - hooks[2].t >= 1400);
    assert(!result.consumptionReceipts.some((entry) => entry.inputId === result.cases.compaction.compactInput));
  }
  if (result.cases.append?.success) {
    assert(result.cases.append.consumed.t > result.cases.append.acceptedAt);
    const tools = result.cases.append.toolEvents;
    assert.equal(tools.filter((entry) => entry.event === 'started' && entry.phase === 'append').length, 1);
    assert.equal(tools.filter((entry) => entry.event === 'completed' && entry.phase === 'append').length, 1);
    assert.equal(tools.filter((entry) => entry.event === 'cancel_notification').length, 0);
  }
  const summary = {
    run,
    success: result.success,
    error: result.error,
    sdk: result.sdk,
    durationMs: Date.parse(result.finishedAt) - Date.parse(result.startedAt),
    cases: Object.keys(result.cases),
    inputCount: accepted.length,
    receipts: result.consumptionReceipts,
    hooks: hooks.map((event) => ({ t: event.t, kind: event.kind, hook: event.hook })),
    nativeBoundaryAt: boundary?.t,
    exactSourceSnapshots: snapshots,
    sources,
    rawEvidence: await Promise.all(
      ['manifest-before.json', 'events.json', 'result.json', 'processes.jsonl', 'tools.jsonl'].map(async (name) => ({
        path: join(dir, name),
        sha256: await sha(join(dir, name)),
      })),
    ),
    selectedEvidence: {
      path: join(output, `${run}.selected.jsonl`),
      sha256: await sha(join(output, `${run}.selected.jsonl`)),
    },
  };
  await writeFile(join(output, `${run}.json`), JSON.stringify(summary, null, 2) + '\n');
  await writeFile(join(output, `${run}.events.json.gz`), gzipSync(await readFile(join(dir, 'events.json'))));
  await copyFile(join(dir, 'result.json'), join(output, `${run}.result.json`));
  index.runs.push({ run, success: summary.success, cases: summary.cases, file: `${run}.json` });
}
const baseSource =
  process.env.CLOWDER_PARITY_UPSTREAM_AGENT_SOURCE;
const diff = spawnSync(
  'git',
  ['diff', '--no-index', '--ignore-space-at-eol', '--', baseSource, join(root, 'upstream/src/acp-agent.ts')],
  { encoding: 'utf8' },
);
assert([0, 1].includes(diff.status));
await writeFile(join(output, 'upstream.patch'), diff.stdout);
index.upstreamPatchSha256 = await sha(join(output, 'upstream.patch'));
index.green = [
  'append',
  'steer',
  'native consumption receipts',
  'synchronous compact hooks and model context adoption',
];
await writeFile(join(output, 'evidence-index.json'), JSON.stringify(index, null, 2) + '\n');
for (const name of ['wire-red.log', 'wire-green.log', 'build-patched.log'])
  await copyFile(join(root, name), join(output, name));
console.log(JSON.stringify({ audited: true, variants: index.runs, exactExecutedSourcesRecovered: true }));
