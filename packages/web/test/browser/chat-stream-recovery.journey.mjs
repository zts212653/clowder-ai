import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * PR-3a2 (contract §3.11.4) browser journeys. Only the wire is simulated: a server that confirms a
 * thread-room join with a stream replay followed by an acknowledgement carrying the same join id,
 * and broadcasts agent messages to the connections in the room. The page's Socket.IO client,
 * runtime owner, store, History merge and rendering are production code.
 */
function createWireServer() {
  const connections = [];
  /** threadId -> messageId -> { catId, timestamp, events } — what each streaming reply has broadcast. */
  const records = new Map();
  let joins = 0;
  const send = (connection, event, payload) => connection.socket.send(`42${JSON.stringify([event, payload])}`);
  return {
    connections,
    joinsOf: (label, room) =>
      connections
        .filter((connection) => connection.label === label)
        .reduce((count, connection) => count + connection.joined.filter((joined) => joined === room).length, 0),
    async attach(page, label) {
      await page.routeWebSocket('**/socket.io/**', (socket) => {
        const connection = { socket, label, rooms: new Set(), joined: [], trace: [], open: true };
        connections.push(connection);
        const sid = `${label}-${connections.length}`;
        socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 })}`);
        socket.onMessage((packet) => {
          const text = String(packet);
          if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
          if (!text.startsWith('42')) return;
          const bracket = text.indexOf('[');
          const ackId = text.slice(2, bracket);
          const [event, room] = JSON.parse(text.slice(bracket));
          connection.trace.push(`${event}:${typeof room === 'string' ? room : '?'}`);
          if (event === 'leave_room') connection.rooms.delete(room);
          if (event !== 'join_room') return;
          connection.rooms.add(room);
          connection.joined.push(room);
          const ack = { ok: true, room };
          if (room.startsWith('thread:')) {
            const threadId = room.slice('thread:'.length);
            ack.joinId = `${sid}:${++joins}`;
            const responses = [...(records.get(threadId) ?? new Map())].map(([messageId, record]) => ({
              messageId,
              catId: record.catId,
              timestamp: record.timestamp,
              events: [...record.events],
              complete: true,
              nextIndex: record.events.length,
            }));
            send(connection, 'response_stream_replay', { threadId, joinId: ack.joinId, responses });
          }
          if (ackId) socket.send(`43${ackId}${JSON.stringify([ack])}`);
        });
      });
    },
    openRecord(threadId, messageId, catId, timestamp) {
      if (!records.has(threadId)) records.set(threadId, new Map());
      records.get(threadId).set(messageId, { catId, timestamp, events: [] });
    },
    broadcast(threadId, message) {
      const record = records.get(threadId)?.get(message.messageId);
      record?.events.push(message);
      // Like SocketManager: an event in its response's record carries its position in that stream.
      const event = { ...message, ...(record ? { streamIndex: record.events.length - 1 } : {}), threadId };
      for (const connection of connections) {
        if (connection.open && connection.rooms.has(`thread:${threadId}`)) send(connection, 'agent_message', event);
      }
    },
    async drop(connection) {
      connection.open = false;
      await connection.socket.close({ code: 1000, reason: 'fixture transport interruption' });
    },
  };
}

function servePage(page, { origin, bundle, api, html }) {
  return page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    assert.equal(url.origin, origin, 'the proof must not access a live service');
    if (url.pathname === '/proof.js') return route.fulfill({ contentType: 'text/javascript', body: bundle() });
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(api(url)) });
    }
    return route.fulfill({
      contentType: 'text/html',
      body:
        html ??
        '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="/proof.js"></script>',
    });
  });
}

const fallbackApi = (url) => {
  if (url.pathname.endsWith('/queue')) return { queue: [], activeInvocations: [], paused: false };
  if (url.pathname === '/api/executions/active') return { projectPath: '/fixture', executions: [] };
  return { userId: 'fixture-owner', tasks: [], threads: [], cats: [], activeInvocations: [], queue: [] };
};

export function registerStreamRecoveryJourneys({ origin, threadId, browser, bundle }) {
  test('a reply streaming across a reconnect reads the same as on a page that never lost the room', async () => {
    const server = createWireServer();
    const draft = { content: '' };
    const reply = () => ({
      from: { kind: 'agent', catId: 'codex-astra' },
      id: 'streaming-reply',
      catId: 'codex-astra',
      content: draft.content,
      origin: 'stream',
      isDraft: true,
      timestamp: 2,
      extra: { stream: { invocationId: 'parent', turnInvocationId: 'turn' } },
      lifecycle: {
        kind: 'response',
        orderKey: '2:turn',
        invocationId: 'turn',
        targetId: 'codex-astra',
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: 2,
      },
    });
    const api = (url) =>
      url.pathname === '/api/messages'
        ? { messages: [{ id: 'before', content: 'Please continue', timestamp: 1 }, reply()], hasMore: false }
        : fallbackApi(url);
    const chunk = (content) => ({
      type: 'text',
      catId: 'codex-astra',
      messageId: 'streaming-reply',
      content,
      invocationId: 'parent',
      turnInvocationId: 'turn',
      timestamp: 3,
    });
    server.openRecord(threadId, 'streaming-reply', 'codex-astra', 2);
    const pages = [];
    const errors = [];
    try {
      for (const label of ['watching', 'returning']) {
        const page = await browser().newPage();
        pages.push(page);
        page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
        await page.clock.install();
        await server.attach(page, label);
        await servePage(page, { origin, bundle, api });
        await page.goto(origin, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-message-id="before"]').waitFor();
        await page.locator('main[data-connected="true"]').waitFor();
      }
      const [watching, returning] = pages;
      const room = `thread:${threadId}`;
      assert.equal(server.joinsOf('returning', room), 1);

      server.broadcast(threadId, chunk('A|'));
      await returning.locator('[data-message-id="streaming-reply"]', { hasText: /^A\|$/ }).waitFor();
      await server.drop(server.connections.find((connection) => connection.label === 'returning'));
      await returning.locator('main[data-connected="false"]').waitFor();
      // Broadcast while the returning page is offline; the History draft lags behind it.
      server.broadcast(threadId, chunk('MISSED-MIDDLE|'));
      draft.content = 'A|';
      await returning.clock.runFor(6000);
      await returning.locator('main[data-connected="true"]').waitFor({ timeout: 5000 });
      assert.equal(server.joinsOf('returning', room), 2, 'the reconnect joined the room again');
      server.broadcast(threadId, chunk('C|'));
      await returning.clock.runFor(1000);

      const expected = /^A\|MISSED-MIDDLE\|C\|$/;
      await watching.locator('[data-message-id="streaming-reply"]', { hasText: expected }).waitFor({ timeout: 3000 });
      await returning.locator('[data-message-id="streaming-reply"]', { hasText: expected }).waitFor({ timeout: 3000 });
      assert.equal(
        await returning.locator('[data-message-id="streaming-reply"]').innerText(),
        await watching.locator('[data-message-id="streaming-reply"]').innerText(),
      );
      assert.deepEqual(errors, []);
    } finally {
      for (const page of pages) await page.close();
    }
  });

  test('a message deleted on another page while this one was away does not come back', async () => {
    const server = createWireServer();
    const messages = ['kept-1', 'deleted-elsewhere', 'kept-2'].map((id, index) => ({
      from: { kind: 'agent', catId: 'codex-astra' },
      id,
      type: 'assistant',
      catId: 'codex-astra',
      timestamp: index + 1,
      content: `Message ${id}`,
    }));
    const api = (url) => {
      if (url.pathname !== '/api/messages') return fallbackApi(url);
      if (url.searchParams.get('threadId') === 'chat-other') {
        return { messages: [{ ...messages[0], id: 'other' }], hasMore: false };
      }
      return { messages, hasMore: false };
    };
    const page = await browser().newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await server.attach(page, 'reader');
      await servePage(page, { origin, bundle, api });
      await page.goto(`${origin}/${threadId}?scroll=1&rooms=1`);
      await page.locator('[data-message-id="deleted-elsewhere"]').waitFor();
      const room = `thread:${threadId}`;
      const joinsBefore = server.joinsOf('reader', room);
      assert.ok(joinsBefore >= 1, 'the thread room was joined');

      await page.getByRole('button', { name: 'Other thread', exact: true }).click();
      await page.locator('[data-message-id="other"]').waitFor();
      // Deleted elsewhere; the delete reaches only the thread room this page has left.
      messages.splice(1, 1);
      await page.goBack();
      await page.locator('[data-message-id="kept-2"]').waitFor();
      await page.locator('[data-message-id="deleted-elsewhere"]').waitFor({ state: 'detached', timeout: 5000 });
      assert.ok(server.joinsOf('reader', room) > joinsBefore, 'returning joined the thread room again');
      assert.equal(await page.locator('[data-message-id="kept-1"]').count(), 1);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('a long thread keeps the reader on the same line after leaving and entering it again', async () => {
    const server = createWireServer();
    const records = Array.from({ length: 80 }, (_, index) => ({
      from: { kind: 'agent', catId: 'codex-astra' },
      id: `scroll-${index + 1}`,
      type: 'assistant',
      catId: 'codex-astra',
      timestamp: index + 1,
      content: `Reading message ${index + 1}\n${'Long conversation evidence. '.repeat(40)}`,
    }));
    const cursors = [];
    const api = (url) => {
      if (url.pathname !== '/api/messages') return fallbackApi(url);
      if (url.searchParams.get('threadId') === 'chat-other') {
        return { messages: [{ ...records[0], id: 'other' }], hasMore: false };
      }
      const before = url.searchParams.get('before');
      cursors.push(before);
      return { messages: before ? records.slice(0, 30) : records.slice(30), hasMore: !before };
    };
    const page = await browser().newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const sample = () =>
      page.locator('[data-scroll-chat]').evaluate((el) => {
        const viewport = el.getBoundingClientRect();
        const node = [...el.querySelectorAll('[data-message-viewport-id]')].find(
          (candidate) => candidate.getBoundingClientRect().bottom > viewport.top,
        );
        return { id: node?.dataset.messageViewportId, offset: node?.getBoundingClientRect().top - viewport.top };
      });
    try {
      await server.attach(page, 'reader');
      await servePage(page, {
        origin,
        bundle,
        api,
        html: '<!doctype html><style>[data-message-viewport-boundary]{content-visibility:auto}article{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/proof.js"></script>',
      });
      await page.goto(`${origin}/${threadId}?scroll=1&rooms=1`);
      await page.locator('[data-message-id="scroll-80"]').waitFor();
      const chat = page.locator('[data-scroll-chat]');
      await chat.hover();
      await page.mouse.wheel(0, -100000);
      await page.locator('[data-message-id="scroll-5"]').waitFor();
      await page.waitForTimeout(750);
      await chat.evaluate((el) => {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -1 }));
        const target = el.querySelector('[data-message-viewport-id="scroll-5"]');
        el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top + 27;
      });
      await page.waitForTimeout(300);
      const before = await sample();
      assert.equal(before.id, 'scroll-5');

      const room = `thread:${threadId}`;
      const joinsBefore = server.joinsOf('reader', room);
      await page.getByRole('button', { name: 'Other thread', exact: true }).click();
      await page.locator('[data-message-id="other"]').waitFor();
      const readsBeforeReturn = cursors.length;
      await page.goBack();
      await page.locator('[data-message-id="scroll-5"]').waitFor();
      await page.waitForTimeout(1500);
      assert.ok(
        server.joinsOf('reader', room) > joinsBefore,
        `entering again joined the room again: ${JSON.stringify(server.connections.map((connection) => connection.trace))}`,
      );
      assert.ok(cursors.length > readsBeforeReturn, 'the confirmed join was followed by a History read');
      const back = await sample();
      assert.equal(back.id, before.id, JSON.stringify({ before, back }));
      assert.ok(Math.abs(back.offset - before.offset) <= 1, JSON.stringify({ before, back }));
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
