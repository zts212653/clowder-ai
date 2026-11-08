/**
 * PR-3a2 (contract §3.11.1 / §3.11.3): a connection that joins a thread room while a response is
 * still streaming receives, before its join acknowledgement, every event already broadcast into
 * that response — and only the responses its session user can read through History.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { ResponseStreamRecords } from '../../dist/infrastructure/websocket/ResponseStreamRecords.js';
import { SocketManager } from '../../dist/infrastructure/websocket/SocketManager.js';

function response(id, overrides = {}) {
  return {
    id,
    threadId: 't1',
    userId: 'default-user',
    from: { kind: 'agent', catId: 'opus' },
    catId: 'opus',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: 100,
    lifecycle: {
      kind: 'response',
      orderKey: `100:${id}`,
      invocationId: `turn-${id}`,
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
    ...overrides,
  };
}

function text(messageId, content, extra = {}) {
  return { type: 'text', catId: 'opus', messageId, content, timestamp: 1, invocationId: 'p', ...extra };
}

describe('ResponseStreamRecords', () => {
  it('records only events of open responses, without transport sequence fields', () => {
    const records = new ResponseStreamRecords();
    records.open(response('r1'));
    records.record(text('r1', 'A', { seq: 7, seqEpoch: 'e' }), 't1');
    records.record({ type: 'tool_use', catId: 'opus', messageId: 'r1', toolName: 'Read', timestamp: 2 }, 't1');
    records.record({ type: 'done', catId: 'opus', messageId: 'r1', timestamp: 3 }, 't1');
    records.record({ type: 'status', catId: 'opus', messageId: 'r1', content: 'streaming', timestamp: 3 }, 't1');
    records.record(text('r1', 'post body', { origin: 'callback' }), 't1');
    records.record(text('other', 'not a response'), 't1');
    records.record(text(undefined, 'unnamed'), 't1');

    const [entry, ...rest] = records.forThread('t1');
    assert.equal(rest.length, 0);
    assert.equal(entry.complete, true);
    assert.deepEqual(
      entry.events.map((event) => event.type),
      ['text', 'tool_use'],
    );
    assert.equal('seq' in entry.events[0], false);
    assert.equal('seqEpoch' in entry.events[0], false);
  });

  it('keeps an existing record when the same response is admitted again', () => {
    const records = new ResponseStreamRecords();
    records.open(response('r1'));
    records.record(text('r1', 'A'), 't1');
    records.open(response('r1'));
    records.record(text('r1', 'B'), 't1');
    assert.equal(records.forThread('t1')[0].events[0].content, 'AB');
  });

  it('numbers each broadcast of a response, joined deltas included', () => {
    const records = new ResponseStreamRecords();
    records.open(response('r1'));
    assert.deepEqual(
      [
        records.record(text('r1', 'A'), 't1'),
        records.record(text('r1', 'B'), 't1'),
        records.record({ type: 'done', catId: 'opus', messageId: 'r1', timestamp: 3 }, 't1'),
        records.record({ type: 'tool_use', catId: 'opus', messageId: 'r1', toolName: 'Read', timestamp: 4 }, 't1'),
        records.record(text('r1', 'C', { streamIndex: 99 }), 't1'),
      ],
      [0, 1, undefined, 2, 3],
    );
    const [entry] = records.forThread('t1');
    assert.equal(entry.nextIndex, 4);
    assert.equal(entry.events.length, 3);
    assert.equal('streamIndex' in entry.events[2], false);
  });

  it('joins adjacent append text whose other fields match, and nothing else', () => {
    const records = new ResponseStreamRecords();
    records.open(response('r1'));
    records.record(text('r1', 'A', { timestamp: 1 }), 't1');
    records.record(text('r1', 'B', { timestamp: 2 }), 't1');
    records.record({ type: 'tool_use', catId: 'opus', messageId: 'r1', toolName: 'Read', timestamp: 3 }, 't1');
    records.record(text('r1', 'C', { timestamp: 4 }), 't1');
    records.record(text('r1', 'D', { timestamp: 5, metadata: { provider: 'x', model: 'y' } }), 't1');
    records.record(text('r1', 'E', { timestamp: 6, metadata: { provider: 'x', model: 'y' } }), 't1');

    const events = records.forThread('t1')[0].events;
    assert.deepEqual(
      events.map((event) => [event.type, event.content ?? null, event.timestamp]),
      [
        ['text', 'AB', 1],
        ['tool_use', null, 3],
        ['text', 'C', 4],
        ['text', 'DE', 5],
      ],
    );
  });

  it('lets a replacing snapshot take the place of the adjacent text it supersedes', () => {
    const records = new ResponseStreamRecords();
    records.open(response('r1'));
    records.record(text('r1', 'draft'), 't1');
    records.record(text('r1', 'corrected', { textMode: 'replace' }), 't1');
    records.record(text('r1', 'corrected again', { textMode: 'replace' }), 't1');
    records.record(text('r1', ' tail'), 't1');

    const events = records.forThread('t1')[0].events;
    assert.deepEqual(
      events.map((event) => [event.textMode ?? 'append', event.content]),
      [
        ['replace', 'corrected again'],
        ['append', ' tail'],
      ],
    );
  });

  it('marks a runaway response incomplete at its hard ceiling and stops recording it', () => {
    const exceeded = [];
    const records = new ResponseStreamRecords({ maxBytes: 64, onCeilingExceeded: (info) => exceeded.push(info) });
    records.open(response('r1'));
    records.record(text('r1', 'x'.repeat(10)), 't1');
    records.record({ type: 'tool_use', catId: 'opus', messageId: 'r1', toolName: 'Y'.repeat(80), timestamp: 2 }, 't1');
    records.record(text('r1', 'after'), 't1');

    assert.equal(records.record(text('r1', 'after the ceiling'), 't1'), undefined);
    const [entry] = records.forThread('t1');
    assert.equal(entry.complete, false);
    assert.deepEqual(entry.events, []);
    assert.equal(exceeded.length, 1);
    assert.equal(exceeded[0].messageId, 'r1');
  });

  it('forgets a response once it is closed and lists only the asked thread', () => {
    const records = new ResponseStreamRecords();
    records.open(response('r1'));
    records.open(response('r2', { threadId: 't2' }));
    records.record(text('r1', 'A'), 't1');
    records.record(text('r2', 'B'), 't2');
    assert.deepEqual(
      records.forThread('t2').map((entry) => entry.response.id),
      ['r2'],
    );
    records.close('r1');
    records.record(text('r1', 'late'), 't1');
    assert.deepEqual(records.forThread('t1'), []);
  });
});

describe('SocketManager stream replay on join', () => {
  let httpServer;
  let socketManager;
  let client;

  afterEach(async () => {
    client?.disconnect();
    socketManager?.close();
    if (httpServer?.listening) await new Promise((resolve) => httpServer.close(resolve));
  });

  async function connect() {
    httpServer = createServer();
    socketManager = new SocketManager(httpServer);
    httpServer.listen(0, '127.0.0.1');
    await once(httpServer, 'listening');
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP address');
    client = ioClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
    await once(client, 'connect');
  }

  /** Every event this client receives, in arrival order, including the join acknowledgement. */
  function recordArrivals() {
    const arrivals = [];
    client.on('response_stream_replay', (payload) => arrivals.push(['replay', payload]));
    client.on('agent_message', (payload) => arrivals.push(['agent_message', payload]));
    return arrivals;
  }

  function join(room) {
    return new Promise((resolve) => {
      client.emit('join_room', room, resolve);
    });
  }

  it(
    'sends what a streaming response already broadcast before acknowledging the join',
    { timeout: 3_000 },
    async () => {
      await connect();
      const arrivals = recordArrivals();
      socketManager.openResponseStream(response('r1'));
      socketManager.broadcastAgentMessage(text('r1', 'A'), 't1');
      socketManager.broadcastAgentMessage(
        { type: 'tool_use', catId: 'opus', messageId: 'r1', toolName: 'Read', timestamp: 2 },
        't1',
      );
      socketManager.broadcastAgentMessage(text('r1', 'B'), 't1');

      const ack = await join('thread:t1');
      arrivals.push(['ack', ack]);
      socketManager.broadcastAgentMessage(text('r1', 'C'), 't1');
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.deepEqual(
        arrivals.map(([kind]) => kind),
        ['replay', 'ack', 'agent_message'],
      );
      const replay = arrivals[0][1];
      assert.equal(replay.threadId, 't1');
      assert.equal(typeof replay.joinId, 'string');
      assert.deepEqual(ack, { ok: true, room: 'thread:t1', joinId: replay.joinId });
      assert.equal(replay.responses.length, 1);
      assert.equal(replay.responses[0].messageId, 'r1');
      assert.equal(replay.responses[0].catId, 'opus');
      assert.equal(replay.responses[0].timestamp, 100);
      assert.equal(replay.responses[0].complete, true);
      assert.deepEqual(
        replay.responses[0].events.map((event) => [event.type, event.content ?? null]),
        [
          ['text', 'A'],
          ['tool_use', null],
          ['text', 'B'],
        ],
      );
      assert.equal(
        replay.responses[0].events.some((event) => 'seq' in event),
        false,
      );
      assert.equal(arrivals[2][1].content, 'C');
      // C is r's fourth broadcast since admission; the replay told the page to expect position 3.
      assert.equal(replay.responses[0].nextIndex, 3);
      assert.equal(arrivals[2][1].streamIndex, 3);
    },
  );

  it('sends an empty replay when nothing is streaming, so the page can tell', { timeout: 3_000 }, async () => {
    await connect();
    const arrivals = recordArrivals();
    const ack = await join('thread:t1');
    assert.deepEqual(arrivals, [['replay', { threadId: 't1', joinId: ack.joinId, responses: [] }]]);
  });

  it('names every thread-room join differently, and replays nothing for other rooms', { timeout: 3_000 }, async () => {
    await connect();
    const arrivals = recordArrivals();
    const first = await join('thread:t1');
    const second = await join('thread:t1');
    const userRoom = await join('user:default-user');
    assert.notEqual(first.joinId, second.joinId);
    assert.deepEqual(userRoom, { ok: true, room: 'user:default-user' });
    assert.deepEqual(
      arrivals.map(([, payload]) => payload.joinId),
      [first.joinId, second.joinId],
    );
  });

  it('withholds a response its connection could not read through History', { timeout: 3_000 }, async () => {
    await connect();
    const arrivals = recordArrivals();
    // Anonymous connections are `default-user`; this response belongs to somebody else.
    socketManager.openResponseStream(response('mine'));
    socketManager.openResponseStream(response('theirs', { userId: 'someone-else' }));
    socketManager.broadcastAgentMessage(text('mine', 'visible'), 't1');
    socketManager.broadcastAgentMessage(text('theirs', 'secret body'), 't1');

    await join('thread:t1');

    const replay = arrivals.find(([kind]) => kind === 'replay')[1];
    assert.deepEqual(
      replay.responses.map((entry) => entry.messageId),
      ['mine'],
    );
    assert.equal(JSON.stringify(replay).includes('secret body'), false);
  });

  it('replays nothing for a response whose terminal was committed', { timeout: 3_000 }, async () => {
    await connect();
    const arrivals = recordArrivals();
    socketManager.openResponseStream(response('r1'));
    socketManager.broadcastAgentMessage(text('r1', 'A'), 't1');
    socketManager.closeResponseStream('r1');
    await join('thread:t1');
    assert.deepEqual(arrivals[0][1].responses, []);
  });

  it('marks only events a later replay would carry', { timeout: 3_000 }, async () => {
    await connect();
    const arrivals = recordArrivals();
    await join('thread:t1');
    socketManager.broadcastAgentMessage(text('unrecorded', 'running across a restart'), 't1');
    socketManager.openResponseStream(response('r1'));
    socketManager.broadcastAgentMessage(text('r1', 'A'), 't1');
    socketManager.broadcastAgentMessage(
      { type: 'status', catId: 'opus', messageId: 'r1', content: 'x', timestamp: 1 },
      't1',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const live = arrivals.filter(([kind]) => kind === 'agent_message').map(([, payload]) => payload);
    assert.deepEqual(
      live.map((payload) => [payload.messageId, payload.type, payload.streamIndex ?? null]),
      [
        ['unrecorded', 'text', null],
        ['r1', 'text', 0],
        ['r1', 'status', null],
      ],
    );
  });

  it('replays only to the joining connection, never to the room', { timeout: 3_000 }, async () => {
    await connect();
    const first = client;
    await join('thread:t1');
    const firstReplays = [];
    first.on('response_stream_replay', (payload) => firstReplays.push(payload));
    const address = httpServer.address();
    client = ioClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], forceNew: true });
    await once(client, 'connect');
    socketManager.openResponseStream(response('r1'));
    socketManager.broadcastAgentMessage(text('r1', 'A'), 't1');
    await join('thread:t1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.disconnect();
    assert.deepEqual(firstReplays, []);
  });
});
