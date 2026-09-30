/**
 * F202 W2-3 h3c-2 — one Host-owned answer to "which cat is the cloud cat of this conversation
 * provider" (ledger「h3c 实现设计」h3c-2; astra's design reviews, Host thread …000181 / …000188).
 *
 * The contract names cloud-conversation providers (`chatgpt`); the Host's cat configuration names cat
 * providers (`openai-chatgpt-pro`). One Host table joins them, and the cat configuration decides
 * which cat that is — never a package, never a literal. Zero cats means the provider is unavailable;
 * more than one is ambiguous and refused for that provider only.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CLOUD_CONVERSATION_PROVIDERS,
  cloudConversationProviderOf,
  cloudPrincipalStanding,
  isResolvedCloudConversationCat,
  resolveCloudConversationCat,
} from '../dist/domains/cats/services/cloud-bridge/cloud-conversation-identity.js';

function configs(entries) {
  return { getAllConfigs: () => Object.fromEntries(entries.map(([catId, provider]) => [catId, { provider }])) };
}

test('the Host table joins the cat provider of the cloud cat to the contract provider', () => {
  assert.deepEqual({ ...CLOUD_CONVERSATION_PROVIDERS }, { 'openai-chatgpt-pro': 'chatgpt' });
  const source = configs([
    ['cloud-alt', 'openai-chatgpt-pro'],
    ['codex', 'openai'],
    ['opus', undefined],
  ]);
  assert.equal(cloudConversationProviderOf(source, 'cloud-alt'), 'chatgpt');
  assert.equal(cloudConversationProviderOf(source, 'codex'), undefined);
  assert.equal(cloudConversationProviderOf(source, 'opus'), undefined);
  assert.equal(cloudConversationProviderOf(source, 'nobody'), undefined);
});

test('one cat resolves, whatever its id', () => {
  const source = configs([
    ['cloud-alt', 'openai-chatgpt-pro'],
    ['codex', 'openai'],
  ]);
  assert.deepEqual(resolveCloudConversationCat(source, 'chatgpt'), { status: 'resolved', catId: 'cloud-alt' });
  assert.equal(isResolvedCloudConversationCat(source, 'cloud-alt'), true);
  assert.equal(isResolvedCloudConversationCat(source, 'gpt-pro'), false, 'no literal cat is special');
  assert.equal(isResolvedCloudConversationCat(source, 'codex'), false);
});

test('no cat means unavailable; two or more is ambiguous, and neither is anyone resolved', () => {
  assert.deepEqual(resolveCloudConversationCat(configs([['codex', 'openai']]), 'chatgpt'), { status: 'unavailable' });

  const two = configs([
    ['gpt-pro', 'openai-chatgpt-pro'],
    ['cloud-alt', 'openai-chatgpt-pro'],
  ]);
  assert.deepEqual(resolveCloudConversationCat(two, 'chatgpt'), {
    status: 'ambiguous',
    catIds: ['cloud-alt', 'gpt-pro'],
  });
  assert.equal(isResolvedCloudConversationCat(two, 'gpt-pro'), false);
  assert.equal(isResolvedCloudConversationCat(two, 'cloud-alt'), false);
});

test('reading the configuration fails closed', () => {
  const broken = {
    getAllConfigs() {
      throw new Error('config unavailable');
    },
  };
  assert.deepEqual(resolveCloudConversationCat(broken, 'chatgpt'), { status: 'unavailable' });
  assert.equal(isResolvedCloudConversationCat(broken, 'gpt-pro'), false);
  assert.equal(cloudConversationProviderOf(broken, 'gpt-pro'), undefined);
});

test('a provider or cat id that only exists on the object prototype names nothing', () => {
  const source = configs([
    ['codex', 'toString'],
    ['opus', 'constructor'],
  ]);
  assert.equal(cloudConversationProviderOf(source, 'codex'), undefined);
  assert.equal(cloudConversationProviderOf(source, 'opus'), undefined);
  assert.equal(cloudConversationProviderOf(source, 'toString'), undefined);
  assert.deepEqual(resolveCloudConversationCat(source, 'chatgpt'), { status: 'unavailable' });
});

test("a principal stands inside the cloud boundary, outside it, or refused — by its key and today's configuration", () => {
  const one = configs([
    ['cloud-alt', 'openai-chatgpt-pro'],
    ['codex', 'openai'],
  ]);
  const key = (catId, scope) => ({ catId, scope });
  assert.equal(cloudPrincipalStanding(one, key('cloud-alt', 'cloud-conversation')), 'cloud');
  assert.equal(
    cloudPrincipalStanding(one, key('cloud-alt', 'user-bound')),
    'refused',
    'only a cloud-scoped key speaks for the cloud cat; it has no ordinary keys either',
  );
  assert.equal(cloudPrincipalStanding(one, key('codex', 'user-bound')), 'ordinary');
  assert.equal(cloudPrincipalStanding(one, key('codex', 'cloud-conversation')), 'refused', 'moved to another provider');
  assert.equal(cloudPrincipalStanding(one, key('gpt-pro', 'cloud-conversation')), 'refused', 'renamed away');
  assert.equal(cloudPrincipalStanding(one, key('gpt-pro', 'user-bound')), 'ordinary', 'an unconfigured ordinary key');

  const two = configs([
    ['cloud-alt', 'openai-chatgpt-pro'],
    ['cloud-beta', 'openai-chatgpt-pro'],
    ['codex', 'openai'],
  ]);
  assert.equal(cloudPrincipalStanding(two, key('cloud-alt', 'cloud-conversation')), 'refused');
  assert.equal(cloudPrincipalStanding(two, key('cloud-beta', 'user-bound')), 'refused', 'ambiguity refuses every key');
  assert.equal(cloudPrincipalStanding(two, key('codex', 'user-bound')), 'ordinary', 'other cats are unaffected');
});
