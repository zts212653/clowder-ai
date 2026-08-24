import { randomUUID } from 'node:crypto';
import { createCatId } from '@cat-cafe/shared';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { CodexAppServerClient } from '../domains/cats/services/agents/providers/CodexAppServerClient.js';
import { createDirectAgentCarrierSession } from '../domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import {
  bindFreshnessNoticeBroker,
  FreshnessNoticeBroker,
} from '../domains/cats/services/freshness/FreshnessNoticeBroker.js';
import { AgentPaneRegistry } from '../domains/terminal/agent-pane-registry.js';
import { createTmuxAgentCarrierSessionFactory } from '../domains/terminal/tmux-agent-carrier-session.js';
import { TmuxGateway } from '../domains/terminal/tmux-gateway.js';

const redisUrl = process.env.REDIS_URL ?? '';
const parsedRedisUrl = new URL(redisUrl);
if (parsedRedisUrl.port !== '6398') {
  throw new Error(`F254 live fixture requires Redis 6398, received ${parsedRedisUrl.host || '<missing>'}`);
}

const fixtureId = `f254-live-${randomUUID()}`;
const unseenKey = `fixture:${fixtureId}:unseen`;
const redis = createRedisClient({ url: redisUrl, keyPrefix: 'catcafe:f254-live:' });
const events: Array<Record<string, unknown>> = [];
const outbound: Array<Record<string, unknown>> = [];
let enqueuedWhileCommandActive = false;
const transport = process.env.F254_CODEX_TRANSPORT === 'tmux' ? 'tmux' : 'direct';
const tmuxGateway = transport === 'tmux' ? new TmuxGateway() : null;
const tmuxWorktreeId = `f254-live-${fixtureId.slice(-8)}`;

const broker = new FreshnessNoticeBroker({
  context: { invocationId: fixtureId, threadId: fixtureId, catId: createCatId('codex-sol') },
  checkUnseen: async () => {
    const raw = await redis.get(unseenKey);
    return raw ? (JSON.parse(raw) as { count: number; senders: string[]; maxMessageId: string }) : null;
  },
  appendEvent: async (event) => {
    events.push(event as unknown as Record<string, unknown>);
  },
});
const freshnessController = bindFreshnessNoticeBroker(broker, {
  provider: 'openai_codex',
  carrier: 'codex_app_server',
  deliverySemantics: 'exact_active_turn',
});

const sessionFactory = tmuxGateway
  ? createTmuxAgentCarrierSessionFactory({
      worktreeId: tmuxWorktreeId,
      userId: 'f254-live-fixture',
      tmuxGateway,
      agentPaneRegistry: new AgentPaneRegistry(),
    })
  : createDirectAgentCarrierSession;
const session = await sessionFactory({
  command: process.env.CODEX_BIN ?? 'codex',
  args: ['app-server', '--stdio'],
  cwd: process.cwd(),
  invocationId: fixtureId,
});
const client = new CodexAppServerClient({
  wire: session,
  freshnessController,
  onEnvelope: async (direction, envelope) => {
    if (direction === 'outbound') outbound.push(envelope);
    if (direction !== 'inbound' || envelope.method !== 'item/started') return;
    const item = (envelope.params as Record<string, unknown> | undefined)?.item as Record<string, unknown> | undefined;
    if (item?.type !== 'commandExecution' || enqueuedWhileCommandActive) return;
    await redis.set(
      unseenKey,
      JSON.stringify({ count: 1, senders: ['fixture-user'], maxMessageId: `${fixtureId}:message-1` }),
    );
    enqueuedWhileCommandActive = true;
  },
});

const agentTexts: string[] = [];
try {
  for await (const event of client.run({
    prompt: {
      kind: 'frozen',
      prompt:
        'Run the shell command `sleep 2 && printf ready` now. After that command completes, if you receive a message beginning with "📬 freshness notice", reply exactly F254_NOTICE_SEEN. Otherwise reply exactly F254_NOTICE_MISSED.',
    },
    thread: { kind: 'start' },
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  })) {
    const record = event as Record<string, unknown>;
    const item = record.item as Record<string, unknown> | undefined;
    if (record.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      agentTexts.push(item.text);
    }
  }

  const delivered = events.some((event) => event.kind === 'provider_notice_delivered');
  const cognitionSeen = agentTexts.some((text) => text.includes('F254_NOTICE_SEEN'));
  const steer = outbound.find((envelope) => envelope.method === 'turn/steer');
  const steerPayload = JSON.stringify(steer ?? {});
  if (!enqueuedWhileCommandActive || !delivered || !cognitionSeen || !steer) {
    throw new Error(
      `F254 live fixture failed: ${JSON.stringify({ enqueuedWhileCommandActive, delivered, cognitionSeen, hasSteer: !!steer })}`,
    );
  }
  if (steerPayload.includes('fixture-user') || steerPayload.includes(`${fixtureId}:message-1`)) {
    throw new Error('F254 live fixture leaked Queue identity or body metadata into the content-free notice');
  }
  process.stdout.write(
    `${JSON.stringify({ fixtureId, enqueuedWhileCommandActive, delivered, cognitionSeen, carrier: 'codex_app_server', transport })}\n`,
  );
} finally {
  await tmuxGateway?.destroyServer(tmuxWorktreeId);
  await redis.del(unseenKey);
  await redis.quit();
}
