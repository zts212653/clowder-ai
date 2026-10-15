import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const source = resolve(process.argv[2] ?? '../../.research-20261013-codex-acp');
const target = resolve(
  '.cat-cafe/tmp/acp-prototypes',
  process.argv.includes('--disable-auto-title') ? 'codex-no-title' : 'codex',
);
const pin = '51f78d67e46c3a96ee8d8bf4e43fc917ab21c73e';
if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin)
  throw new Error('Codex upstream pin mismatch');
await mkdir(target, { recursive: true });
for (const file of ['src', 'package.json', 'package-lock.json', 'tsconfig.json', 'build.mjs', 'vitest.config.ts']) {
  try {
    await cp(join(source, file), join(target, file), { recursive: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
await cp('scripts/acp-spikes/codex-native-fence.ts', join(target, 'src/ClowderNativeFence.ts'));
await cp('scripts/acp-spikes/codex-control-journal.ts', join(target, 'src/codex-control-journal.ts'));
await cp(
  'scripts/acp-spikes/codex-bridge-extension.test.template.ts',
  join(target, 'src/__tests__/clowder-fence.test.ts'),
);
const file = join(target, 'src/CodexAcpServer.ts');
let text = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
text = "import { CodexNativeFence } from './ClowderNativeFence';\n" + text;
text = text.replace(
  '    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {',
  `    private clowderControlAttempts = 0;
    private readonly clowderFence = new CodexNativeFence(sessionId => this.getSessionState(sessionId), {
        steerTurn: async params => {
            const native = await this.codexAcpClient.steerTurn(params);
            // Test-only crash window: native accepted, durable receipt not yet written.
            if (++this.clowderControlAttempts > 1 && process.env['CLOWDER_SPIKE_LOSE_NATIVE_REPLY'] === 'after-first')
                throw new Error('spike_lost_native_reply_after_acceptance');
            return native;
        },
        readUserMessage: params => this.codexAcpClient.readClowderControlInput(params),
    }, (() => {
        const journalDirectory = process.env['CLOWDER_CONTROL_JOURNAL'];
        const bindingRevision = process.env['CLOWDER_CONTROL_BINDING_REVISION'];
        if (!journalDirectory && !bindingRevision) return undefined;
        if (!journalDirectory || !bindingRevision) throw new Error('incomplete_control_journal_binding');
        return { journalDirectory, bindingRevision };
    })());
    async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === '_clowder/v1/control') {
            try { return await this.clowderFence.handle(params); }
            catch (error) { throw new RequestError(-32600, error instanceof Error ? error.message : 'control_failed'); }
        }`,
);
if (!text.includes('return await this.clowderFence.handle(params)')) throw new Error('Bridge extension hook missing');
await writeFile(file, text);
const clientFile = join(target, 'src/CodexAcpClient.ts');
let clientText = (await readFile(clientFile, 'utf8')).replaceAll('\r\n', '\n');
const signatureAnchor = 'async steerTurn(params: { threadId: string, turnId: string, prompt: acp.ContentBlock[] })';
if (!clientText.includes(signatureAnchor)) throw new Error('Codex native steer signature anchor missing');
clientText = clientText.replace(
  signatureAnchor,
  'async steerTurn(params: { threadId: string, turnId: string, prompt: acp.ContentBlock[], clientUserMessageId?: string })',
);
clientText = clientText.replace(
  '            expectedTurnId: params.turnId,',
  '            expectedTurnId: params.turnId,\n            ...(params.clientUserMessageId ? { clientUserMessageId: params.clientUserMessageId } : {}),',
);
const readAnchor = '    async fetchAvailableModels(): Promise<Model[]> {';
if (!clientText.includes(readAnchor)) throw new Error('Codex native history anchor missing');
clientText = clientText.replace(
  readAnchor,
  `    async readClowderControlInput(params: { threadId: string, turnId: string, clientUserMessageId: string }) {
        const history = await this.codexClient.threadReadWithHistory(params.threadId);
        if (history.thread.id !== params.threadId) throw new Error('native_history_session_mismatch');
        const turn = history.thread.turns.find(turn => turn.id === params.turnId);
        const matches = turn?.items.filter(item => item.type === 'userMessage' && item.clientId === params.clientUserMessageId) ?? [];
        if (matches.length > 1) throw new Error('native_history_ambiguous');
        const item = matches[0];
        if (!item || item.type !== 'userMessage' || item.clientId !== params.clientUserMessageId ||
            item.content.some(block => block.type !== 'text')) return null;
        const prompt = item.content.map(block => {
            if (block.type !== 'text') throw new Error('native_history_content_mismatch');
            return { type: 'text' as const, text: block.text };
        });
        return { nativeSessionId: history.thread.id, nativeTurnId: params.turnId, nativeItemId: item.id,
            clientUserMessageId: item.clientId, prompt };
    }
${readAnchor}`,
);
await writeFile(clientFile, clientText);
const entry = join(target, 'src/index.ts');
let entryText = await readFile(entry, 'utf8');
const routeAnchor =
  '.onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAgent().extMethod(SESSION_STEERING_METHOD, ctx.params))';
if (!entryText.includes(routeAnchor)) throw new Error('ACP wire route anchor missing');
entryText = entryText.replace(
  routeAnchor,
  `${routeAnchor}\n        .onRequest('_clowder/v1/control', z.record(z.string(), z.unknown()), (ctx) => getAgent().extMethod('_clowder/v1/control', ctx.params))`,
);
await writeFile(entry, entryText);
const turnAnchor = 'sessionState.currentTurnId = turnId;';
const metaAnchor = '            _meta: {\n                steering: {';
if (!text.includes(metaAnchor)) throw new Error('Codex capability anchor missing');
text = text.replace(
  metaAnchor,
  `            _meta: {
                _clowder: { controlV1: { prototype: true, version: 1, method: '_clowder/v1/control', nativeIdMethod: '_clowder/v1/turn_started' } },
                steering: {`,
);
text = text.replaceAll(
  turnAnchor,
  `${turnAnchor}\n                    void this.connection.notify('_clowder/v1/turn_started', {sessionId: sessionState.sessionId, nativeSessionId: sessionState.sessionId, nativeTurnId: turnId}).catch(error => logger.log('Clowder native ID export failed', {error: String(error)}));`,
);
await writeFile(file, text);
const loggerFile = join(target, 'src/Logger.ts');
let loggerText = await readFile(loggerFile, 'utf8');
loggerText = loggerText.replace(
  'fs.appendFileSync(this.logFilePath, `${line}\\n`);',
  `const redactionPath = process.env['CLOWDER_TRACE_REDACTIONS_FILE'];
            let safeLine = line;
            if (redactionPath) for (const secret of JSON.parse(fs.readFileSync(redactionPath, 'utf8')) as unknown[]) {
                if (typeof secret === 'string' && secret.length > 15) safeLine = safeLine.split(secret).join('[redacted]');
            }
            fs.appendFileSync(this.logFilePath, safeLine + '\\n');`,
);
await writeFile(loggerFile, loggerText);
if (process.argv.includes('--disable-auto-title')) {
  const titleFile = join(target, 'src/TitleGenerator.ts');
  let title = await readFile(titleFile, 'utf8');
  const anchor = '    onTurnCompleted(userPromptText: string): void {';
  if (!title.includes(anchor)) throw new Error('Title budget anchor missing');
  title = title.replace(
    anchor,
    `${anchor}\n        if (process.env['CLOWDER_SPIKE_DISABLE_AUTO_TITLE'] === '1') return;`,
  );
  await writeFile(titleFile, title);
  await cp(
    'scripts/acp-spikes/codex-title-budget.test.template.ts',
    join(target, 'src/__tests__/clowder-title-budget.test.ts'),
  );
  const dependencies = resolve('.cat-cafe/tmp/acp-prototypes/codex/node_modules');
  try {
    await symlink(dependencies, join(target, 'node_modules'), 'junction');
  } catch (error) {
    if (error.code !== 'EEXIST' || (await realpath(join(target, 'node_modules'))) !== (await realpath(dependencies)))
      throw error;
  }
}
console.log(
  JSON.stringify({
    source,
    target,
    upstream: pin,
    extension: '_clowder/v1/control',
    scope: 'W4.P not production',
    nativeVerification: 'pending',
  }),
);
