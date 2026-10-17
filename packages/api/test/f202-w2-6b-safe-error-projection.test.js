/**
 * F202 W2-6b — the Host log never receives what a plugin or SDK wrote (ledger「W2-6b」(1); astra's
 * reviews P1, Host thread …000091 and …000100).
 *
 * No pattern proves free text is safe, so no free text is kept: not the message, not the text of a
 * stack line. What is kept either comes from the Host itself or has a shape a credential does not
 * take — a conventional class name, a system or integer code, an HTTP status, and code locations
 * from a stack whose header is verifiably the error's own. All credentials below are fake.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeErrorProjection } from '../dist/domains/plugin/diagnostics/safe-error-projection.js';

const THIS_FILE = /f202-w2-6b-safe-error-projection\.test\.js:\d+:\d+$/u;

function assertNoCanary(projection) {
  const text = JSON.stringify(projection);
  assert.doesNotMatch(text, /FAKE_CANARY|FAKE_W26B/u, text);
}

test("astra's canaries: a bare password and a message line posing as a frame are both kept out", () => {
  const password = safeErrorProjection(new Error('Invalid password FAKE_CANARY_PASSWORD'));
  assertNoCanary(password);
  assert.equal(password.type, 'Error');
  assert.match(password.at[0], THIS_FILE);

  const posing = safeErrorProjection(new Error('authentication failed\n    at FAKE_CANARY_12345678901234567890'));
  assertNoCanary(posing);
  assert.match(posing.at[0], THIS_FILE, 'the real frames follow the header, whatever the message contains');
});

test('the first probe: a URL token in the cause and a credential property are kept out too', () => {
  const error = new Error('start failed', {
    cause: new Error('request failed https://example.invalid/?token=FAKE_W26B_QUERY'),
  });
  error.secret = 'FAKE_W26B_PROPERTY';

  const projection = safeErrorProjection(error);

  assertNoCanary(projection);
  assert.equal(projection.origin, 'unverified');
  assert.equal(projection.cause.type, 'Error');
});

test('an SDK error keeps only its class, code, status and locations', () => {
  const error = Object.assign(new Error('Request failed: Bearer FAKE_W26B_HEADER'), {
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    config: { url: 'https://api.example.invalid/x', headers: { Authorization: 'Bearer FAKE_W26B_HEADER' } },
    request: { _header: 'Cookie: FAKE_W26B_COOKIE' },
    response: { status: 401, data: { access_token: 'FAKE_W26B_BODY' } },
  });

  const projection = safeErrorProjection(error);

  assertNoCanary(projection);
  assert.deepEqual(Object.keys(projection).sort(), ['at', 'code', 'origin', 'status', 'type']);
  assert.deepEqual(
    { origin: projection.origin, type: projection.type, code: projection.code, status: projection.status },
    { origin: 'unverified', type: 'AxiosError', code: 'ERR_BAD_REQUEST', status: 401 },
  );

  const refused = safeErrorProjection(
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
  );
  assert.equal(refused.code, 'ECONNREFUSED');
  assert.equal(
    safeErrorProjection(Object.assign(new Error('x'), { status: 123_456 })).status,
    undefined,
    'not an HTTP status',
  );
  assert.equal(safeErrorProjection(Object.assign(new Error('x'), { statusCode: 503 })).status, 503);
});

test('a name or code a credential could take is dropped; integer codes and conventional names stay', () => {
  const error = Object.assign(new Error('x'), { code: 'AKIA1234567890FAKE', name: 'FAKE_CANARY_NAME' });
  const projection = safeErrorProjection(error);
  assertNoCanary(projection);
  assert.equal(projection.code, undefined);
  assert.equal(projection.type, undefined);
  for (const code of ['sk-live-FAKE', 'E1234567', 'err_lowercase', 'ERR_FAKE9']) {
    assert.equal(safeErrorProjection(Object.assign(new Error('x'), { code })).code, undefined, code);
  }
  assert.equal(safeErrorProjection(Object.assign(new Error('x'), { code: 40_001 })).code, 40_001);
  assert.equal(safeErrorProjection(new TypeError('x')).type, 'TypeError');
});

test('what the Host recognizes as its own is labelled so; nothing else is', () => {
  const refusal = new Error('dev.example lacks thread.listMetadata FAKE_W26B_TEXT');
  const hostError = Object.assign(new Error('entrypoint FAKE_W26B_TEXT'), { code: 'INVALID_ENTRYPOINT' });
  const recognition = {
    refusal: (error) => (error === refusal ? 'thread.listMetadata' : undefined),
    hostCode: (error) => (error === hostError || error === refusal ? (error.code ?? 'DELIVERY_REJECTED') : undefined),
  };

  const projection = safeErrorProjection(new AggregateError([refusal, hostError], 'rollback'), recognition);

  assertNoCanary(projection);
  assert.equal(projection.origin, 'unverified');
  assert.deepEqual(
    projection.errors.map(({ origin, code, capability }) => ({ origin, code, capability })),
    [
      { origin: 'host_refusal', code: 'DELIVERY_REJECTED', capability: 'thread.listMetadata' },
      { origin: 'host', code: 'INVALID_ENTRYPOINT', capability: undefined },
    ],
  );
});

test('frames are read only from a stack that verifiably starts with the error, and only as locations', () => {
  const caused = new Error('outer');
  caused.stack = `${caused.stack}\nCaused by: Error: token=FAKE_W26B_CAUSED\n    at /FAKE_W26B/after-caused-by.js:1:1`;
  const appended = safeErrorProjection(caused);
  assertNoCanary(appended);
  assert.ok(
    appended.at.every((location) => !location.includes('after-caused-by')),
    'scanning stops at the first non-frame line',
  );

  const queried = new Error('queried');
  queried.stack = 'Error: queried\n    at load (file:///pkg/mod.js?v=FAKE_W26B_QUERY#frag:3:4)';
  assert.deepEqual(
    safeErrorProjection(queried).at,
    ['file:///pkg/mod.js:3:4'],
    'a location keeps no query or fragment',
  );

  const replaced = new Error('plain');
  replaced.stack = 'Error: something else\n    at /FAKE_W26B/replaced.js:1:1';
  assert.equal(safeErrorProjection(replaced).at, undefined, "a stack that is not the error's own yields no location");
  replaced.stack = 'Error: other\n    at /FAKE_W26B/same-length.js:1:1';
  assert.equal(safeErrorProjection(replaced).at, undefined, 'nor one whose header only has the same length');

  const named = safeErrorProjection(new Error('x'));
  assert.ok(
    named.at.every((location) => /^(?:file:\/\/|\/|node:).*:\d+:\d+$/u.test(location)),
    named.at.join(),
  );
  assert.ok(named.at.length <= 8);
});

test('the stack is bounded before it is read, and a line the bound cuts through is never kept', () => {
  const huge = new Error(`${'x'.repeat(40_000)} FAKE_W26B_HUGE`);
  assert.equal(safeErrorProjection(huge).at, undefined, 'a header longer than the scan bound yields no frames');

  const many = new Error('long');
  many.stack = `Error: long\n${'    at /pkg/frame.js:1:1\n'.repeat(10_000)}`;
  assert.equal(safeErrorProjection(many).at.length, 8);

  const frame = '    at /pkg/cut.js:1:12';
  const message = 'm'.repeat(16_384 - 'Error: '.length - 1 - (frame.length - 1));
  const cut = new Error(message);
  cut.stack = `Error: ${message}\n${frame}`;
  assert.equal(safeErrorProjection(cut).at, undefined, 'the bound falls inside the last frame: `:1:1` is not `:1:12`');
});

test('causes and aggregates are projected within bounds; cycles end', () => {
  const many = Array.from({ length: 50 }, () => new Error('FAKE_W26B_MANY'));
  const aggregate = safeErrorProjection(new AggregateError(many, 'FAKE_W26B_AGG'));
  assertNoCanary(aggregate);
  assert.equal(aggregate.type, 'AggregateError');
  assert.equal(aggregate.errors.length, 5);

  const first = new Error('first');
  const second = new Error('second', { cause: first });
  first.cause = second;
  const cyclic = safeErrorProjection(first);
  assert.equal(cyclic.cause.type, 'Error');
  assert.equal(cyclic.cause.cause, undefined);

  let deep = new Error('level 0');
  for (let level = 1; level < 50; level += 1) deep = new Error(`level ${level}`, { cause: deep });
  let depth = 0;
  for (let node = safeErrorProjection(deep); node.cause; node = node.cause) depth += 1;
  assert.equal(depth, 4);
});

test('a throwing getter or a hostile proxy yields a partial projection, never an exception', () => {
  const getters = {};
  for (const key of ['message', 'name', 'code', 'stack', 'cause', 'status', 'response']) {
    Object.defineProperty(getters, key, {
      enumerable: true,
      get() {
        throw new Error('FAKE_W26B_GETTER');
      },
    });
  }
  assert.deepEqual(safeErrorProjection(getters), { origin: 'unverified' });

  const hostile = new Proxy(new Error('FAKE_W26B_PROXY'), {
    get() {
      throw new Error('trap');
    },
    has() {
      throw new Error('trap');
    },
    getPrototypeOf() {
      throw new Error('trap');
    },
  });
  assert.deepEqual(safeErrorProjection(hostile), { origin: 'unverified' });

  const aggregate = new AggregateError([], 'aggregate');
  Object.defineProperty(aggregate, 'errors', {
    get() {
      throw new Error('FAKE_W26B_ERRORS');
    },
  });
  assert.equal(safeErrorProjection(aggregate).errors, undefined);

  const throwingRecognition = {
    refusal: () => {
      throw new Error('recognition failed');
    },
    hostCode: () => {
      throw new Error('recognition failed');
    },
  };
  assert.equal(safeErrorProjection(new Error('x'), throwingRecognition).origin, 'unverified');
});

test('values that are not errors are described by their kind only', () => {
  assert.deepEqual(safeErrorProjection('token=FAKE_W26B_STRING'), { origin: 'unverified', type: 'string' });
  assert.deepEqual(safeErrorProjection(undefined), { origin: 'unverified', type: 'undefined' });
  assert.deepEqual(safeErrorProjection(null), { origin: 'unverified', type: 'null' });
  const plain = safeErrorProjection({ apiKey: 'FAKE_W26B_PLAIN', message: 'FAKE_W26B_MESSAGE' });
  assert.deepEqual(plain, { origin: 'unverified' });
});
