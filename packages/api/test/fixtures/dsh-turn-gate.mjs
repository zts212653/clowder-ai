import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const name = 'issue1947-turn-gate-fixture';
export const inject = ['agents', 'tools', 'systemPrompt'];

/** Opt-in native acceptance fixture. The model can only wait; it cannot execute file/shell tools. */
export async function apply(ctx, config) {
  const require = createRequire(process.argv[1]);
  const { defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')).href);
  mkdirSync(config.directory, { recursive: true });
  const record = (kind, fields = {}) =>
    appendFileSync(
      join(config.directory, 'native-events.jsonl'),
      `${JSON.stringify({ at: Date.now(), kind, ...fields })}\n`,
    );
  ctx.on('session/event', (session, event) => {
    if (!['turn/start', 'turn/end', 'user/message'].includes(event.type)) return;
    record('session_event', { sessionId: session.header.id, event });
  });
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    record('claimed', { sessionId: agent.session.id, messageId: message.id, turn });
  });
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    record('inserted', { sessionId: agent.session.id, messageId: message.id, content: message.content });
  });
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = agent.session.id;
    agent.ctx.tools.restrict({ allow: [] });
    agent.ctx.systemPrompt.section({
      name: 'turn-steer-acceptance',
      order: 0,
      complete: true,
      interpolate: false,
      text: 'This is a synthetic turn input acceptance task. Use only issue1947_gate. Follow the latest user instruction. Do not delegate or access files. After the waiting tool finishes, output exactly the latest requested marker.',
    });
    agent.ctx.systemPrompt.suppressRuntimeContext();
    agent.ctx.tools.register(
      defineTool({
        name: 'issue1947_gate',
        description:
          'Wait for the test controller, then continue following the latest user instruction in this same task.',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(_args, execution) {
          record('gate_entered', { sessionId });
          const result = await new Promise((resolve) => {
            const timer = setInterval(() => {
              if (existsSync(join(config.directory, 'release'))) finish('released; follow the latest user instruction');
            }, 100);
            const abort = () => finish('aborted');
            const finish = (value) => {
              clearInterval(timer);
              execution.signal.removeEventListener('abort', abort);
              resolve(value);
            };
            execution.signal.addEventListener('abort', abort, { once: true });
          });
          record('gate_finished', { sessionId, result });
          return result;
        },
      }),
    );
    record('agent_created', { sessionId });
  });
  record('fixture_ready');
}
