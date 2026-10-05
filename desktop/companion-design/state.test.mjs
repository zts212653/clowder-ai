import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, reduce, restore } from './state.mjs';

function running() {
  return ['install', 'enable', 'start'].reduce((s, type) => reduce(s, { type }), initialState());
}

test('installation does not enable or share; only explicit start enters the experience', () => {
  const installed = reduce(initialState(), { type: 'install' });
  assert.equal(installed.installed, true);
  assert.equal(installed.enabled, false);
  assert.equal(installed.sharing, false);
  assert.equal(reduce(installed, { type: 'start' }).sharing, false);
  assert.equal(running().sharing, true);
});

test('switching applications keeps conversation, invalidates the point and requires sharing again', () => {
  let state = reduce(running(), { type: 'say', text: '青铜松果-725：我说的是这里的阴影' });
  state = reduce(state, { type: 'point', x: 384, y: 256 });
  const switched = reduce(state, { type: 'target', target: 'Blender窗口' });
  assert.equal(switched.messages[0].text, '青铜松果-725：我说的是这里的阴影');
  assert.equal(switched.sharing, false);
  assert.equal(switched.point, null);
  assert.ok(switched.generation > state.generation);
});

test('correction during thought fences an old answer but accepts a current question', () => {
  let state = reduce(running(), { type: 'think' });
  const oldGeneration = state.generation;
  state = reduce(state, { type: 'say', text: '看另一侧，刚才指错了' });
  state = reduce(state, { type: 'answer', generation: oldGeneration, text: '旧结论不得播出' });
  assert.equal(
    state.messages.some((m) => m.text === '旧结论不得播出'),
    false,
  );
  assert.match(state.notice, /旧/);
  state = reduce(state, { type: 'answer', generation: state.generation, text: '你指的是内侧接缝吗？' });
  assert.equal(state.messages.at(-1).text, '你指的是内侧接缝吗？');
});

test('pause/disconnect stop shared inputs and retain thought; reconnect does not silently share', () => {
  let state = reduce(running(), { type: 'think' });
  state = reduce(state, { type: 'pause' });
  assert.equal(state.sharing, false);
  assert.ok(state.thinking);
  assert.equal(reduce(state, { type: 'point', x: 1, y: 2 }).point, null);
  state = reduce(state, { type: 'disconnect' });
  assert.equal(state.connected, false);
  state = reduce(state, { type: 'reconnect' });
  assert.equal(state.sharing, false);
  assert.equal(state.connected, true);
});

test('remembered moments and arbitrary input survive restart; live connection never does', () => {
  let state = reduce(running(), { type: 'say', text: '陌生的雾蓝灯塔-916' });
  state = reduce(state, { type: 'remember', text: '保留倒角的疑问' });
  const next = restore(JSON.parse(JSON.stringify(state)));
  assert.equal(next.messages.at(-1).text, '陌生的雾蓝灯塔-916');
  assert.equal(next.moments.at(-1).text, '保留倒角的疑问');
  assert.equal(next.sharing, false);
  assert.equal(next.connected, false);
  assert.equal(next.point, null);
});

test('explicitly selected application set follows only its members and never resumes a paused input', () => {
  let state = reduce(running(), { type: 'follow', value: true });
  state = reduce(state, { type: 'target', target: 'Blender窗口' });
  assert.equal(state.sharing, true);
  state = reduce(state, { type: 'target', target: '会议窗口' });
  assert.equal(state.sharing, false);
  state = reduce(state, { type: 'target', target: 'B站窗口' });
  assert.equal(state.sharing, false);
});
