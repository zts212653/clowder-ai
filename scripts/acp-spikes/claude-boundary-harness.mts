import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { AcpClient } from '../../packages/api/src/domains/cats/services/agents/providers/acp/AcpClient.js';
import type { AcpAgentRequest } from '../../packages/api/src/domains/cats/services/agents/providers/acp/types.js';

export async function createClaudeBoundaryHarness({
  bridge,
  dir,
  trace,
  nativePath,
  ingressFault,
}: {
  bridge: string;
  dir: string;
  trace: string;
  nativePath: string;
  ingressFault: boolean;
}) {
  const settings = JSON.parse(await readFile(join(homedir(), '.claude/settings.json'), 'utf8'));
  const authEnv = Object.fromEntries(
    Object.entries(settings.env ?? {}).filter(
      ([key, value]) =>
        typeof value === 'string' &&
        (key.startsWith('ANTHROPIC_') || ['CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL'].includes(key)),
    ),
  );
  const events: Record<string, unknown>[] = [],
    wire: Array<{ t: number; message: Record<string, unknown> }> = [],
    controls: unknown[] = [],
    elicitations: unknown[] = [];
  let pendingAnswer: (() => void) | undefined, sessionId: string | undefined;
  const client = new AcpClient({
    command: process.execPath,
    args: [join(bridge, 'dist/index.js')],
    cwd: join(dir, 'fixture'),
    env: {
      ...authEnv,
      CLOWDER_SPIKE_HOLD_SDK_NEXT: ingressFault ? '1' : '',
      CLAUDE_CONFIG_DIR: join(dir, 'home'),
      CLAUDECODE: '',
      CLAUDE_CODE_ENTRYPOINT: '',
      CLAUDE_CODE_EXECUTABLE: nativePath,
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Program Files/Git/bin/bash.exe',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
    },
    spawnFn(command, args, options) {
      const child = spawn(command, args, { ...options, windowsHide: true });
      const nativeIn = child.stdin!;
      let input = '',
        output = '';
      const inbound = new Transform({
        transform(chunk, _encoding, callback) {
          input += chunk.toString();
          const lines = input.split('\n');
          input = lines.pop()!;
          for (const line of lines) {
            const packet = JSON.parse(line);
            if (packet.method === 'initialize') packet.params.clientCapabilities = { elicitation: { form: {} } };
            this.push(JSON.stringify(packet) + '\n');
          }
          callback();
        },
      });
      inbound.pipe(nativeIn);
      Object.defineProperty(child, 'stdin', { value: inbound });
      child.stdout?.on('data', (chunk) => {
        output += chunk.toString();
        const lines = output.split('\n');
        output = lines.pop()!;
        for (const line of lines) {
          try {
            wire.push({ t: Date.now(), message: JSON.parse(line) });
          } catch {}
        }
      });
      return child;
    },
    permissionTimeoutMs: 25000,
    permissionHandler(request, respond) {
      const call = request.params?.toolCall as Record<string, unknown> | undefined;
      const input = call?.rawInput as Record<string, unknown> | undefined;
      const allowed =
        String(call?.title ?? '').includes('read_fixture') &&
        input &&
        ['elicitation', 'cancel'].includes(String(input.scenario)) &&
        input.delayMs === 8000;
      const option = (request.params?.options as Array<{ optionId: string; kind: string }> | undefined)?.find(
        (o) => o.kind === 'allow_once',
      );
      respond(allowed && option ? { optionId: option.optionId } : { cancelled: true });
    },
  });
  const seam = client as unknown as {
    child: { stdin: { write(s: string): void } };
    handleAgentRequest(r: AcpAgentRequest): void;
    sendRequest(m: string, p: Record<string, unknown>, t: number): Promise<{ result: Record<string, unknown> }>;
    notificationListeners: Array<(n: { method: string; params?: Record<string, unknown> }) => void>;
  };
  const normalRequest = seam.handleAgentRequest.bind(client);
  seam.handleAgentRequest = (request) => {
    if (request.method !== 'elicitation/create') return normalRequest(request);
    const params = request.params as Record<string, unknown>;
    assert.equal(params.sessionId, sessionId);
    assert.equal(params.mode, 'form');
    const schema = params.requestedSchema as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(schema.properties), ['confirm']);
    elicitations.push({ t: Date.now(), id: request.id, params, answered: false });
    pendingAnswer = () => {
      elicitations.push({ t: Date.now(), id: request.id, syntheticAnswer: { confirm: true } });
      seam.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { confirm: true } } }) +
          '\n',
      );
    };
  };
  seam.notificationListeners.push((notification) => {
    if (notification.method === '_claude/sdkMessage')
      events.push({ t: Date.now(), type: 'raw_sdk', ...notification.params });
    if (notification.method === '_clowder/ingressFault')
      events.push({ t: Date.now(), type: 'ingress_fault', ...notification.params });
  });
  const native = () =>
    events.filter((e) => e.type === 'raw_sdk') as Array<{ t: number; message: Record<string, unknown> }>;
  const lifecycle = (uuid: unknown) =>
    native().filter((e) => e.message.type === 'command_lifecycle' && e.message.command_uuid === uuid);
  const toolEvents = async () =>
    (await readFile(trace, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 50000) {
    const since = Date.now();
    while (Date.now() - since < timeout) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('boundary_timeout');
  }
  async function request(method: string, params: Record<string, unknown>, timeout = 15000) {
    const r = await seam.sendRequest(method, params, timeout);
    controls.push({ t: Date.now(), method, params, result: r.result });
    return r.result;
  }
  const notice = (text: string) => request('_clowder/v1/notice', { sessionId, prompt: [{ type: 'text', text }] });
  function run(scenario: string) {
    const state = { settledAt: 0, error: undefined as string | undefined };
    const done = (async () => {
      try {
        for await (const event of client.promptStream(
          sessionId!,
          `Authorized bounded test: call only fixture.read_fixture exactly once with scenario ${scenario} and delayMs 8000. Await its actual result and reply briefly with the sentinel. Never use other tools or files.`,
          { timeoutMs: 90000, idleStallMs: 90000 },
        ))
          events.push({ t: Date.now(), type: 'mapped', scenario, event });
      } catch (error) {
        state.error = (error as Error).message;
      } finally {
        state.settledAt = Date.now();
      }
    })();
    return { state, done };
  }

  return {
    client,
    seam,
    events,
    wire,
    controls,
    elicitations,
    native,
    lifecycle,
    toolEvents,
    waitFor,
    request,
    notice,
    run,
    setSessionId(id: string) {
      sessionId = id;
    },
    hasPendingAnswer: () => !!pendingAnswer,
    answerPending() {
      if (!pendingAnswer) throw new Error('No pending synthetic answer');
      pendingAnswer();
    },
  };
}
