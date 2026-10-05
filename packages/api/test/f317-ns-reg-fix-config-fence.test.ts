// F317 north-star regression harness, observation for 359fc47535: how the new owner-preference fence treats
// overlapping single-field config writes, which is exactly how the web store sends them (setMuted, setBehaviorEnabled,
// setBallPosition, setBallSize each issue their own PUT, and position/size swallow failures silently).
// Measured on the control tree (no fence): both PUTs answer 200 but one update is silently lost (read-modify-write race).
// Measured on 359fc47535: one PUT answers 200, the other 503 with code live_teardown_unconfirmed and the text
// "Media stop unconfirmed; no settings write attempted" although no media was involved.
// The regression requires a distinct admission conflict; it never claims that media failed to stop.
// No media, no visible cat.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONCIERGE_CONFIG_DEFAULTS } from '@cat-cafe/shared';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../src/domains/concierge/ConciergeConfigStore.js';
import { MemoryConciergeConfirmationStore } from '../src/domains/concierge/ConciergeConfirmationStore.js';
import { MemoryConciergeRelayStore } from '../src/domains/concierge/ConciergeRelayStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { LiveCompanionSessions } from '../src/domains/concierge/live/LiveCompanionSessions.js';
import { requiresLiveConfigStop } from '../src/domains/concierge/live/live-config-transition.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { conciergeRoutes } from '../src/routes/concierge.js';

const OWNER = 'ns-reg-config-owner';

class SlowConfigStore extends MemoryConciergeConfigStore {
  override async put(userId: string, config: Parameters<MemoryConciergeConfigStore['put']>[1]) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return super.put(userId, config);
  }
}

async function fixture() {
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = OWNER;
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: OWNER });
  const config = new SlowConfigStore();
  await MemoryConciergeConfigStore.prototype.put.call(config, OWNER, {
    ...CONCIERGE_CONFIG_DEFAULTS,
    dutyCatProfileId: 'opus',
  });
  const sessions = new LiveCompanionSessions();
  await app.register(conciergeRoutes, {
    conciergeConfigStore: config,
    conciergeThreadService: new ConciergeThreadService({
      threadStore: new ThreadStore(),
      conciergeConfigStore: config,
    }),
    conciergeRelayStore: new MemoryConciergeRelayStore(),
    conciergeConfirmationStore: new MemoryConciergeConfirmationStore(),
    messageStore: new MessageStore(),
    // Same shape as index.ts: patches that do not change execution identity or the household grant need no stop.
    withLiveConfigChange: (userId: string, save: () => Promise<unknown>, patch: Readonly<Record<string, unknown>>) =>
      sessions.withOwnerPreferenceChange(userId, save, async () =>
        (await requiresLiveConfigStop(await config.get(userId), patch)) ? undefined : false,
      ),
  } as never);
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'content-type': 'application/json' };
  return {
    config,
    put: (body: object) => app.inject({ method: 'PUT', url: '/api/concierge/config', headers, payload: body }),
    cleanup: async () => {
      await app.close();
      if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previous;
    },
  };
}

test('sequential presentation-only writes all succeed and persist', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  assert.equal((await f.put({ muted: true })).statusCode, 200);
  assert.equal((await f.put({ ballSize: 96 })).statusCode, 200);
  const final = (await f.config.get(OWNER)) as unknown as Record<string, unknown>;
  assert.equal(final.muted, true);
  assert.equal(final.ballSize, 96);
});

test('every 200 answer to an overlapping write is really applied (no false success)', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const [a, b] = await Promise.all([f.put({ muted: true }), f.put({ ballSize: 96 })]);
  const final = (await f.config.get(OWNER)) as unknown as Record<string, unknown>;
  if (a.statusCode === 200) assert.equal(final.muted, true, 'the muted write answered 200 but is missing');
  if (b.statusCode === 200) assert.equal(final.ballSize, 96, 'the size write answered 200 but is missing');
});

test('an overlapping presentation-only write reports its admission conflict without claiming media failure', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const responses = await Promise.all([f.put({ muted: true }), f.put({ ballSize: 96 })]);
  assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
  for (const r of responses) {
    if (r.statusCode !== 200) {
      assert.equal(
        (r.json() as { code?: string }).code,
        'config_change_in_progress',
        `status ${r.statusCode}: a settings write that needs no media stop must not claim a stop was unconfirmed`,
      );
    }
  }
});
