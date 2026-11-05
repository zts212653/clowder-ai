import { expect, it } from 'vitest';
import { profileUpdateDiff } from '../ProfileUpdateCardContent';

it('preserves an original profile diff whose contents include fences and heading-like text', () => {
  const rationale = 'Keep the confirmed preference.\n\n**当前内容：** is quoted here.';
  const before = '## Before\n\n```text\n**提议改为：**\n```';
  const after = '## After\n\nUse the **original** wording.';
  const fence = '````';
  const body = [rationale, '', '**当前内容：**', fence, before, fence, '', '**提议改为：**', fence, after, fence].join(
    '\n',
  );
  expect(profileUpdateDiff(body)).toEqual({ rationale, before, after });
});

it('does not treat a malformed or differently fenced original body as a verified before/after layout', () => {
  expect(
    profileUpdateDiff('Reason\n\n**当前内容：**\n```\nBefore\n```\n\n**提议改为：**\n````\nAfter\n````'),
  ).toBeNull();
  expect(profileUpdateDiff('A note without the canonical diff')).toBeNull();
});
