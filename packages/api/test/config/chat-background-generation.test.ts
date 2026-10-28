import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  readChatBackgroundPreferences,
  saveChatBackgroundPreference,
} from '../../src/config/user-preferences-chat-background.js';
import { updateUserPreferences } from '../../src/config/user-preferences-store.js';
import { saveChatBackgroundPreference as legacySave } from '../fixtures/chat-background-v1/store.js';

const background = {
  kind: 'image' as const,
  url: '/backgrounds/sunset-clouds.jpg',
  name: 'Sunset',
  placement: 'fill' as const,
  opacity: { light: 0.2, dark: 0.2 },
  recommendedOpacity: { light: 0.2, dark: 0.2 },
};
const metadata = { manualOpacity: { light: true }, readableOpacity: { light: 0.3, dark: 0.3 } };
let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'background-generation-'));
  file = join(root, '.cat-cafe/user-preferences.json');
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
});

// Reproduce the reported identity collision without relying on this host to reuse
// an inode. Keep real link counts: the original generation is no longer live.
function simulateRecycledIdentity(zeroBirthtime: boolean) {
  let recycled: fs.BigIntStats | undefined;
  for (const method of ['statSync', 'lstatSync', 'fstatSync'] as const) {
    const original = fs[method];
    mock.method(fs, method, (...args: unknown[]) => {
      const value = Reflect.apply(original, fs, args);
      if (typeof value.ino !== 'bigint') return value;
      const collision = args[0] === file ? recycled : undefined;
      return Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
        ...(collision ? { dev: collision.dev, ino: collision.ino, birthtimeNs: collision.birthtimeNs } : {}),
        ...(zeroBirthtime ? { birthtimeNs: 0n } : {}),
      });
    });
  }
  syncBuiltinESMExports();
  return () => {
    recycled = fs.statSync(file, { bigint: true });
  };
}

function pins() {
  const directory = join(root, '.cat-cafe/user-preferences.generations');
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

function currentPin() {
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  return join(root, '.cat-cafe/user-preferences.generations', stored.chatBackgrounds.metadata.fileGeneration);
}

for (const scope of ['global', 'thread'] as const) {
  for (const zeroBirthtime of [false, true]) {
    for (const canonicalWrite of [false, true]) {
      it(`rejects recycled ${scope} identity (birthtime0=${zeroBirthtime}, canonical=${canonicalWrite})`, () => {
        const capture = simulateRecycledIdentity(zeroBirthtime);
        const target = { scope, ...(scope === 'thread' ? { threadId: 'owned' } : {}) };
        saveChatBackgroundPreference(root, { ...target, background, metadata });
        assert.ok(readChatBackgroundPreferences(root).metadata, 'fresh manual intent must work');
        capture();
        legacySave(root, { ...target, background: null });
        legacySave(root, { ...target, background });
        if (canonicalWrite) {
          updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
          const stored = JSON.parse(fs.readFileSync(file, 'utf8')).chatBackgrounds.metadata;
          assert.equal(
            scope === 'global' ? stored.global : stored.threads?.owned,
            undefined,
            'canonical writes must remove old bindings, not just hide a newly sealed one',
          );
        }
        const bytes = fs.readFileSync(file, 'utf8');
        const result = readChatBackgroundPreferences(root);
        assert.equal(result.metadata, undefined, 'an equal stat tuple must not resurrect or renew old intent');
        assert.deepEqual(scope === 'global' ? result.global : result.threads.owned, background);
        assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'GET must remain read-only');
      });
    }
  }
}

it('uses a real linked generation across a fresh process, even when birthtime is unavailable', () => {
  simulateRecycledIdentity(true);
  saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
  const current = fs.lstatSync(file, { bigint: true });
  const pin = fs.lstatSync(currentPin(), { bigint: true });
  assert.equal(current.ino, pin.ino);
  assert.equal(current.nlink, 2n);
  assert.equal(pin.birthtimeNs, 0n);
  const restarted = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        "import { readChatBackgroundPreferences } from './src/config/user-preferences-chat-background.ts'; process.stdout.write(JSON.stringify(readChatBackgroundPreferences(process.argv[1])));",
        root,
      ],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' },
    ),
  );
  assert.deepEqual(restarted.metadata.global.manualOpacity, metadata.manualOpacity);
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.deepEqual(readChatBackgroundPreferences(root).metadata?.global.manualOpacity, metadata.manualOpacity);
  assert.equal(pins().length, 1);
});

for (const damage of ['missing', 'symlink', 'unlinked-copy', 'unavailable-inode'] as const) {
  it(`invalidates an unprovable generation (${damage}) without renewing it`, () => {
    saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
    const pin = currentPin();
    if (damage === 'unavailable-inode') {
      const original = fs.lstatSync;
      mock.method(fs, 'lstatSync', (...args: unknown[]) => {
        const value = Reflect.apply(original, fs, args);
        return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: 0n });
      });
      syncBuiltinESMExports();
    } else {
      fs.unlinkSync(pin);
      if (damage === 'symlink') fs.symlinkSync(file, pin);
      if (damage === 'unlinked-copy') fs.copyFileSync(file, pin);
    }
    const before = fs.readFileSync(file, 'utf8');
    assert.equal(readChatBackgroundPreferences(root).metadata, undefined);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
    assert.equal(readChatBackgroundPreferences(root).metadata, undefined);
    assert.equal(pins().length, 0);
    assert.deepEqual(readChatBackgroundPreferences(root).global, background);
  });
}

it('does not fall back to a copied legacy stat seal when a pin is missing', () => {
  saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(currentPin());
  const stat = fs.statSync(file, { bigint: true });
  stored.chatBackgrounds.metadata.fileIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal(readChatBackgroundPreferences(root).metadata, undefined);
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.equal(readChatBackgroundPreferences(root).metadata, undefined);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).chatBackgrounds.metadata.fileIdentity, undefined);
});

it('keeps the committed bytes and live pin when serialization or hard-link creation fails', () => {
  saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
  const before = fs.readFileSync(file, 'utf8');
  const beforePins = pins();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => updateUserPreferences(root, (current) => ({ ...current, circular })));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(pins(), beforePins);
  mock.method(fs, 'linkSync', () => {
    throw Object.assign(new Error('No hard links'), { code: 'EOPNOTSUPP' });
  });
  syncBuiltinESMExports();
  assert.throws(() => saveChatBackgroundPreference(root, { scope: 'global', background, metadata }));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(pins(), beforePins);
  assert.deepEqual(readChatBackgroundPreferences(root).metadata?.global.manualOpacity, metadata.manualOpacity);
  assert.equal(
    fs.readdirSync(join(root, '.cat-cafe')).some((name) => name.endsWith('.tmp')),
    false,
  );
});

it('collects prior and interrupted pins after a successful publication, retaining unknown files', () => {
  saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
  const directory = join(root, '.cat-cafe/user-preferences.generations');
  fs.linkSync(file, join(directory, 'b4feb57f-11b7-4ee9-9b70-d190c695ba5c'));
  fs.writeFileSync(join(directory, 'not-a-generation'), 'leave alone');
  for (let index = 0; index < 10; index++)
    updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.equal(pins().length, 2);
  assert.equal(fs.readFileSync(join(directory, 'not-a-generation'), 'utf8'), 'leave alone');
  assert.deepEqual(readChatBackgroundPreferences(root).metadata?.global.manualOpacity, metadata.manualOpacity);
});

it('keeps a successful commit successful if old-pin collection fails, then retries collection on a later write', () => {
  saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
  const oldPin = currentPin();
  const original = fs.unlinkSync;
  const unlink = mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
    if (path === oldPin) throw Object.assign(new Error('Pin busy'), { code: 'EACCES' });
    original(path);
  });
  const warning = mock.method(console, 'warn', () => {});
  syncBuiltinESMExports();
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).catOrder, ['sol']);
  assert.deepEqual(readChatBackgroundPreferences(root).metadata?.global.manualOpacity, metadata.manualOpacity);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(pins().length, 2);
  unlink.mock.restore();
  syncBuiltinESMExports();
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['kimi'] }));
  assert.equal(pins().length, 1);
});

for (const damagedThreads of [null, [], 42]) {
  it(`does not let a corrupt threads container keep an obsolete pin (${JSON.stringify(damagedThreads)})`, () => {
    saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
    const oldPin = currentPin();
    legacySave(root, { scope: 'global', background: { kind: 'none' } });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.chatBackgrounds.metadata.threads = damagedThreads;
    fs.writeFileSync(file, JSON.stringify(stored));
    for (let index = 0; index < 2; index++) {
      updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(
        after.chatBackgrounds.metadata.fileGeneration,
        undefined,
        'a damaged container cannot publish a generation',
      );
      assert.deepEqual(
        after.chatBackgrounds.metadata.threads,
        damagedThreads,
        'preserve the damaged original for diagnosis',
      );
      assert.equal(fs.existsSync(oldPin), false, 'do not keep an old copied UUID');
      assert.equal(pins().length, 0, 'no unreferenced new pins remain');
    }
    updateUserPreferences(root, (current) => ({
      ...current,
      chatBackgrounds: {
        ...current.chatBackgrounds,
        metadata: { ...JSON.parse(fs.readFileSync(file, 'utf8')).chatBackgrounds.metadata, threads: {} },
      },
    }));
    assert.equal(
      readChatBackgroundPreferences(root).metadata,
      undefined,
      'repairing the container cannot renew old bindings',
    );
  });
}
