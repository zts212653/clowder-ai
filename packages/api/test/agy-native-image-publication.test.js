import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';

import { runAgyNativeInvocation } from '../dist/domains/cats/services/agents/providers/agy-native/run/agy-native-invocation.js';
import { routeParallel } from '../dist/domains/cats/services/agents/routing/route-parallel.js';
import { routeSerial } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const model = 'gemini-3.8-flash-high';
const sessionId = 'image-publication-session';

async function fixture(t) {
  // Give invocation, filename and filesystem one explicit clock. A tiny fixture
  // write can otherwise precede Date.now() in the filesystem's timestamp precision.
  const generatedAt = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, 'now', () => generatedAt);
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agy-image-publication-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const profileHome = join(base, 'profile');
  const brain = join(profileHome, '.gemini/antigravity-cli/brain', sessionId);
  const uploadDir = join(base, 'uploads');
  await mkdir(brain, { recursive: true });
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#48705b' } })
    .png()
    .toBuffer();
  const writeImage = async (name, directory = brain, timestamp = Date.now()) => {
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${name}_${timestamp}.png`);
    await writeFile(path, bytes);
    await utimes(path, new Date(timestamp), new Date(timestamp));
    return path;
  };
  const run = async (
    steps,
    { multiTurn = false, response = '两张图已经画好了。', trailing = [], terminal = {} } = {},
  ) => {
    const messages = [];
    const launch = {
      agentName: 'publication-fixture',
      cliOptions: { command: 'fixture-only', cwd: base },
      permissionMode: 'always-proceed',
      agentTools: ['generate_image', 'view_file'],
      binding: { profileHome },
      bindSession: async () => {},
    };
    for await (const message of runAgyNativeInvocation({
      catId: 'gemini38',
      model,
      prompt: 'show generated images',
      launch,
      metadata: { provider: 'google', model },
      rawArchive: { append: async () => {} },
      spawnCliFn: () => {
        throw new Error('A real CLI must never run in this fixture');
      },
      options: {
        uploadDir,
        ...(multiTurn ? { activeRunDispatch: { register: () => ({ detach: () => {} }) } } : {}),
        spawnCliOverride: async function* () {
          yield {
            event: 'init',
            conversation_id: sessionId,
            init: {
              agent: launch.agentName,
              cwd: base,
              model,
              permission_mode: launch.permissionMode,
              tools: launch.agentTools,
            },
          };
          yield* await steps({ writeImage, bytes, brain, profileHome });
          yield {
            event: 'result',
            result: { conversation_id: sessionId, status: 'SUCCESS', response, num_turns: 1, ...terminal },
          };
          yield* trailing;
        },
      },
      compactionRequested: false,
    }))
      messages.push(message);
    return messages;
  };
  return { base, brain, uploadDir, bytes, writeImage, run };
}

function tool(index, imageName, extra = {}) {
  return {
    event: 'step_update',
    step_update: {
      conversation_id: sessionId,
      step_index: index,
      step_type: 'tool',
      state: 'DONE',
      tool_name: 'generate_image',
      tool_info: { parameters: { ImageName: imageName } },
      ...extra,
    },
  };
}

function galleries(messages) {
  return messages
    .filter((m) => m.type === 'system_info' && m.content)
    .flatMap((m) => {
      try {
        const value = JSON.parse(m.content);
        return value.type === 'rich_block' && value.block?.kind === 'media_gallery' ? [value] : [];
      } catch {
        return [];
      }
    });
}

// Covers the actual consumer seam: real image bytes -> Native invocation -> shared
// publisher -> gallery before done. No model, network, Redis or real child process.
for (const multiTurn of [false, true]) {
  test(`automatically publishes both generated originals before done (${multiTurn ? 'queued' : 'one-turn'})`, async (t) => {
    const f = await fixture(t);
    const paths = [];
    const messages = await f.run(
      async ({ writeImage }) => {
        paths.push(await writeImage('card_sheet'), await writeImage('lake_scene'));
        return [tool(1, 'card_sheet'), tool(2, 'lake_scene')];
      },
      { multiTurn },
    );
    assert.equal(messages.at(-1).type, 'done');
    assert.equal(messages.at(-1).errorCode, undefined);
    assert.equal(
      messages
        .filter((m) => m.type === 'text')
        .map((m) => m.content)
        .join(''),
      '两张图已经画好了。',
    );
    const images = galleries(messages);
    assert.equal(images.length, 2, 'completed native generate_image must produce visible galleries');
    assert.deepEqual(images.map((image) => image.provenance.originalPath).sort(), paths.sort());
    for (const image of images) {
      const url = image.block.items[0].url;
      assert.match(url, /^\/uploads\//);
      assert.deepEqual(await readFile(join(f.uploadDir, url.slice('/uploads/'.length))), f.bytes);
      assert.equal(image.provenance.toolName, 'generate_image');
    }
    assert.equal(messages.filter((m) => m.type === 'done').length, 1, 'all galleries precede the only terminal');
    assert.equal((await readdir(f.uploadDir)).length, 2);
  });
}

test('only publishes current completed generation, not views, failures, stale files or other sessions', async (t) => {
  const f = await fixture(t);
  const messages = await f.run(async ({ writeImage, brain, profileHome }) => {
    await writeImage('wanted');
    const stale = await writeImage('wanted', brain, 1);
    await utimes(stale, new Date(0), new Date(0));
    const backdated = await writeImage('backdated');
    await utimes(backdated, new Date(0), new Date(0));
    await writeImage('wanted_legacy');
    await writeImage('failed');
    await writeImage('active');
    await writeImage('viewed');
    await writeImage('wanted', join(profileHome, '.gemini/antigravity-cli/brain/another-session'));
    return [
      tool(1, 'wanted'),
      tool(2, 'failed', { state: 'ERROR' }),
      tool(3, 'active', { state: 'ACTIVE' }),
      tool(4, 'viewed', { tool_name: 'view_file' }),
      tool(5, 'backdated'),
    ];
  });
  assert.equal(galleries(messages).length, 1);
  assert.equal((await readdir(f.uploadDir)).length, 1);
});

test('publishes an image-only response and deduplicates repeated completed-step observations', async (t) => {
  const f = await fixture(t);
  const messages = await f.run(
    async ({ writeImage }) => {
      await writeImage('only_image');
      return [tool(1, 'only_image'), tool(1, 'only_image')];
    },
    { response: '' },
  );
  assert.equal(galleries(messages).length, 1);
  assert.equal(messages.at(-1).errorCode, undefined);
  assert.equal((await readdir(f.uploadDir)).length, 1);
});

test('does not follow an image symlink or treat an arbitrary tool-output path as generated media', async (t) => {
  const f = await fixture(t);
  const messages = await f.run(async ({ writeImage, brain }) => {
    const outside = await writeImage('private_image', join(f.base, 'outside'));
    await symlink(outside, join(brain, `redirect_${Date.now()}.png`));
    await link(outside, join(brain, `hardlink_${Date.now()}.png`));
    return [
      tool(1, 'redirect'),
      tool(3, 'hardlink'),
      tool(2, 'no_matching_image', {
        tool_info: {
          parameters: { ImageName: 'no_matching_image' },
          output: `Generated image is saved at ${outside}.`,
        },
      }),
    ];
  });
  assert.equal(galleries(messages).length, 0);
  assert.ok(messages.some((message) => message.semanticEvent?.kind === 'warning'));
  assert.equal(
    messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    '两张图已经画好了。',
  );
  await assert.rejects(readdir(f.uploadDir), { code: 'ENOENT' });
});

test('image publication does not upgrade a failed or denied carrier result to success', async (t) => {
  for (const terminal of [
    { status: 'ERROR', error: 'recorded upstream failure' },
    { denied_actions: [{ action: 'run_command', display_name: 'run command' }] },
  ]) {
    const f = await fixture(t);
    const messages = await f.run(
      async ({ writeImage }) => {
        await writeImage('completed_before_error');
        return [tool(1, 'completed_before_error')];
      },
      { response: '', terminal },
    );
    assert.equal(galleries(messages).length, 1, 'a confirmed image remains visible');
    assert.ok(messages.some((message) => message.type === 'error'));
    assert.ok(messages.at(-1).errorCode, 'image-only success must preserve upstream failures and denials');
  }
});

for (const [name, route] of [
  ['serial', routeSerial],
  ['parallel', routeParallel],
]) {
  test(`${name}: generated galleries survive the real message route and getById readback`, async (t) => {
    const f = await fixture(t);
    const messages = await f.run(async ({ writeImage }) => {
      await writeImage('persisted');
      return [tool(1, 'persisted')];
    });
    const store = new MessageStore();
    let sequence = 0;
    const records = [];
    const append = store.append.bind(store);
    store.append = (input) => {
      const value = append(input);
      records.push(value);
      return value;
    };
    const deps = {
      services: {
        gemini38: {
          async *invoke() {
            yield* messages;
          },
        },
      },
      invocationDeps: {
        registry: { create: () => ({ invocationId: `images-${++sequence}`, callbackToken: 'fixture-token' }) },
        sessionManager: { get: async () => null, getOrCreate: async () => ({}), resolveWorkingDirectory: () => f.base },
        threadStore: {
          get: async () => null,
          getParticipantsWithActivity: async () => [],
          consumeMentionRoutingFeedback: async () => null,
          updateParticipantActivity: async () => {},
        },
        apiUrl: 'http://127.0.0.1:3102',
      },
      messageStore: store,
      draftStore: { upsert: async () => {}, touch: async () => {}, delete: async () => {} },
    };
    for await (const _event of route(deps, ['gemini38'], 'show image', 'image-owner', 'image-thread')) {
      /* consume */
    }
    const stored = records.find((record) => record.catId === 'gemini38' && record.origin === 'stream');
    assert.ok(stored);
    const reread = await store.getById(stored.id);
    const blocks = reread.extra.rich.blocks.filter((block) => block.kind === 'media_gallery');
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0], galleries(messages)[0].block);
    await rm(f.brain, { recursive: true });
    assert.deepEqual(await readFile(join(f.uploadDir, blocks[0].items[0].url.slice('/uploads/'.length))), f.bytes);
  });
}
