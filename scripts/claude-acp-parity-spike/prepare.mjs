import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const target = resolve(process.argv[2]);
const sourcePath = join(target, 'src/acp-agent.ts');
let source = (await readFile(sourcePath, 'utf8')).replaceAll('\r\n', '\n');
assert(!source.includes('from "./clowder-parity.js"'), 'Do not apply the patch twice');
const replace = (anchor, replacement) => {
  assert(source.includes(anchor), `Missing upstream anchor: ${anchor.slice(0, 80)}`);
  source = source.replace(anchor, replacement);
};
replace(
  'import { forkSession }',
  'import { auditSpawn, proofHooks, inputIdentity, proofInput, INPUT_METHOD } from "./clowder-parity.js";\nimport { forkSession }',
);
replace(
  '  extNotification(method: string, params: Record<string, unknown>): Promise<void>;',
  '  extRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;\n  extNotification(method: string, params: Record<string, unknown>): Promise<void>;',
);
replace(
  'class ClientConnection implements AcpClient {',
  'class ClientConnection implements AcpClient {\n  extRequest(method: string, params: Record<string, unknown>): Promise<unknown> { return this.ctx.request(method, params); }',
);
replace(
  'class ChangedMetaClient implements AcpClient {',
  'class ChangedMetaClient implements AcpClient {\n  extRequest(method: string, params: Record<string, unknown>): Promise<unknown> { if (!this.inner.extRequest) return Promise.reject(new Error("Unsupported proof request")); return this.inner.extRequest(method, params); }',
);
replace(
  '    const promptUuid = randomUUID();\n    userMessage.uuid = promptUuid;',
  '    const promptUuid = inputIdentity(params);\n    if (session.sentUserUuids?.has(promptUuid)) throw new Error("Duplicate proof input");\n    userMessage.uuid = promptUuid;',
);
replace(
  '      hooks: {\n        ...userProvidedOptions?.hooks,',
  '      hooks: {\n        ...userProvidedOptions?.hooks,\n        ...proofHooks(this.client, sessionId, params._meta),',
);
replace(
  '      ...userProvidedOptions,\n      // Claude Code uses',
  '      ...userProvidedOptions,\n      ...(process.env.CLOWDER_SPIKE_PROCESS_TRACE ? { spawnClaudeCodeProcess: auditSpawn } : {}),\n      // Claude Code uses',
);
replace(
  '        steering: {\n          supported: true,',
  '        clowderParity: { prototype: true, inputModes: ["append", "steer"], inputIdentity: "caller-uuid", hooks: "request-response" },\n        steering: {\n          supported: true,',
);
replace(
  '    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))',
  '    .onRequest<unknown, unknown>(INPUT_METHOD, { parse: (params) => params }, (ctx) => proofInput(agent, new ClientConnection(ctx), ctx.params))\n    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))',
);
// Request context also exposes request/notify, through ctx.client rather than ctx itself.
source = source.replace('new ClientConnection(ctx), ctx.params)', 'new ClientConnection(ctx.client), ctx.params)');
await copyFile(resolve('scripts/claude-acp-parity-spike/bridge-extension.ts'), join(target, 'src/clowder-parity.ts'));
await writeFile(sourcePath, source);
console.log(JSON.stringify({ patched: sourcePath, upstreamVersion: '0.97.0', prototype: true }));
