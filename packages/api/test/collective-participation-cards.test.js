import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registeredCollectiveCats } from '../dist/domains/plugin/builtin-runtime/collective-participation-cards.js';

test('registered Collective cards distinguish same-breed Cats and keep their own profile', () => {
  const cards = registeredCollectiveCats(
    [
      {
        id: 'codex',
        displayName: '缅因猫',
        nickname: '砚砚',
        avatar: '/avatars/codex.png',
        roleDescription: '代码审查',
        defaultModel: 'gpt-5.3-codex',
      },
      {
        id: 'codex-sol',
        displayName: '缅因猫',
        nickname: '砚砚',
        variantLabel: 'Sol',
        avatar: '/avatars/codex-sol.png',
        roleDescription: '复杂实现',
        defaultModel: 'gpt-6-sol',
      },
    ],
    () => true,
  );
  assert.deepEqual(cards, [
    {
      id: 'codex',
      displayName: '缅因猫（砚砚）',
      supported: true,
      avatar: '/avatars/codex.png',
      roleDescription: '代码审查',
      defaultModel: 'gpt-5.3-codex',
    },
    {
      id: 'codex-sol',
      displayName: '缅因猫（Sol）',
      supported: true,
      avatar: '/avatars/codex-sol.png',
      roleDescription: '复杂实现',
      defaultModel: 'gpt-6-sol',
    },
  ]);
});
