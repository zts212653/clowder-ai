import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// 回读既有安装依赖与合成实验记录；不启动模型、不读取认证或业务历史。
const [rootArg, sdkArg, historyArg, outputArg] = process.argv.slice(2);
if (!rootArg || !sdkArg || !historyArg || !outputArg) throw new Error('ROOT SDK_PACKAGE HISTORY_WORKTREE OUTPUT required');
const root = resolve(rootArg);
const sdk = resolve(sdkArg);
const history = resolve(historyArg);
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const hashFiles = async (base, paths) => Promise.all(paths.map(async (path) => ({ path, sha256: await sha(join(base, path)) })));
const gitHead = (cwd) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
const sourceFiles = [
  'packages/api/package.json',
  'packages/api/src/domains/cats/services/agents/providers/ClaudeSdkAgentService.ts',
  'packages/api/src/domains/cats/services/agents/providers/claude-sdk-launch.ts',
  'packages/api/src/domains/cats/services/agents/providers/claude-sdk-compaction-hooks.ts',
  'packages/api/src/domains/cats/services/agents/providers/acp/AcpAgentService.ts',
  'packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.ts',
  'packages/api/src/domains/cats/services/agents/providers/acp/acp-event-transformer.ts',
  'packages/api/src/routes/runtime-catalog-probe.ts',
  'packages/api/src/domains/cats/services/session/import/LocalSessionInspection.ts',
];
const files = await readdir(sdk, { withFileTypes: true });
let sdkOwnBytes = 0;
for (const file of files) if (file.isFile()) sdkOwnBytes += (await readFile(join(sdk, file.name))).length;
const native = createRequire(join(sdk, 'package.json')).resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
const nativeBytes = (await readFile(native)).length;
const historical = [];
for (const mode of ['now-owner-final', 'next-owner-final']) {
  const base = join(history, '.cat-cafe/tmp/authorized-claude-notice-20261013', mode);
  const result = await readJson(join(base, 'result.json'));
  const wire = await readJson(join(base, 'wire.json'));
  const controls = await readJson(join(base, 'controls.json'));
  const timeline = [];
  for (const entry of wire) {
    const message = entry.message;
    const raw = message?.params?.message;
    if (raw?.type === 'result') timeline.push({ t: entry.t, type: 'native_result',
      subtype: raw.subtype, stopReason: raw.stop_reason, inputUuid: raw.user_message_uuid,
      inputUuids: raw.user_message_uuids, terminalReason: raw.terminal_reason,
      origin: raw.origin, resultIndex: raw.result_index, isError: raw.is_error });
    if (raw?.type === 'system' && ['session_state_changed', 'async_message_queued',
      'async_message_started', 'async_message_completed', 'async_message_cancelled'].includes(raw.subtype)) {
      timeline.push({ t: entry.t, type: raw.subtype, state: raw.state, inputUuid: raw.message_uuid });
    }
    const content = raw?.message?.content;
    if (Array.isArray(content)) for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const serialized = JSON.stringify(block.content);
      if (/background/i.test(serialized)) timeline.push({ t: entry.t, type: 'tool_result',
        toolUseId: block.tool_use_id, movedToBackground: /background/i.test(serialized),
        explicitNotInterrupted: /not interrupted|not been interrupted|was not interrupted/i.test(serialized) });
    }
    if (message?.result?.stopReason) timeline.push({ t: entry.t, type: 'acp_result', stopReason: message.result.stopReason });
  }
  historical.push({ mode, kind: 'historical_real_native_with_local_bridge_patch',
    sourceDirectory: base, bridgePin: result.bridgePin, sdkVersion: result.sdkVersion,
    nativeCli: result.nativeCli, durationMs: result.durationMs, receipt: result.aReceipt,
    success: result.success, methods: controls.map((entry) => entry.method), timeline,
    hashes: await hashFiles(base, ['result.json', 'wire.json', 'controls.json', 'fixture-tool-events.jsonl']) });
}
const base = join(root, '.cat-cafe/tmp/claude-sdk-acp-research');
const result = { observedAt: new Date().toISOString(), clowderBase: gitHead(root),
  adapterSource: gitHead(join(base, 'claude-agent-acp')), protocolSource: gitHead(join(base, 'protocol')),
  sdkSize: { version: (await readJson(join(sdk, 'package.json'))).version,
    sourcePackageDirectory: sdk, sdkOwnBytes, sdkOwnMiB: sdkOwnBytes / 1048576,
    nativePath: native, nativeBytes, nativeMiB: nativeBytes / 1048576, nativeSha256: await sha(native),
    scope: 'logical unpacked file bytes; excludes peer packages; not installer compression or exclusive disk use' },
  clowderSourceHashes: await hashFiles(root, sourceFiles), historical,
  freshValidationLogs: await hashFiles(base, ['adapter-build.log', 'steering-tests-green.log']),
  cleanup: { serversStarted: 0, modelCalls: 0, nativeSessionsCreated: 0,
    retention: 'research checkout and isolated dependency cache retained for review until 2026-11-03T23:59:59+08:00' } };
await writeFile(resolve(outputArg), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output: resolve(outputArg), sizes: result.sdkSize,
  historical: historical.map((entry) => ({ mode: entry.mode, timelineEvents: entry.timeline.length })) }));
