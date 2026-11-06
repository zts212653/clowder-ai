import { spawnSync } from 'node:child_process';
export const nativeWatcherAvailable =
  spawnSync('codex', ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }).status === 0;

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { CodexAgentService } from '../../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { createDirectAgentCarrierSession } from '../../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { watcherSessionChainKey } from '../../dist/domains/cats/services/session/session-scope.js';
import { TranscriptWriter } from '../../dist/domains/cats/services/session/TranscriptWriter.js';
import { runWatcherInvocation } from '../../dist/domains/concierge/watcher/watcher-invocation.js';
import { watcherCallbackRoutes } from '../../dist/routes/watcher-callbacks.js';

export async function watcherNativeFixture(w, fixtureOptions = {}) {
  const oldImplementation = Boolean(fixtureOptions.invoke);
  const root = await mkdtemp(join(tmpdir(), 'f335-watcher-consumer-'));
  const savedEnv = Object.fromEntries(['CODEX_HOME', 'CAT_CAFE_DATA_DIR'].map((key) => [key, process.env[key]]));
  process.env.CODEX_HOME = join(root, 'codex');
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
  await mkdir(process.env.CODEX_HOME);
  const requests = [],
    enqueues = [];
  const app = Fastify();
  const state = { tools: 0, mode: 'normal', quiet: false, entered: undefined };
  let received;
  const hang = new Promise((resolve) => {
    received = resolve;
  });
  app.post('/v1/responses', async (request, reply) => {
    const body = request.body;
    const wire = JSON.stringify(body);
    requests.push({ body, wire });
    state.entered?.();
    if (state.mode === 'hang') {
      await hang;
      return reply.code(503).send({ error: 'fixture stopped' });
    }
    const round = /RAW_INCREMENT_(\d+)/u.exec(wire)?.[1] ?? '0';
    const frontier = /本轮 frontier=([^；]+)/u.exec(wire)?.[1];
    const toolReturns = (body.input ?? []).filter((item) => item.type === 'function_call_output').length;
    const plan = state.toolPlan?.[toolReturns];
    const useTool = toolReturns < (state.toolPlan?.length ?? state.tools);
    const sourceMessageId = /sourceMessageId=([^。]+)/u.exec(wire)?.[1];
    const output = useTool
      ? [
          {
            type: 'function_call',
            id: `item-${requests.length}`,
            call_id: `call-${round}-${toolReturns}`,
            name: plan?.name ?? 'cat_cafe_watcher_nudge',
            arguments: JSON.stringify(
              (typeof plan?.args === 'function' ? await plan.args({ body, wire }) : plan?.args) ?? {
                sentence: `这里有一条具体先例，请回看原话。${state.argumentPadding ?? ''}`,
                sourceMessageId,
              },
            ),
            status: 'completed',
          },
        ]
      : [
          {
            type: 'message',
            id: `message-${requests.length}`,
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  v: 1,
                  notes: `saved-note-${round}${state.notePadding ?? ''}`,
                  consumedThrough: state.invalidCheckpoint ? 'not-the-delivered-window' : frontier,
                  outcome: state.tools && !state.quiet ? 'nudged' : 'quiet',
                }),
              },
            ],
          },
        ];
    if (state.reasoningPadding)
      output.unshift({
        type: 'reasoning',
        id: `reasoning-${requests.length}`,
        summary: [{ type: 'summary_text', text: state.reasoningPadding }],
        encrypted_content: Buffer.from(state.reasoningPadding).toString('base64'),
      });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    const id = `fixture-${requests.length}`;
    for (const [type, payload] of [
      ['response.created', { response: { id, status: 'in_progress', output: [] } }],
      ...output.flatMap((item, index) => [
        ['response.output_item.added', { output_index: index, item }],
        ['response.output_item.done', { output_index: index, item }],
      ]),
      [
        'response.completed',
        {
          response: {
            id,
            status: 'completed',
            model: body.model,
            output,
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } },
          },
        },
      ],
    ])
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    reply.raw.end();
  });
  await app.register(watcherCallbackRoutes, {
    ...w,
    queue: {
      async enqueueExistingMessageDurable(_store, id, input) {
        enqueues.push({ id, input });
      },
    },
    maySpeak: async () => !state.quiet,
    publish() {},
  });
  const cleanup = await fixtureOptions.configure?.({ app, root, state });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiUrl = app.listeningOrigin;
  const native = new CodexAgentService({ catId: 'codex', carrierMode: 'app_server' });
  const service = {
    boundedWatcherSessionCapability: () => native.boundedWatcherSessionCapability(),
    async *invoke(prompt, options) {
      for await (const event of native.invoke(prompt, {
        ...options,
        // The prior implementation did not own the new request boundary's lifecycle. RED loads that exact
        // implementation with its original direct fixture transport, rather than leaking a new proxy it cannot close.
        boundedWatcher: {
          ...options.boundedWatcher,
          ...(oldImplementation ? { configureProvider: async () => ({}) } : {}),
          beforeTurn: async (input) => {
            state.nativeClient = input.client;
            return options.boundedWatcher.beforeTurn(input);
          },
        },
        workingDirectory: root,
        agentCarrierSessionFactory: async (sessionOptions) => {
          const wire = await createDirectAgentCarrierSession(
            fixtureOptions.providerId
              ? {
                  ...sessionOptions,
                  args: sessionOptions.args.map((arg) =>
                    arg
                      .replace(/^model_provider="custom"$/, `model_provider="${fixtureOptions.providerId}"`)
                      .replace(/^model_providers\.custom\./, `model_providers.${fixtureOptions.providerId}.`),
                  ),
                }
              : sessionOptions,
            {
              executionOwner: options.auditContext
                ? {
                    executionId: options.auditContext.executionId,
                    invocationId: options.auditContext.invocationId,
                    threadId: options.auditContext.threadId,
                    userId: options.auditContext.userId,
                    catId: options.auditContext.catId,
                  }
                : undefined,
            },
          );
          state.nativeSupervisorPid = wire.pid;
          (state.nativeLaunchPids ??= []).push(wire.pid);
          return wire;
        },
        callbackEnv: {
          ...options.callbackEnv,
          CODEX_AUTH_MODE: 'api_key',
          OPENAI_API_KEY: 'fixture-only',
          OPENAI_BASE_URL: `${apiUrl}/v1`,
          ...(state.nativeEnv ?? {}),
        },
      })) {
        if (event.type === 'error') throw new Error(JSON.stringify(event));
        yield event;
      }
    },
  };
  const transcript = new TranscriptWriter({ dataDir: process.env.CAT_CAFE_DATA_DIR });
  const owners = { ...w, transcript, apiUrl, maySpeak: async () => !state.quiet };
  async function run(source, signal) {
    const session = await w.sessions.getOrCreateActive({
      userId: source.userId,
      threadId: source.threadId,
      catId: 'codex',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
    });
    await (fixtureOptions.invoke ?? runWatcherInvocation)(owners, {
      session,
      source,
      service,
      quiet: state.quiet,
      signal,
    });
    return w.sessions.get(session.id);
  }
  return {
    root,
    apiUrl,
    app,
    owners,
    service,
    state,
    requests,
    enqueues,
    run,
    releaseResponses: received,
    async close() {
      received();
      await app.close();
      await cleanup?.();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
