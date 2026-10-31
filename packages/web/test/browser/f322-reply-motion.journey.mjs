import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { THREAD_ID } from './f307-real-surface-fixtures.mjs';
import { readbackResponse, startNativeHost } from './f322-native-reply-next.mjs';

async function motion(cat) {
  return cat.evaluate(async (node) => {
    const style = getComputedStyle(node);
    const frames = node.getAnimations().flatMap((animation) => animation.effect.getKeyframes());
    const offsets = [];
    for (let i = 0; i < 20; i++) {
      offsets.push(new DOMMatrix(getComputedStyle(node).transform).m42);
      await new Promise(requestAnimationFrame);
    }
    return {
      pulse: node.dataset.pulse,
      name: style.animationName,
      duration: style.animationDuration,
      iterations: style.animationIterationCount,
      rise: Math.min(...frames.map((frame) => new DOMMatrix(frame.transform).m42)),
      offsets,
    };
  });
}

function assertRunning(sample) {
  assert.equal(sample.pulse, 'false');
  assert.equal(sample.iterations, 'infinite');
  assert.equal(sample.duration, '0.8s');
  assert.equal(sample.rise, -3);
  assert.ok(Math.max(...sample.offsets) - Math.min(...sample.offsets) > 0.5, 'actual browser frames move');
}

/** Native Next/Socket.IO/store/ChatMessage; controlled wire, real local command, no provider or live service. */
export async function runNativeReplyMotionJourney(browser, evidenceDir) {
  const out = evidenceDir && path.join(evidenceDir, 'motion-native');
  if (out) await mkdir(out, { recursive: true });
  const host = await startNativeHost();
  const context = await browser.newContext({
    viewport: { width: 720, height: 900 },
    ...(out ? { recordVideo: { dir: out, size: { width: 720, height: 900 } } } : {}),
  });
  const page = await context.newPage();
  const sockets = [],
    errors = [],
    samples = [],
    consoleMessages = [],
    wireMessages = [],
    queueReadbacks = [];
  let command;
  let liveSlot;
  const parent = 'motion-parent',
    turn = 'motion-turn';
  const trace = { threadId: THREAD_ID, userId: 'fixture-motion-owner' };
  const wire = (type, fields = {}) => {
    const message = {
      type,
      catId: 'codex',
      threadId: THREAD_ID,
      invocationId: parent,
      turnInvocationId: turn,
      messageId: 'motion-response',
      timestamp: Date.now(),
      ...fields,
    };
    wireMessages.push(message);
    sockets.findLast((connection) => connection.joined)?.socket.send(`42${JSON.stringify(['agent_message', message])}`);
  };
  const info = (payload) => wire('system_info', { content: JSON.stringify(payload) });
  const active = (lastActivityAt) => {
    const lifecycle = {
      type: 'app_server_lifecycle',
      stage: 'active',
      lastActivityAt,
      recoveryAttempt: 0,
      turnStartSent: true,
      turnAccepted: true,
      itemObserved: true,
    };
    liveSlot = {
      catId: 'codex',
      startedAt: liveSlot?.startedAt ?? lastActivityAt,
      executionId: parent,
      turnInvocationId: turn,
      appServerLifecycle: lifecycle,
    };
    info(lifecycle);
  };
  const use = (id, commandText) =>
    wire('tool_use', { toolEventId: id, toolName: 'Bash', toolInput: { command: commandText } });
  const save = async (name) => {
    if (out) await page.screenshot({ path: path.join(out, `${name}.png`) });
  };
  try {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (consoleMessages.length < 200) consoleMessages.push(message.text());
    });
    await context.addInitScript(() => {
      localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      localStorage.setItem('cat-cafe:shell-language', 'zh');
      localStorage.setItem('theme', 'light');
    });
    await page.routeWebSocket('**/socket.io/**', (socket) => {
      const connection = { socket, joined: false, clientPackets: [] };
      sockets.push(connection);
      const sid = `motion-${sockets.length}`;
      socket.send(`0${JSON.stringify({ sid, upgrades: [], pingInterval: 300000, pingTimeout: 200000 })}`);
      socket.onMessage((packet) => {
        const text = String(packet);
        connection.clientPackets.push(text);
        if (text.startsWith('40')) socket.send(`40${JSON.stringify({ sid })}`);
        if (!text.startsWith('42')) return;
        const bracket = text.indexOf('['),
          ack = text.slice(2, bracket);
        const [event, room] = JSON.parse(text.slice(bracket));
        if (event === 'join_room' && ack) {
          socket.send(`43${ack}${JSON.stringify([{ ok: true, room }])}`);
          if (room === `thread:${THREAD_ID}`) connection.joined = true;
        }
      });
    });
    await page.route('**/api/**', async (route) => {
      assert.equal(new URL(route.request().url()).origin, host.url, 'isolated Next origin only');
      const response = readbackResponse(route.request(), trace, null);
      if (new URL(route.request().url()).pathname === '/api/messages') response.body = { messages: [], hasMore: false };
      if (new URL(route.request().url()).pathname === `/api/threads/${THREAD_ID}/queue`) {
        // Reconnect/watchdog truth must match the controlled live wire, without refreshing its activity timestamp.
        response.body = { queue: [], paused: false, activeInvocations: liveSlot ? [liveSlot] : [] };
        queueReadbacks.push({ at: Date.now(), body: response.body });
      }
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
    });
    await host.ready();
    await page.goto(`${host.url}/thread/${THREAD_ID}?shell=v2`, { waitUntil: 'networkidle' });
    const collapse = page.getByTestId('sidebar-collapse');
    if (await collapse.isVisible()) await collapse.click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const joinDeadline = Date.now() + 5000;
    while (!sockets.some((connection) => connection.joined) && Date.now() < joinDeadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    const connection = sockets.findLast((connection) => connection.joined);
    assert.ok(connection, 'the native reader has joined its exact thread before injecting events');
    connection.socket.send(
      `42${JSON.stringify(['spawn_started', { threadId: THREAD_ID, targetCats: ['codex'], invocationId: parent }])}`,
    );
    info({ type: 'invocation_created', invocationId: turn, catId: 'codex' });
    active(Date.now());
    const startedAt = Date.now(),
      commandScript = 'setTimeout(() => process.stdout.write("done"), 33000)',
      commandText = `node -e '${commandScript}'`;
    use('motion-long-command', commandText);
    const cat = page.getByTestId('reply-activity-cat').last();
    await cat.waitFor();
    command = spawn(process.execPath, ['-e', commandScript], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    command.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    const completion = new Promise((resolve) => {
      command.once('error', (error) => resolve({ error }));
      command.once('exit', (code) => resolve({ code }));
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="reply-activity-cat"]')?.dataset.pulse === 'false',
    );
    samples.push({ stage: 'long-start', ...(await motion(cat)) });
    assertRunning(samples.at(-1));
    await save('long-start');
    console.log('native motion: actual local 33s command started; browser run is active');
    const commandResult = await completion;
    assert.equal(commandResult.code, 0, JSON.stringify(commandResult));
    const durationMs = Date.now() - startedAt;
    assert.ok(durationMs > 30000);
    samples.push({ stage: 'long-end', durationMs, stdout, ...(await motion(cat)) });
    assert.equal(stdout, 'done');
    assertRunning(samples.at(-1));
    await save('long-end');
    use('motion-next-call', 'node --version');
    active(Date.now());
    await page.waitForFunction(
      () => document.querySelector('[data-testid="reply-activity-cat"]')?.dataset.pulse === 'true',
    );
    const jump = await motion(cat);
    assert.equal(jump.iterations, '1');
    assert.equal(jump.duration, '0.6s');
    assert.equal(jump.rise, -6);
    assert.ok(Math.min(...jump.offsets) < -3, 'the high jump actually exceeds the small run');
    samples.push({ stage: 'new-call', ...jump });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="reply-activity-cat"]')?.dataset.pulse === 'false',
    );
    samples.push({ stage: 'resumed-run', ...(await motion(cat)) });
    assertRunning(samples.at(-1));
    await save('resumed-run');
    console.log('native motion: high jump passed; waiting for the real 2-minute silence deadline');
    const silenceStarted = Date.now();
    await page.getByTestId('reply-status').last().filter({ hasText: '没有动静' }).waitFor({ timeout: 125000 });
    samples.push({ stage: 'quiet', observedWaitMs: Date.now() - silenceStarted });
    assert.equal(await page.getByTestId('reply-activity-cat').count(), 0);
    assert.equal(await page.getByTestId('reply-status-dot').last().getAttribute('data-tone'), 'warning');
    await save('quiet');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    active(Date.now());
    use('motion-reduced-call', 'node --version');
    await cat.waitFor();
    assert.equal(await cat.evaluate((node) => getComputedStyle(node).animationName), 'none');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="reply-activity-cat"]')?.dataset.pulse === 'false',
    );
    assert.equal(await cat.evaluate((node) => getComputedStyle(node).animationName), 'none');
    await save('reduced-motion');
    info({
      type: 'liveness_warning',
      level: 'suspected_stall',
      state: 'busy-silent',
      silenceDurationMs: 3000,
      processAlive: true,
    });
    await cat.waitFor({ state: 'hidden' });
    assert.equal(await page.getByTestId('reply-status-dot').last().getAttribute('data-tone'), 'warning');
    await save('suspected-stall');
    assert.deepEqual(errors, []);
  } catch (error) {
    await save('failure');
    if (out)
      await writeFile(path.join(out, 'failure.txt'), `${error.stack}\n${await page.locator('body').innerText()}`);
    throw error;
  } finally {
    if (command?.exitCode === null) command.kill('SIGTERM');
    if (out)
      await writeFile(
        path.join(out, 'motion.json'),
        JSON.stringify(
          {
            source:
              'controlled Socket.IO carrier into native Next Host; real local child command; not provider/Alpha/live acceptance',
            url: host.url,
            samples,
            errors,
            consoleMessages,
            wireMessages,
            queueReadbacks,
            connections: sockets.map(({ joined, clientPackets }) => ({ joined, clientPackets })),
          },
          null,
          2,
        ),
      );
    await context.close();
    await host.close();
  }
}
