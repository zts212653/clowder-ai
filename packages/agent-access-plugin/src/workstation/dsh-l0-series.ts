import { randomUUID } from 'node:crypto';

type Decision = { kind: 'reject' } | { kind: 'enter'; startsRequestSeries?: true };
type Message = {
  role: string;
  content: readonly { type: string; text?: string }[];
  source?: { sections?: unknown };
};
type BeforeStep = (
  input: {
    agent: {
      session: {
        deriveMessages(): readonly Message[];
        append(
          type: 'system/message',
          data: { turn: number; step: number; message: Message & { id: string; source: { kind: 'system-prompt' } } },
          intent: { surfaceOp: 'append' },
        ): unknown;
      };
    };
    turn: number;
    step: number;
  },
  next: () => Promise<Decision>,
) => Promise<Decision>;

export const name = 'clowder-l0-series';
export const inject = ['systemPrompt'];

/** Start a native request series when the identity changes. DSH then replaces
 * its active system projection and preserves the rest of the session. */
export function apply(
  ctx: {
    on(event: 'agent/pre-step', listener: BeforeStep): void;
    systemPrompt: {
      section(input: { name: string; order: number; text: string; interpolate: false }): void;
    };
  },
  config: { marker: string; body: string },
) {
  ctx.systemPrompt.section({
    name: 'clowder-l0',
    order: 1,
    text: `${config.marker}\n${config.body}`,
    interpolate: false,
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const history = agent.session
      .deriveMessages()
      .filter((message) => message.role === 'system' && message.content.length);
    const prior = history.at(-1);
    const marker = history
      .flatMap((message) => message.content)
      .flatMap((block) =>
        block.type === 'text' ? (block.text?.match(/^<!-- clowder-l0:[a-f0-9]{64} -->$/m) ?? []) : [],
      )
      .at(-1);
    if (!prior || marker === config.marker) return decision;
    if (Array.isArray(prior.source?.sections)) {
      // Section-based DSH projections rebuild their active system nodes when
      // they encounter an unattributed system message. The empty marker adds
      // no instruction and lets the native assembler rebase the same log.
      agent.session.append(
        'system/message',
        { turn, step, message: { id: randomUUID(), role: 'system', content: [], source: { kind: 'system-prompt' } } },
        { surfaceOp: 'append' },
      );
    }
    return { ...decision, startsRequestSeries: true };
  });
}
