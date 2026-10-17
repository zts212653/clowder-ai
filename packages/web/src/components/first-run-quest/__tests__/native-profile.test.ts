import { expect, it } from 'vitest';
import { withNativeProfile } from '../native-profile';

it('offers the existing builtin OAuth binding and template defaults on a fresh installation', () => {
  const result = withNativeProfile([], 'openai', true, { defaultModel: 'gpt-test', models: ['gpt-test'] });
  expect(result).toEqual([
    expect.objectContaining({ id: 'codex', authType: 'oauth', models: ['gpt-test'], hasApiKey: false }),
  ]);
});

it('does not synthesize a credential or overwrite an existing account', () => {
  expect(withNativeProfile([], 'openai', false, { models: ['gpt-test'] })).toEqual([]);
  const profile = withNativeProfile([], 'openai', true, { models: ['custom'] })[0];
  expect(withNativeProfile([profile], 'openai', true, { models: ['other'] })).toEqual([profile]);
});
