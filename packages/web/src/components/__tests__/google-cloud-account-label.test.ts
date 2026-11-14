import { describe, expect, it } from 'vitest';
import { accountProvider } from '../accounts/account-directory-view';
import type { ProfileItem } from '../hub-accounts.types';

const google = { id: 'x', name: 'x', displayName: 'x', authType: 'oauth', clientId: 'google', builtin: false } as const;

describe('Google Cloud platform accounts', () => {
  it('are labelled as Vertex on their project, not as the Gemini CLI login', () => {
    const cloud = { ...google, googleCloud: { credential: 'local_adc', projectId: 'household-proj-1' } };
    expect(accountProvider(cloud as unknown as ProfileItem)).toBe('Google Cloud（Vertex AI · household-proj-1）');
    expect(accountProvider(google as unknown as ProfileItem)).toBe('Gemini');
  });
});
