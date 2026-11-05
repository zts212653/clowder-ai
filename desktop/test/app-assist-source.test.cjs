const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createNativeAppAssistSource } = require('../plugin-window/app-assist-source.cjs');

function fakeProducer() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stdin.on('finish', () => child.emit('exit', 0));
  child.kill = () => child.emit('exit', 0);
  let launch;
  return {
    child,
    spawnProcess: (file, args, options) => {
      launch = { file, args, options };
      return child;
    },
    launch: () => launch,
  };
}
test('fixed producer protocol forwards only two scalars and closes the owned observer on EOF', async () => {
  const fake = fakeProducer(),
    rows = [];
  let lost = false;
  const ready = createNativeAppAssistSource(
    (row) => rows.push(row),
    () => {
      lost = true;
    },
    { platform: 'darwin', spawnProcess: fake.spawnProcess },
  );
  fake.child.stdout.write('{"kind":"ready"}\n');
  const source = await ready;
  fake.child.stdout.write('{"bundleId":"org.fixture.editor","name":"Fixture Editor"}\n');
  assert.deepEqual(rows, [{ bundleId: 'org.fixture.editor', name: 'Fixture Editor' }]);
  assert.match(fake.launch().file, /plugin-window\/native\/app-assist$/);
  assert.deepEqual(fake.launch().args, ['--observe']);
  assert.deepEqual(fake.launch().options.env, {});
  await source.close();
  assert.equal(lost, false);
});
test('malformed native data revokes the source; unsupported platforms never spawn', async () => {
  const fake = fakeProducer();
  let lost = false;
  const ready = createNativeAppAssistSource(
    () => assert.fail('must not forward'),
    () => {
      lost = true;
    },
    { platform: 'darwin', spawnProcess: fake.spawnProcess },
  );
  fake.child.stdout.write('{"kind":"ready"}\n');
  const source = await ready;
  fake.child.stdout.write('{"bundleId":"org.fixture.editor","name":"Fixture","title":"forbidden"}\n');
  await source.close();
  assert.equal(lost, true);
  await assert.rejects(
    createNativeAppAssistSource(
      () => {},
      () => {},
      { platform: 'linux', spawnProcess: () => assert.fail('must not spawn') },
    ),
    { code: 'unsupported' },
  );
});
