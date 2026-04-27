/**
 * F140 Phase E.1 Task 2 — setup-noise filter tests.
 *
 * Scope (AC-E6): 只吞 bot + conversation + setup-only（无 codex review content）。
 * 守护关键负例：人类引用 setup 文案不被过滤（砚砚 GPT-5.4 P1-1 / 对齐
 * github-review-mail-body-classifier.test.js:72 Rule 3 语义）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSetupNoiseFilter } from '../dist/infrastructure/email/setup-noise-filter.js';

const BOTS = ['chatgpt-codex-connector[bot]'];

// ── Positive: bot conversation setup-only ─────────────────────────

test('setup-noise: bot conversation setup-only → true', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'chatgpt-codex-connector[bot]',
      body: 'To use Codex here, create an environment for this repo.',
      commentType: 'conversation',
    }),
    true,
  );
});

test('setup-noise: bot conversation setup-only (markdown link variant) → true', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'chatgpt-codex-connector[bot]',
      body: 'To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/settings/environments).',
      commentType: 'conversation',
    }),
    true,
  );
});

// ── Negative: P1-1 守护负例集 ──────────────────────────────────────

test('setup-noise: human conversation 引用 setup 文案 → false（P1-1 关键守护）', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'octocat',
      body: 'Quoting for context: To use Codex here, create an environment for this repo. FYI.',
      commentType: 'conversation',
    }),
    false,
  );
});

test('setup-noise: bot conversation with real review content → false', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'chatgpt-codex-connector[bot]',
      body: 'Codex Review: Found 2 issues.\nReviewed commit: abc123\nTo use Codex here, create an environment for this repo.',
      commentType: 'conversation',
    }),
    false,
  );
});

test('setup-noise: bot inline comment (setup sentence) → false (inline 不触达)', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'chatgpt-codex-connector[bot]',
      body: 'To use Codex here, create an environment for this repo.',
      commentType: 'inline',
    }),
    false,
  );
});

test('setup-noise: non-bot author even if setup-only → false (author allowlist 外)', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'some-other-bot[bot]',
      body: 'To use Codex here, create an environment for this repo.',
      commentType: 'conversation',
    }),
    false,
  );
});

test('setup-noise: normal human comment → false', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'octocat',
      body: 'LGTM',
      commentType: 'conversation',
    }),
    false,
  );
});

test('setup-noise: empty body → false', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'chatgpt-codex-connector[bot]',
      body: '',
      commentType: 'conversation',
    }),
    false,
  );
});

test('setup-noise: bot without setup sentence (other content) → false', () => {
  const filter = createSetupNoiseFilter(BOTS);
  assert.equal(
    filter({
      author: 'chatgpt-codex-connector[bot]',
      body: 'This PR looks good overall.',
      commentType: 'conversation',
    }),
    false,
  );
});
