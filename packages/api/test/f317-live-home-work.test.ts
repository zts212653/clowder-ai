import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { homeWorkFixture as fixture } from './helpers/f317-live-home-work-fixture.js';

test('ordinary empty-args callback selects a Host-issued publication and consumes the exact version through HomeHub', async () => {
  const f = await fixture();
  try {
    const result = await f.request();
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, 'applied');
    assert.equal(f.inputs[0].ownerRequest, '打开伙伴刚交的回家清单第2版');
    assert.equal(f.inputs[0].candidates[0].label, f.candidate.label);
    assert.match(f.inputs[0].candidates[0].id, /^work-[a-f0-9]{64}$/);
    assert.equal(f.scopes[0].catId, 'codex61-sol');
    assert.equal(f.scopes[0].callId, f.call.id);
    assert.equal(f.resolves(), 1);
    assert.deepEqual((f.grants[0] as { action: unknown }).action, {
      kind: 'publication',
      source: f.source,
      artifact: f.artifact,
    });
    assert.deepEqual(f.records, ['applied']);
  } finally {
    await f.close();
  }
});

test('production C source supplies only cat-readable original publications to the ordinary owner voice path', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.voice(['打开伙伴刚交的回家清单', '第2版'])).json().status, 'applied');
    assert.equal(f.inputs[0].candidates.filter((candidate) => candidate.id.startsWith('work-')).length, 1);
    assert.match(f.inputs[0].candidates[0].label, /回家清单.png.*第2版/);
    assert.ok(!JSON.stringify(f.inputs).includes('不应暴露的私密标题'));
    assert.deepEqual((f.grants[0] as { action: unknown }).action, {
      kind: 'publication',
      source: f.source,
      artifact: f.artifact,
    });
  } finally {
    await f.close();
  }
});

test('production C source rechecks cat permission at owner-window consume', async () => {
  const f = await fixture(true);
  try {
    f.consume(async () => f.revokePublication());
    assert.equal((await f.request()).json().status, 'blocked');
    assert.deepEqual(f.grants, [{ kind: 'blocked' }]);
  } finally {
    await f.close();
  }
});

test('complete committed same-call owner utterance reaches Jev unchanged; foreign voice has no request', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.voice(['打开伙伴刚交的回家清单', '第2版'])).json().status, 'applied');
    assert.equal(f.inputs[0].ownerRequest, '打开伙伴刚交的回家清单第2版');
  } finally {
    await f.close();
  }
  const foreign = await fixture();
  try {
    assert.equal((await foreign.voice(['打开回家清单'], 'other-call')).json().status, 'unavailable');
    assert.deepEqual(foreign.inputs, []);
    assert.deepEqual(foreign.grants, []);
  } finally {
    await foreign.close();
  }
});

for (const boundary of ['selection', 'consume'] as const)
  test(`source permission lost at ${boundary} prevents opening despite a forged applied ACK`, async () => {
    const f = await fixture();
    try {
      if (boundary === 'selection') f.select(async () => f.hide());
      else f.consume(async () => f.hide());
      const result = (await f.request()).json();
      assert.equal(result.status, boundary === 'selection' ? 'stale' : 'blocked');
      assert.ok(f.grants.every((grant) => (grant as { kind: string }).kind === 'blocked'));
    } finally {
      await f.close();
    }
  });

test('new owner speech cancels a publication selected from the previous request', async () => {
  const f = await fixture();
  try {
    f.select(async () => {
      await f.call.sendText('先别打开', randomUUID());
    });
    assert.equal((await f.request()).json().status, 'unconfirmed');
    assert.equal(f.resolves(), 0);
    assert.deepEqual(f.grants, []);
  } finally {
    await f.close();
  }
});

test('a different displayed version remains unconfirmed', async () => {
  const f = await fixture();
  try {
    f.wrongVersion();
    assert.equal((await f.request()).json().status, 'unconfirmed');
    assert.equal(f.resolves(), 1);
  } finally {
    await f.close();
  }
});

test('conversation without an explicit open request and an ambiguous version do not open works', async () => {
  const f = await fixture();
  try {
    f.choose('NONE');
    assert.equal((await f.request('聊聊伙伴刚交的回家清单')).json().status, 'none');
    f.choose('ASK');
    assert.equal((await f.request('打开某一版')).json().status, 'ask');
    assert.deepEqual(f.grants, []);
  } finally {
    await f.close();
  }
});

test('two valid Home pages expose a real page question, then open the exact publication only on the chosen page', async () => {
  const f = await fixture(true);
  try {
    const second = f.addPage('/settings?s=plugins');
    f.choosePage('ASK');
    const question = (await f.request()).json();
    assert.equal(question.status, 'ask');
    assert.match(question.reason, /页面1/);
    assert.match(question.reason, /页面2/);
    assert.match(question.reason, /settings/);
    assert.deepEqual(f.deliveries, []);
    f.choosePage('C1');
    const result = (await f.request('在页面2打开伙伴刚交的回家清单第2版')).json();
    assert.equal(result.status, 'applied');
    const offered = f.inputs.filter((input) => input.candidates[0]?.id.startsWith('home-page-'));
    assert.equal(offered.length, 2);
    assert.equal(offered[1].candidates.length, 2);
    assert.match(offered[1].candidates[1].label, /settings/);
    assert.deepEqual(f.deliveries, [second.clientId]);
    assert.deepEqual((f.grants[0] as { action: { artifact: unknown } }).action.artifact, f.artifact);
  } finally {
    await f.close();
  }
});

for (const missing of ['hidden', 'invalid', 'unresponsive'] as const)
  test(`a ${missing} Home page gives actionable discovery evidence before selecting a publication`, async () => {
    const f = await fixture();
    try {
      f.replies(
        missing === 'hidden' ? [null] : missing === 'invalid' ? [{ ...f.pages[0], clientToken: randomUUID() }] : [],
      );
      const result = (await f.request()).json();
      assert.equal(result.status, 'unavailable');
      assert.match(
        result.reason,
        new RegExp(
          missing === 'hidden' ? 'not_visible' : missing === 'invalid' ? 'capability_invalid' : 'unresponsive',
        ),
      );
      assert.deepEqual(f.inputs, []);
      assert.deepEqual(f.deliveries, []);
    } finally {
      await f.close();
    }
  });

test('no connected Home page is distinct from hidden and expired observations', async () => {
  const f = await fixture();
  try {
    const [page] = f.pages;
    f.service.hub.unregisterClient('owner', page.clientId, page.clientToken);
    f.replies([]);
    const result = (await f.request()).json();
    assert.equal(result.status, 'unavailable');
    assert.match(result.reason, /home_not_connected/);
    assert.deepEqual(f.inputs, []);
  } finally {
    await f.close();
  }
});

for (const change of ['route', 'token', 'hidden', 'source', 'owner-intent', 'displayed-version'] as const)
  test(`a multi-page publication selection cannot survive ${change} changing before consume`, async () => {
    const f = await fixture(true);
    try {
      f.addPage('/settings?s=plugins');
      f.choosePage('C1');
      f.consume(async () => {
        const selected = f.pages[1];
        if (change === 'route') selected.route = '/thread/changed';
        if (change === 'token')
          selected.clientToken = f.service.hub.registerClient('owner', selected.clientId).clientToken;
        if (change === 'hidden') f.replies([f.pages[0]]);
        if (change === 'source') f.revokePublication();
        if (change === 'owner-intent') await f.call.sendText('取消，不要打开', randomUUID());
        if (change === 'displayed-version') f.wrongVersion();
      });
      const result = (await f.request('在页面2打开伙伴刚交的回家清单第2版')).json();
      assert.notEqual(result.status, 'applied');
      assert.ok(
        f.grants.every((grant) => change === 'displayed-version' || (grant as { kind: string }).kind === 'blocked'),
      );
      assert.equal(f.deliveries.length, 1);
    } finally {
      await f.close();
    }
  });

test('the same multi-page choice also binds ordinary Home navigation and hides window credentials from Jev', async () => {
  const f = await fixture();
  try {
    f.hide();
    const second = f.addPage('/settings?s=plugins');
    f.choosePage('C1');
    assert.equal((await f.request('在页面2打开回家清单那段对话')).json().status, 'applied');
    assert.deepEqual(f.deliveries, [second.clientId]);
    const grant = f.grants[0] as { clientId: string; baseRoute: string; action: { kind: string } };
    assert.equal(grant.clientId, second.clientId);
    assert.equal(grant.baseRoute, '/settings?s=plugins');
    assert.equal(grant.action.kind, 'thread');
    for (const page of f.pages) assert.ok(!JSON.stringify(f.inputs).includes(page.clientToken));
  } finally {
    await f.close();
  }
});

test('an answer to an earlier page question cannot silently follow a renumbered page list', async () => {
  const f = await fixture();
  try {
    const second = f.addPage('/settings?s=plugins');
    f.choosePage('ASK');
    assert.equal((await f.request()).json().status, 'ask');
    f.replies([second]);
    f.choosePage('C0');
    const result = (await f.request('在页面1打开伙伴刚交的回家清单第2版')).json();
    assert.equal(result.status, 'ask');
    assert.match(result.reason, /变化/);
    assert.deepEqual(f.deliveries, []);
  } finally {
    await f.close();
  }
});

test('a single valid page is usable beside hidden and forged replies', async () => {
  const f = await fixture();
  try {
    f.replies([null, { ...f.pages[0], clientId: randomUUID(), clientToken: randomUUID() }, f.pages[0]]);
    assert.equal((await f.request()).json().status, 'applied');
    assert.equal(f.inputs.length, 1, 'invalid and hidden pages cannot create a page selection');
    assert.deepEqual(f.deliveries, [f.pages[0].clientId]);
  } finally {
    await f.close();
  }
});
