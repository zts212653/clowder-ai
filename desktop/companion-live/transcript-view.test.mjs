import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TranscriptView } from './transcript-view.mjs';

const require = createRequire(new URL('../../packages/api/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const fixture = () => {
  const dom = new JSDOM('<div id="transcript"></div>');
  const container = dom.window.document.getElementById('transcript');
  return { view: new TranscriptView(container), container };
};

test('interleaved user and assistant chunks each stay in their own utterance', () => {
  const { view, container } = fixture();
  view.append('user', '请读', true);
  view.append('assistant', '我来', true);
  view.append('user', '一下。', true);
  view.finish({ role: 'user', transcript: '请读一下。', turnId: 'user-1' });
  view.append('tool', '资料已返回');
  view.append('assistant', '读给你听。', true);
  view.finish({ role: 'assistant', transcript: '我来读给你听。', turnId: 'assistant-1' });
  assert.equal(container.querySelectorAll('.user').length, 1);
  assert.equal(container.querySelectorAll('.assistant').length, 1);
  assert.equal(container.querySelector('.user').textContent, '请读一下。');
  assert.equal(container.querySelector('.assistant').textContent, '我来读给你听。');
});

test('turn completion corrects text once and only seals its own speaker', () => {
  const { view, container } = fixture();
  view.append('user', '验证短语', true);
  view.append('assistant', '纸', true);
  view.finish({ role: 'user', transcript: '验证短语。', turnId: 'u1' });
  view.append('assistant', '彗星', true);
  const done = { role: 'assistant', transcript: '纸彗星。', turnId: 'a1' };
  view.finish(done);
  view.finish(done);
  view.append('assistant', '下一句。', true);
  assert.deepEqual(
    [...container.querySelectorAll('.assistant')].map((row) => row.textContent),
    ['纸彗星。', '下一句。'],
  );
  assert.equal(container.querySelector('.user').textContent, '验证短语。');
});
