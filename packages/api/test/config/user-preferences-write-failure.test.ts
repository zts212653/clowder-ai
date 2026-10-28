import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it, mock } from 'node:test';
import { saveChatBackgroundPreference } from '../../src/config/user-preferences-chat-background.js';
import { updateUserPreferences } from '../../src/config/user-preferences-store.js';

let root: string;
let file: string;
const background = {
  kind: 'image' as const,
  url: '/backgrounds/sunset-clouds.jpg',
  name: 'Sunset',
  placement: 'fill' as const,
  opacity: { light: 0.2, dark: 0.2 },
  recommendedOpacity: { light: 0.2, dark: 0.2 },
};
const metadata = { manualOpacity: { light: true } };
const codedError = (code: string) => Object.assign(new Error(code), { code });
const pinNames = () => fs.readdirSync(join(root, '.cat-cafe/user-preferences.generations'));

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'preference-write-failure-'));
  file = join(root, '.cat-cafe/user-preferences.json');
  saveChatBackgroundPreference(root, { scope: 'global', background, metadata });
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
});

it('runs pin rollback even when rename and temporary unlink both fail, preserving the rename cause', () => {
  const before = fs.readFileSync(file, 'utf8'),
    pins = pinNames();
  const primary = codedError('ERENAME'),
    secondary = codedError('ECLEANUP');
  const unlink = fs.unlinkSync;
  mock.method(fs, 'renameSync', () => {
    throw primary;
  });
  mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
    if (String(path).endsWith('.tmp')) throw secondary;
    unlink(path);
  });
  syncBuiltinESMExports();
  assert.throws(
    () => updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      return true;
    },
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(pinNames(), pins, 'pin rollback must not be skipped by temporary unlink failure');
});

it('runs temporary and pin rollback even if closing an open failed-write descriptor also fails', () => {
  const before = fs.readFileSync(file, 'utf8'),
    pins = pinNames();
  const primary = codedError('EWRITE'),
    secondary = codedError('ECLOSE');
  const close = fs.closeSync;
  mock.method(fs, 'writeFileSync', () => {
    throw primary;
  });
  mock.method(fs, 'closeSync', (fd: number) => {
    close(fd);
    throw secondary;
  });
  syncBuiltinESMExports();
  assert.throws(
    () => updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.equal(error.errors[0], primary);
      return true;
    },
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(pinNames(), pins);
  assert.equal(
    fs.readdirSync(join(root, '.cat-cafe')).some((name) => name.endsWith('.tmp')),
    false,
  );
});

it('preserves all secondary cleanup failures and later collects the failed generation pin', () => {
  const before = fs.readFileSync(file, 'utf8'),
    primary = codedError('ERENAME');
  const unlink = fs.unlinkSync;
  mock.method(fs, 'renameSync', () => {
    throw primary;
  });
  mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
    if (String(path).endsWith('.tmp') || String(path).includes('user-preferences.generations'))
      throw codedError('ECLEANUP');
    unlink(path);
  });
  syncBuiltinESMExports();
  assert.throws(
    () => updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, primary);
      assert.equal(error.errors.length, 3, 'primary + temporary-file + generation-pin cleanup errors');
      assert.equal(error.errors[0], primary);
      return true;
    },
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(pinNames().length, 2, 'unremovable pin is explicit, not silently claimed removed');
  mock.restoreAll();
  syncBuiltinESMExports();
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.equal(pinNames().length, 1, 'a later successful write collects the orphan pin');
});

it('does not delete a file that open(wx) rejected before ownership was acquired', () => {
  const before = fs.readFileSync(file, 'utf8'),
    primary = codedError('EEXIST');
  const open = fs.openSync;
  let deniedPath: string | undefined;
  mock.method(fs, 'openSync', (...args: unknown[]) => {
    if (args[1] === 'wx') {
      deniedPath = String(args[0]);
      const fd = open(deniedPath, 'wx');
      fs.writeFileSync(fd, 'not acquired');
      fs.closeSync(fd);
      throw primary;
    }
    return Reflect.apply(open, fs, args);
  });
  syncBuiltinESMExports();
  assert.throws(
    () => updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] })),
    (error) => error === primary,
  );
  assert.ok(deniedPath);
  assert.equal(fs.readFileSync(deniedPath, 'utf8'), 'not acquired');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(pinNames().length, 1);
});

it('preserves generation-verification failure when pin removal fails and still removes the temporary file', () => {
  const before = fs.readFileSync(file, 'utf8'),
    oldPins = new Set(pinNames());
  const stat = fs.lstatSync,
    unlink = fs.unlinkSync;
  mock.method(fs, 'lstatSync', (...args: unknown[]) => {
    const value = Reflect.apply(stat, fs, args);
    return String(args[0]).endsWith('.tmp')
      ? Object.assign(Object.create(Object.getPrototypeOf(value)), value, { ino: 0n })
      : value;
  });
  mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
    if (String(path).includes('user-preferences.generations') && !oldPins.has(String(path).split('/').at(-1) ?? ''))
      throw codedError('EPINCLEANUP');
    unlink(path);
  });
  syncBuiltinESMExports();
  assert.throws(
    () => updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] })),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.cause instanceof Error);
      assert.match(error.cause.message, /cannot prove/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(
    fs.readdirSync(join(root, '.cat-cafe')).some((name) => name.endsWith('.tmp')),
    false,
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.equal(pinNames().length, 1);
});

it('continues collecting other orphan pins if one old pin cannot be removed', () => {
  const directory = join(root, '.cat-cafe/user-preferences.generations');
  const blocked = '00000000-0000-4000-8000-000000000000',
    removable = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  fs.linkSync(file, join(directory, blocked));
  fs.linkSync(file, join(directory, removable));
  const unlink = fs.unlinkSync,
    read = fs.readdirSync;
  mock.method(fs, 'unlinkSync', (path: fs.PathLike) => {
    if (String(path) === join(directory, blocked)) throw codedError('EBUSY');
    unlink(path);
  });
  mock.method(fs, 'readdirSync', (...args: unknown[]) => {
    const result = Reflect.apply(read, fs, args);
    return String(args[0]) === directory ? [...result].sort() : result;
  });
  const warning = mock.method(console, 'warn', () => {});
  syncBuiltinESMExports();
  updateUserPreferences(root, (current) => ({ ...current, catOrder: ['sol'] }));
  assert.equal(fs.existsSync(join(directory, blocked)), true);
  assert.equal(fs.existsSync(join(directory, removable)), false, 'one blocked old pin cannot stop all collection');
  assert.equal(pinNames().length, 2, 'only the active generation and blocked pin remain');
  assert.equal(warning.mock.callCount(), 1);
});
