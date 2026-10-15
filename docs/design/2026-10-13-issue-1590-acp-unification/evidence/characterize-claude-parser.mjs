import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const root = resolve(option('--source-root') ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));
const output = option('--output');
const provider = 'packages/api/src/domains/cats/services/agents/providers';
const temp = join(root, '.cat-cafe/tmp/issue-1590-parser-characterization');
await mkdir(temp, { recursive: true });
const hashes = {};
for (const name of ['claude-ndjson-parser', 'claude-mcp-status']) {
  const source = await readFile(join(root, provider, `${name}.ts`), 'utf8');
  hashes[`${name}.ts`] = createHash('sha256').update(source).digest('hex');
  const transformed = stripTypeScriptTypes(source, { mode: 'strip' });
  await writeFile(join(temp, `${name}.js`), transformed, 'utf8');
}
await writeFile(join(temp, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
const { transformClaudeEvent } = await import(pathToFileURL(join(temp, 'claude-ndjson-parser.js')).href);
const samples = [];
for (const fixture of [
  { name: 'success', id: 'call-success', failed: false },
  { name: 'failure', id: 'call-failure', failed: true },
  { name: 'child-success', id: 'call-child', failed: false, parent: 'parent-call' },
]) {
  const state = {
    currentMessageId: undefined,
    partialTextMessageIds: new Set(),
    lastTurnInputTokens: undefined,
    thinkingBuffer: '',
  };
  const start = transformClaudeEvent(
    {
      type: 'assistant',
      parent_tool_use_id: fixture.parent,
      message: {
        id: `message-${fixture.id}`,
        content: [{ type: 'tool_use', id: fixture.id, name: 'Read', input: { file_path: 'synthetic.txt' } }],
      },
    },
    'codex',
    state,
  );
  const starts = Array.isArray(start) ? start : start ? [start] : [];
  assert.ok(starts.some((event) => event.type === 'tool_use' && event.toolUseId === fixture.id));
  const result = transformClaudeEvent(
    {
      type: 'user',
      parent_tool_use_id: fixture.parent,
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: fixture.id,
            is_error: fixture.failed,
            content: fixture.failed ? 'synthetic failure' : 'synthetic success',
          },
        ],
      },
    },
    'codex',
    state,
  );
  const results = Array.isArray(result) ? result : result ? [result] : [];
  samples.push({
    name: fixture.name,
    nativeToolUseId: fixture.id,
    toolUseEmitted: true,
    resultEventCount: results.length,
    toolResultEmitted: results.some((event) => event.type === 'tool_result'),
    result,
  });
}
const report = {
  evidenceLevel: 'L0',
  syntheticInputs: true,
  realModelCalled: false,
  bridgeExecuted: false,
  storageOrUiVerified: false,
  sourceHead: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sourceHashes: hashes,
  nodeVersion: process.version,
  typeStripper: 'node:module.stripTypeScriptTypes',
  samples,
  result: samples.every((sample) => !sample.toolResultEmitted)
    ? 'tool_result_gap_observed'
    : 'reinspect_parser_behavior',
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(resolve(output), serialized, 'utf8');
process.stdout.write(serialized);
