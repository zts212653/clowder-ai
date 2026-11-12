import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import {
  type AgyNativeLaunchPlan,
  prepareAgyNativeLaunch,
} from '../src/domains/cats/services/agents/providers/agy-native/agy-native-launch.js';
import type { ProfileTurnOwner } from '../src/domains/cats/services/agents/providers/agy-native/profile-turn/store.js';
import { retiredProcessIdentity } from './helpers/retired-process-identity.js';

function ownerAt(home: string): Pick<ProfileTurnOwner, 'invocationId' | 'preparation'> | undefined {
  const path = join(home, '.cat-cafe-native-turn.sqlite');
  if (!existsSync(path)) return undefined;
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare('SELECT owner FROM native_profile_turn').get() as { owner: string } | undefined;
    return row ? JSON.parse(row.owner) : undefined;
  } finally {
    db.close();
  }
}

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agy-account-startup-')));
  const saved = { ...process.env };
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
  const workspace = join(root, 'workspace');
  const credentialHome = join(root, 'account');
  const tokenDirectory = join(credentialHome, '.gemini/antigravity-cli');
  mkdirSync(workspace);
  mkdirSync(tokenDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(tokenDirectory, 'antigravity-oauth-token'),
    JSON.stringify({
      auth_method: 'consumer',
      token: { access_token: 'fixture', refresh_token: 'fixture-refresh', expiry: '2099-01-01T00:00:00Z' },
    }),
    { mode: 0o600 },
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const plans: AgyNativeLaunchPlan[] = [];
  const launches: Promise<AgyNativeLaunchPlan>[] = [];
  const profileHome = (id: string) => join(root, 'profiles', id);
  const launch = (id: string) => {
    const work = prepareAgyNativeLaunch({
      catId: id,
      model: 'gemini-4-argon-high',
      command: process.execPath,
      workspace,
      profileConfig: {
        enabled: true,
        carrier: 'native',
        profileId: id,
        homeRoot: join(root, 'profiles'),
        model: 'gemini-4-argon-high',
        trustedWorkspaces: [workspace],
      },
      prompt: 'Fixture request.',
      body: `# Identity\nYou are fixture member ${id}.`,
      options: {
        invocationId: id,
        signal: controller.signal,
        agyAccount: { storage: 'cli_file', credentialHome },
      },
    }).then((plan) => {
      plans.push(plan);
      return plan;
    });
    void work.catch(() => {});
    launches.push(work);
    return work;
  };
  t.after(async () => {
    controller.abort();
    clearTimeout(timeout);
    await Promise.allSettled(launches);
    for (const plan of plans.reverse()) await plan.disposeCredentials?.();
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, credentialHome, profileHome, launch };
}

test('two members sharing an account wait until verified init, then retain concurrent live turns', async (t) => {
  const { credentialHome, profileHome, launch } = fixture(t);
  const first = await launch('first');
  assert.equal(ownerAt(credentialHome)?.invocationId, 'first');
  let second: AgyNativeLaunchPlan | undefined;
  let failure: unknown;
  const pending = launch('second');
  void pending.then(
    (plan) => {
      second = plan;
    },
    (error: unknown) => {
      failure = error;
    },
  );
  const deadline = Date.now() + 4000;
  for (;;) {
    const owner = ownerAt(profileHome('second'));
    if (owner && !owner.preparation) break;
    if (failure) throw failure;
    assert.ok(Date.now() < deadline, 'second member must reach its startup fence');
    await delay(10);
  }
  await delay(100);
  if (failure) throw failure;
  assert.equal(second, undefined, 'second member waits while first owns account startup');
  assert.equal(ownerAt(credentialHome)?.invocationId, 'first');

  await first.bindSession('session-first');
  const next = await pending;
  assert.notEqual(first.binding.profileHome, next.binding.profileHome);
  assert.equal(ownerAt(credentialHome)?.invocationId, 'second');
  await next.bindSession('session-second');
  assert.equal(ownerAt(credentialHome), undefined, 'both startup fences end at verified init');
  // Neither turn has been disposed: their per-conversation leases remain live.
  for (const [home, session] of [
    [first.binding.profileHome, 'session-first'],
    [next.binding.profileHome, 'session-second'],
  ]) {
    const db = new Database(join(home, '.cat-cafe-native-turn.sqlite'), { readonly: true });
    try {
      assert.ok(db.prepare('SELECT owner FROM native_conversation_turn WHERE conversation_id = ?').get(session));
    } finally {
      db.close();
    }
  }
});

test('a different member takes over a shared account after the startup owner dies', async (t) => {
  const { root, credentialHome, launch } = fixture(t);
  const retired = await retiredProcessIdentity(t);
  await launch('first');
  const db = new Database(join(credentialHome, '.cat-cafe-native-turn.sqlite'));
  try {
    const row = db.prepare('SELECT owner FROM native_profile_turn').get() as { owner: string };
    const owner = JSON.parse(row.owner) as ProfileTurnOwner;
    db.prepare('UPDATE native_profile_turn SET owner = ?').run(
      JSON.stringify({ ...owner, identity: retired, dataRoot: join(root, 'retired-data') }),
    );
  } finally {
    db.close();
  }
  const second = await launch('second');
  assert.equal(ownerAt(credentialHome)?.invocationId, 'second');
  await second.bindSession('session-second');
  assert.equal(ownerAt(credentialHome), undefined);
});
