import assert from 'node:assert/strict';
import test from 'node:test';
import { canCreate, initial, reduce, restore, selected } from './state.mjs';

const setup = (fixture = 'one') => reduce(initial(fixture), { type: 'setup' });
test('changing tools restores each tool draft and blocks unavailable replacements', () => {
  let s = reduce(setup(), { type: 'edit', id: 'codex', patch: { model: 'GPT-6', effort: 'high', account: 'extra-1' } });
  s = reduce(s, { type: 'selectTool', id: 'codex', tool: 'claude' });
  assert.equal(s.candidates.codex.tool, 'claude');
  assert.equal(s.candidates.codex.model, '');
  assert.equal(s.candidates.codex.account, 'native');
  assert.equal(canCreate(s), false);
  s = restore(JSON.stringify(s));
  s = reduce(s, { type: 'selectTool', id: 'codex', tool: 'codex' });
  assert.equal(s.candidates.codex.model, 'GPT-6');
  assert.equal(s.candidates.codex.effort, 'high');
  assert.equal(s.candidates.codex.account, 'extra-1');
  assert.equal(canCreate(s), true);
});
test('ready native configuration is recommended without copying model overrides', () => {
  const s = setup();
  assert.equal(canCreate(s), true);
  assert.equal(selected(s).length, 1);
  assert.equal(s.candidates.codex.model, '');
  assert.equal(s.candidates.codex.effort, '');
  assert.equal(s.candidates.codex.cat, s.narrator);
  assert.deepEqual(s.members, []);
});
test('pending, unknown and missing tools cannot become members by clicking confirm', () => {
  for (const fixture of ['none', 'login', 'unknown']) {
    const s = setup(fixture);
    assert.equal(canCreate(s), false);
    assert.equal(reduce(s, { type: 'create' }).members.length, 0);
  }
  const s = reduce(setup('login'), { type: 'login', id: 'codex' });
  assert.equal(s.tools.codex.status, 'pending');
  assert.equal(canCreate(s), false);
  assert.equal(restore(JSON.stringify(s)).tools.codex.status, 'pending');
});
test('native API configuration is reused and unselected unready tools do not block', () => {
  const s = setup('many');
  assert.equal(s.tools.dsh.auth, 'native-api');
  assert.equal(selected(s).length, 2);
  assert.equal(s.tools.claude.status, 'login');
  assert.equal(canCreate(s), true);
});
test('login failure / cancellation and re-detection preserve explicit choices and drafts', () => {
  let s = setup('login');
  s = reduce(s, { type: 'edit', id: 'codex', patch: { name: '星河 73', effort: 'high' } });
  s = reduce(s, { type: 'login', id: 'codex' });
  s = reduce(s, { type: 'loginResult', id: 'codex', status: 'failed' });
  assert.equal(s.candidates.codex.name, '星河 73');
  assert.equal(canCreate(s), false);
  s = reduce(s, { type: 'login', id: 'codex' });
  s = reduce(s, { type: 'cancelLogin', id: 'codex' });
  assert.equal(s.tools.codex.status, 'login');
  s = reduce(s, { type: 'detected', id: 'codex', status: 'ready' });
  s = reduce(s, { type: 'toggle', id: 'codex' });
  s = reduce(s, { type: 'detected', id: 'codex', status: 'ready' });
  assert.equal(s.candidates.codex.selected, false);
  assert.equal(s.candidates.codex.effort, 'high');
});
test('partial creation and refresh retry retain stable ids and never duplicate members', () => {
  let s = setup('partial');
  s = reduce(s, { type: 'create' });
  assert.equal(s.members.length, 1);
  assert.equal(s.stage, 'setup');
  const id = s.members[0].id;
  s = restore(JSON.stringify(s));
  s = reduce(s, { type: 'create' });
  s = reduce(s, { type: 'create' });
  assert.equal(s.members.length, 2);
  assert.equal(s.members[0].id, id);
  assert.equal(new Set(s.members.map((m) => m.id)).size, 2);
});
test('first message, response failure and response are distinct; input survives reload', () => {
  let s = reduce(setup('reply-fail'), { type: 'create' });
  s = reduce(s, { type: 'chat' });
  s = reduce(s, { type: 'draft', text: 'sentinel-不在样例中的想法' });
  s = reduce(s, { type: 'send' });
  assert.equal(s.exchange, 'sent');
  s = reduce(s, { type: 'reply' });
  assert.equal(s.exchange, 'failed');
  s = reduce(restore(JSON.stringify(s)), { type: 'reply' });
  assert.equal(s.exchange, 'replied');
  assert.equal(s.messages.filter((m) => m.from === 'user').length, 1);
  assert.equal(s.messages[0].text, 'sentinel-不在样例中的想法');
});
test('guide and pins are independent; legacy empty pins remain empty on refresh', () => {
  let s = initial('existing');
  assert.equal(s.stage, 'chat');
  assert.equal(s.guide, 'not-needed');
  assert.deepEqual(s.pins, []);
  s = reduce(s, { type: 'guide', status: 'skipped' });
  assert.deepEqual(restore(JSON.stringify(s)).pins, []);
  assert.equal(restore(JSON.stringify(s)).guide, 'skipped');
});
test('model inheritance does not clear account and new account login does not switch usage', () => {
  let s = setup();
  s = reduce(s, { type: 'edit', id: 'codex', patch: { account: 'company', model: 'gpt-6.1', effort: 'high' } });
  s = reduce(s, { type: 'edit', id: 'codex', patch: { model: '' } });
  assert.equal(s.candidates.codex.account, 'company');
  assert.equal(s.candidates.codex.effort, 'high');
  s = reduce(s, { type: 'addAccount', name: '工作号' });
  s = reduce(s, { type: 'accountResult', status: 'ready' });
  assert.equal(s.accounts[0].used, false);
});
test('invalid saved schema is rejected without claiming it is a fresh user', () => {
  assert.equal(restore('{bad'), null);
  assert.equal(restore(JSON.stringify({ v: 1, stage: 'chat' })), null);
});
