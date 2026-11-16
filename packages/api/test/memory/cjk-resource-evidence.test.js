import assert from 'node:assert/strict';
import { test } from 'node:test';
import { observeCjkRead } from '../../dist/domains/memory/message-cjk-read-diagnostics.js';

for (const failure of [false, true]) {
  test(`CJK keeps paired process resources with the existing terminal event (failure=${failure})`, () => {
    const events = [];
    const observer = observeCjkRead((snapshot) => events.push(snapshot));
    const original = new Error('original native error');
    const match = observer.wrap((text) => Number(text.includes('合成')));
    const read = () =>
      observer.read(() => {
        for (let i = 0; i < 300; i++) assert.equal(match('私有正文合成canary'), 1);
        if (failure) throw original;
        return ['result'];
      });
    if (failure) assert.throws(read, (error) => error === original);
    else assert.deepEqual(read(), ['result']);
    assert.equal(events.length, 2, 'existing checkpoint + terminal only');
    const terminal = events.at(-1);
    assert.equal(terminal.bodyVisits, 300);
    assert.equal(terminal.outcome, failure ? 'rejected' : 'fulfilled');
    assert.ok(terminal.resourcesBefore, 'CJK before resources missing');
    assert.ok(terminal.resourcesAfter, 'CJK after resources missing');
    assert.ok(terminal.resourceDelta);
    for (const key of ['userCpuUs', 'systemCpuUs']) {
      assert.equal(terminal.resourceDelta[key], terminal.resourcesAfter[key] - terminal.resourcesBefore[key]);
      assert.ok(terminal.resourceDelta[key] >= 0);
    }
    assert.equal(events[0].resourcesAfter, null, 'running progress must not pretend to be a complete pair');
    assert.doesNotMatch(JSON.stringify(events), /私有正文|canary|result|original/);
  });
}
