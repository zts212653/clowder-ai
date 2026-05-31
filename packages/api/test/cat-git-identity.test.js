import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveCatGitAuthorName, buildCatGitIdentityEnv, prettifyModel } = await import(
  '../dist/config/cat-git-identity.js'
);

describe('prettifyModel', () => {
  it('compacts Claude model strings (drops vendor prefix, dash→dot version)', () => {
    assert.equal(prettifyModel('claude-opus-4-8'), 'Opus-4.8');
    assert.equal(prettifyModel('claude-sonnet-4-6'), 'Sonnet-4.6');
  });

  it('drops the YYYYMMDD date suffix', () => {
    assert.equal(prettifyModel('claude-opus-4-5-20251101'), 'Opus-4.5');
  });

  it('upper-cases known acronym families', () => {
    assert.equal(prettifyModel('gpt-5.4'), 'GPT-5.4');
    assert.equal(prettifyModel('gpt-5.3-codex'), 'GPT-5.3-codex');
    assert.equal(prettifyModel('z-ai/glm-4.7'), 'GLM-4.7');
  });

  it('strips provider/namespace path prefixes', () => {
    assert.equal(prettifyModel('anthropic/claude-opus-4-6'), 'Opus-4.6');
  });

  it('title-cases other families and keeps trailing tags', () => {
    assert.equal(prettifyModel('gemini-3.1-pro-preview'), 'Gemini-3.1-pro-preview');
  });
});

describe('resolveCatGitAuthorName', () => {
  it('combines English breed (PascalCase) with the REAL model from getCatModel', () => {
    // model arg is what getCatModel(catId) returns at runtime — NOT the catId, NOT a stale catalog copy
    assert.equal(resolveCatGitAuthorName('opus-45', 'ragdoll', 'claude-opus-4-8'), 'Ragdoll-Opus-4.8');
    assert.equal(resolveCatGitAuthorName('sonnet', 'ragdoll', 'claude-sonnet-4-6'), 'Ragdoll-Sonnet-4.6');
  });

  it('PascalCases kebab-case multi-word breeds', () => {
    assert.equal(resolveCatGitAuthorName('gpt52', 'maine-coon', 'gpt-5.4'), 'MaineCoon-GPT-5.4');
    assert.equal(
      resolveCatGitAuthorName('opencode', 'golden-chinchilla', 'anthropic/claude-opus-4-6'),
      'GoldenChinchilla-Opus-4.6',
    );
    assert.equal(resolveCatGitAuthorName('dare', 'dragon-li', 'z-ai/glm-4.7'), 'DragonLi-GLM-4.7');
  });

  it('overrides the opus-47 dirty family (catalog family === own catId) back to Ragdoll', () => {
    assert.equal(resolveCatGitAuthorName('opus-47', 'opus-47', 'claude-opus-4-7'), 'Ragdoll-Opus-4.7');
  });

  it('falls back to the catId when model is missing (still prefixed by breed)', () => {
    assert.equal(resolveCatGitAuthorName('opus-45', 'ragdoll', undefined), 'Ragdoll-opus-45');
    assert.equal(resolveCatGitAuthorName('opus-45', 'ragdoll', ''), 'Ragdoll-opus-45');
  });

  it('returns the model alone when breed is unknown', () => {
    assert.equal(resolveCatGitAuthorName('mystery', undefined, 'gpt-5.4'), 'GPT-5.4');
  });

  it('sanitizes characters that would corrupt a git author name', () => {
    // < > break the "Name <email>" author format; \n breaks the commit header line
    assert.equal(resolveCatGitAuthorName('ev<il>\n', undefined, undefined), 'evil');
  });

  it('preserves valid git-author chars incl. model tags like [1m] and the dash separator (砚砚 P2)', () => {
    // git author names legally hold [ ] and - ; must NOT mangle claude-opus-4-6[1m] → 4.61m
    assert.equal(resolveCatGitAuthorName('opus-45', 'ragdoll', 'claude-opus-4-6[1m]'), 'Ragdoll-Opus-4.6[1m]');
  });

  it('de-dups provider-named breeds against the model label (砚砚 P1, runtime roster)', () => {
    // runtime roster has provider-named breeds that are NOT cat-breed slugs; drop the
    // redundant prefix instead of "Qwen-Qwen..." / "Deepseek-Deepseek..."
    assert.equal(resolveCatGitAuthorName('qwen', 'qwen', 'qwen3.6-max-preview'), 'Qwen3.6-max-preview');
    assert.equal(resolveCatGitAuthorName('deepseek', 'deepseek', 'deepseek-v4-pro'), 'Deepseek-v4-pro');
    // a provider breed that does NOT collide with the model family stays as a prefix
    assert.equal(resolveCatGitAuthorName('kimi', 'moonshot', 'kimi-k2.6'), 'Moonshot-Kimi-k2.6');
    assert.equal(resolveCatGitAuthorName('opencode-china', 'opencode-china', 'glm-5.1'), 'OpencodeChina-GLM-5.1');
  });
});

describe('buildCatGitIdentityEnv', () => {
  it('sets GIT_AUTHOR_NAME and GIT_COMMITTER_NAME to the resolved per-cat name', () => {
    const env = buildCatGitIdentityEnv('opus-45', 'ragdoll', 'claude-opus-4-8');
    assert.deepEqual(env, {
      GIT_AUTHOR_NAME: 'Ragdoll-Opus-4.8',
      GIT_COMMITTER_NAME: 'Ragdoll-Opus-4.8',
    });
  });

  it('does NOT set any email var — email is inherited from git config (zts212653) by design', () => {
    const env = buildCatGitIdentityEnv('gpt52', 'maine-coon', 'gpt-5.4');
    assert.equal('GIT_AUTHOR_EMAIL' in env, false);
    assert.equal('GIT_COMMITTER_EMAIL' in env, false);
  });
});
