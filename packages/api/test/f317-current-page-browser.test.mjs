import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCdpPageActionPort } from '../src/domains/concierge/action/CdpPageActionPort.ts';
import { currentPageEpisode as episode } from './helpers/f317-current-page-fixture.mjs';
import { appendUser } from './helpers/f317-page-action-fixture.ts';

test('owner selects an unadapted page by tab identity; real controls/one confirmation/readback preserve the unrelated duplicate tab', async (t) => {
  const e = await episode(t);
  assert.equal(
    (
      await e.app.inject({
        method: 'POST',
        url: `${e.route}/pages`,
        headers: { origin: 'http://localhost:3011' },
        payload: { requestMessageId: e.f.source.id },
      })
    ).statusCode,
    401,
  );
  assert.equal((await e.service.view()).pageUrl, '');
  const preview = await e.choose();
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().preview.field, '清单');
  assert.equal(preview.json().preview.value, '带伞');
  assert.equal(await e.value(), '原值', 'selection is not execution');
  const id = preview.json().preview.previewId;
  const result = await e.post('confirm', { previewId: id });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'applied');
  assert.equal(result.json().forward.after, '带伞');
  assert.equal(await e.value(), '带伞');
  assert.equal(await e.other.$eval('input[aria-label="清单"]', (node) => node.value), '原值');
  assert.equal(await e.other.evaluate(() => innerWidth), 1280);
  assert.equal((await e.post('confirm', { previewId: id })).statusCode, 409);
});

test('pointer-disabled and covered controls never enter discovery; consent does not authorize a later occluded click', async (t) => {
  const e = await episode(
    t,
    async ({ candidates }) => ({
      kind: 'act',
      targetId: candidates.find((item) => item.operation === 'click').id,
      operation: 'click',
    }),
    '点击「展开清单」',
  );
  for (const mutation of ['pointer-disabled', 'overlay']) {
    await e.page.reload();
    const preview = (await e.choose()).json().preview;
    // Change surrounding CSS/DOM, keeping the consented button's own HTML and label identical.
    await e.page.evaluate((condition) => {
      const button = document.querySelector('button');
      window.ownerTestClicks = 0;
      button.addEventListener('click', () => window.ownerTestClicks++);
      if (condition === 'pointer-disabled') {
        const style = document.createElement('style');
        style.textContent = 'button:first-of-type { pointer-events: none; }';
        document.head.append(style);
      } else {
        const rect = button.getBoundingClientRect(),
          overlay = document.createElement('div');
        Object.assign(overlay.style, {
          position: 'fixed',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          zIndex: '1000',
        });
        document.body.append(overlay);
      }
    }, mutation);
    const result = await e.post('confirm', { previewId: preview.previewId });
    assert.equal(result.statusCode, 200, result.body);
    assert.notEqual(result.json().status, 'applied');
    assert.equal(await e.page.evaluate(() => window.ownerTestClicks), 0);
    assert.equal(await e.page.$eval('button', (node) => node.textContent), '展开清单');
    assert.equal((await e.post('confirm', { previewId: preview.previewId })).statusCode, 409);
  }
});

test('cancellation and identical DOM replacement after consent cannot write', async (t) => {
  const e = await episode(t);
  let preview = (await e.choose()).json().preview;
  const cancelled = await e.app.inject({
    method: 'DELETE',
    url: e.route,
    headers: e.headers,
    payload: { previewId: preview.previewId },
  });
  assert.equal(cancelled.statusCode, 200);
  assert.equal((await e.post('confirm', { previewId: preview.previewId })).statusCode, 409);
  assert.equal(await e.value(), '原值');
  preview = (await e.choose()).json().preview;
  await e.page.evaluate(() => {
    const node = document.querySelector('input');
    node.replaceWith(node.cloneNode(true));
  });
  const stale = await e.post('confirm', { previewId: preview.previewId });
  assert.equal(stale.json().forward.status, 'stale');
  assert.equal(stale.json().forward.reason, 'target_changed_since_grant');
  assert.equal((await e.post('confirm', { previewId: preview.previewId })).statusCode, 409);
  assert.equal(await e.value(), '原值');
});

test('page navigation, invented selection IDs and changed direct requests require a fresh owner choice', async (t) => {
  const e = await episode(t);
  const chosen = await e.list();
  await e.page.goto(`${e.page.url()}?changed=1`);
  assert.equal((await e.post('select', { requestMessageId: e.f.source.id, pageId: chosen.pageId })).statusCode, 409);
  assert.equal(
    (await e.post('select', { requestMessageId: e.f.source.id, pageId: crypto.randomUUID() })).statusCode,
    409,
  );
  assert.equal(
    (await e.post('select', { requestMessageId: e.f.source.id, pageId: chosen.pageId, url: e.page.url() })).statusCode,
    400,
  );
  const later = appendUser(e.f.store, '取消，改为别的请求', 'changed-current-page');
  assert.equal((await e.post('select', { requestMessageId: later.id, pageId: chosen.pageId })).statusCode, 409);
  assert.equal(await e.value(), '原值');
});

test('generic click reads the actual control afterward and keeps unknown business effect unknown', async (t) => {
  const e = await episode(
    t,
    async ({ candidates }) => ({
      kind: 'act',
      targetId: candidates.find((item) => item.operation === 'click').id,
      operation: 'click',
    }),
    '点击「展开清单」',
  );
  const response = await e.choose();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().preview.expectedReadback, undefined);
  const result = await e.post('confirm', { previewId: response.json().preview.previewId });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().status, 'unknown');
  assert.equal(result.json().forward.after, '已点击');
  assert.equal(result.json().forward.reason, 'effect_unverified');
  assert.equal(await e.value(), '原值');
});

test('a control that becomes sensitive, hidden, read-only or externally relabelled after consent cannot be filled', async (t) => {
  const e = await episode(t);
  const mutations = [
    () => {
      document.querySelector('input').type = 'password';
    },
    () => {
      document.querySelector('input').hidden = true;
    },
    () => {
      document.querySelector('input').parentElement.style.opacity = '0';
    },
    () => {
      document.querySelector('input').parentElement.inert = true;
    },
    () => {
      document.querySelector('input').readOnly = true;
    },
    () => {
      document.querySelector('input').setAttribute('aria-label', '别的目标');
    },
  ];
  for (const mutate of mutations) {
    await e.page.reload();
    const response = await e.choose();
    assert.equal(response.statusCode, 200, response.body);
    await e.page.evaluate(mutate);
    const result = await e.post('confirm', { previewId: response.json().preview.previewId });
    assert.equal(result.statusCode, 200, result.body);
    assert.notEqual(result.json().status, 'applied');
    assert.equal(await e.page.$eval('input', (node) => node.value), '原值');
  }
});

test('late Jev selection cannot outlive the current owner request', async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let unblock;
  const blocked = new Promise((resolve) => {
    unblock = resolve;
  });
  t.after(() => unblock());
  const e = await episode(t, async ({ candidates }) => {
    entered();
    await blocked;
    return { kind: 'act', targetId: candidates[0].id, operation: 'fill', value: '带伞' };
  });
  const chosen = await e.list();
  const selecting = e.post('select', { requestMessageId: e.f.source.id, pageId: chosen.pageId });
  await Promise.race([
    started,
    selecting.then((response) => {
      throw new Error(`Jev selection never started: ${response.statusCode} ${response.body}`);
    }),
  ]);
  appendUser(e.f.store, '取消该操作', 'cancel-during-jev');
  unblock();
  const response = await selecting;
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(await e.value(), '原值');
});

test('the isolated actor rechecks pointer eligibility after awaiting the Host commit fence', async (t) => {
  const e = await episode(t);
  for (const condition of ['pointer-disabled', 'overlay']) {
    await e.page.reload();
    const port = createCdpPageActionPort(e.page, {
      currentControls: true,
      targets: [{ id: 'button', selector: 'button:first-of-type', operation: 'click' }],
      readback: { selector: 'button:first-of-type', kind: 'text' },
    });
    try {
      const snapshot = await port.inspect();
      assert.equal(snapshot.candidates.length, 1, 'a topmost descendant is part of its button');
      const outcome = await port.perform(
        { kind: 'act', targetId: 'button', operation: 'click' },
        snapshot.candidates[0].fingerprint,
        snapshot.url,
        'r1',
        async () => {
          await e.page.evaluate((mutation) => {
            const button = document.querySelector('button'),
              node = document.createElement('div');
            if (mutation === 'pointer-disabled') {
              node.innerHTML = '<style>button:first-of-type { pointer-events:none }</style>';
            } else {
              const r = button.getBoundingClientRect();
              Object.assign(node.style, {
                position: 'fixed',
                left: `${r.left}px`,
                top: `${r.top}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
                zIndex: '1000',
              });
            }
            document.body.append(node);
          }, condition);
          return 'current';
        },
      );
      assert.equal(outcome, 'stale');
      assert.equal(await e.page.$eval('button', (node) => node.textContent), '展开清单');
    } finally {
      await port.close();
    }
  }
});

test('current-page callback status and fresh inspect expose observations while owner GET retains consent coordinates', async (t) => {
  const e = await episode(t);
  await e.page.goto(`${e.page.url()}?owner_only=private-fixture`);
  const ownerPreview = (await e.choose()).json().preview;
  const assertProjected = (response) => {
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('private-fixture'));
    assert.ok(!response.body.includes('原值'), 'existing field values are owner-only');
    const visit = (object) => {
      for (const [key, value] of Object.entries(object)) {
        assert.ok(
          ![
            'pageUrl',
            'fieldSelector',
            'readbackSelector',
            'permissionScope',
            'previewId',
            'profileId',
            'fingerprint',
            'before',
            'after',
          ].includes(key),
          `Host-only ${key}`,
        );
        if (value && typeof value === 'object') visit(value);
      }
    };
    visit(response.json());
    return response.json();
  };
  const model = assertProjected(await e.callback('status'));
  assert.equal(model.preview.field, '清单');
  assert.equal(model.preview.value, '带伞');
  assert.equal(model.preview.selection.servedModel, 'jev-1.13.0-stub');
  const owner = await e.app.inject({ method: 'GET', url: e.route, headers: e.headers });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.json().pageUrl, e.page.url());
  assert.equal(owner.json().preview.fieldSelector, ownerPreview.fieldSelector);
  assert.equal(owner.json().preview.previewId, ownerPreview.previewId);
  await e.app.inject({
    method: 'DELETE',
    url: e.route,
    headers: e.headers,
    payload: { previewId: ownerPreview.previewId },
  });
  const fresh = assertProjected(await e.callback('inspect'));
  assert.equal(fresh.kind, 'awaiting_consent');
  assert.equal(fresh.preview.field, '清单');
  const currentOwner = (await e.service.view()).preview;
  assert.equal((await e.post('confirm', { previewId: currentOwner.previewId })).json().status, 'applied');
  const settled = assertProjected(await e.callback('status'));
  assert.equal(settled.result.status, 'applied');
  assert.equal(settled.result.forward.status, 'applied');
  assert.equal(settled.result.receiptPersistence, 'stored');
  assert.equal((await e.callback('status', { 'x-invocation-id': 'other-invocation' })).statusCode, 403);
});
