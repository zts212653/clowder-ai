import { describe, expect, it } from 'vitest';
import { canonicalizeCommunitySubjectKey, issueSubjectKey, prSubjectKey } from '../utils/subject-key.js';

describe('community subject key canonicalization', () => {
  it('normalizes GitHub repository casing for durable PR and issue identities', () => {
    expect(prSubjectKey('Owner/Repo', 12)).toBe('pr:owner/repo#12');
    expect(issueSubjectKey('Owner/Repo', 34)).toBe('issue:owner/repo#34');
    expect(canonicalizeCommunitySubjectKey('PR:Owner/Repo#12')).toBe('pr:owner/repo#12');
  });

  it('does not rewrite non-GitHub subject namespaces', () => {
    expect(canonicalizeCommunitySubjectKey('thread:Thread_MixedCase')).toBe('thread:Thread_MixedCase');
  });
});
