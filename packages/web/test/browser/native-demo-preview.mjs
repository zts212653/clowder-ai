import assert from 'node:assert/strict';

async function childProtocol(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('Owned child renderer did not connect'));
    }, 10000);
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('Owned child renderer connection failed'));
      },
      { once: true },
    );
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Owned child renderer disconnected'));
    }
    pending.clear();
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Child renderer timed out: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

export async function exerciseDemoPreview(journey, task) {
  const iframe = journey.page.locator('iframe[title="今天待办 · 演示成果"]');
  const handle = await iframe.elementHandle();
  assert.ok(handle, 'The completed demo must contain its actual result frame');
  const trackedFrame = await handle.contentFrame();
  if (trackedFrame) {
    await trackedFrame.getByRole('textbox', { name: '新任务', exact: true }).fill(task);
    await trackedFrame.getByRole('button', { name: '添加', exact: true }).click();
    await trackedFrame.getByText(task, { exact: true }).waitFor();
    return 'playwright-frame';
  }
  // Electron 35's sandboxed OOPIF can be visible and alive while Playwright's
  // lower-fidelity CDP attachment omits it. Bind its actual DOM frame identity;
  // never reload/recreate the demo or synthesize application state to heal it.
  assert.ok(journey.nativeRenderer, 'A missing ordinary browser frame is a failure');
  const parent = await journey.page.context().newCDPSession(journey.page);
  const { root } = await parent.send('DOM.getDocument');
  const { nodeId } = await parent.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: 'iframe[title="今天待办 · 演示成果"]',
  });
  const { node } = await parent.send('DOM.describeNode', { nodeId });
  const endpoint = new URL(process.env.CAT_CAFE_ONBOARDING_E2E_CDP);
  const targets = await fetch(new URL('/json/list', endpoint)).then((response) => response.json());
  const target = targets.find((row) => row.id === node.frameId && row.type === 'iframe' && row.url === 'about:srcdoc');
  assert.ok(target?.webSocketDebuggerUrl, 'The visible result must have its own matching live renderer');
  assert.equal(new URL(target.webSocketDebuggerUrl).host, endpoint.host);
  assert.equal(new URL(target.webSocketDebuggerUrl).protocol, 'ws:');
  const child = await childProtocol(target.webSocketDebuggerUrl);
  try {
    const document = await child.send('DOM.getDocument');
    const input = await child.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '#new-task[aria-label="新任务"]',
    });
    assert.ok(input.nodeId, 'Actual result input is missing');
    await child.send('DOM.focus', { nodeId: input.nodeId });
    await child.send('Input.insertText', { text: task });
    const action = await child.send('Runtime.evaluate', {
      expression: `document.querySelector('#add-task').click(); [...document.querySelectorAll('li')].some(item => item.textContent.includes(${JSON.stringify(task)}))`,
      returnByValue: true,
    });
    assert.equal(action.result.value, true, 'The actual page must add the task through its own event handler');
    return 'owned-child-renderer-cdp';
  } finally {
    child.close();
    await parent.detach();
  }
}
