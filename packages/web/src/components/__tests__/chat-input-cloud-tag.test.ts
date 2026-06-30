/**
 * F247 Phase C: AC-C-4 — cloud cat tag in @ mention picker.
 * Tests that buildCatOptions correctly identifies cloud cats and populates
 * the providerLabel + isCloud fields used by ChatInputMenus to render
 * the "☁️ via ChatGPT Pro" badge.
 */
import { describe, expect, it } from 'vitest';
import { buildCatOptions } from '@/components/chat-input-options';
import type { CatData } from '@/hooks/useCatData';

/** Local cat (has cli config, local provider) — should NOT be cloud */
const LOCAL_CAT: CatData = {
  id: 'opus',
  displayName: '布偶猫',
  color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
  mentionPatterns: ['opus', '布偶猫'],
  clientId: 'anthropic',
  defaultModel: 'claude-opus-4-6',
  avatar: '/avatars/opus.png',
  roleDescription: '主架构师',
  personality: 'thoughtful',
  cli: { command: 'claude', outputFormat: 'stream-json' },
};

/** Cloud cat (provider=openai-chatgpt-pro, no cli) — should be cloud */
const CLOUD_CAT: CatData = {
  id: 'gpt-pro',
  displayName: '缅因猫Pro',
  variantLabel: 'Pro Cloud (ChatGPT)',
  color: { primary: '#2196F3', secondary: '#90CAF9' },
  mentionPatterns: ['gpt-pro', '砚砚pro'],
  clientId: 'openai',
  defaultModel: 'gpt-pro',
  avatar: '/avatars/gpt-pro.png',
  roleDescription: '云端 ChatGPT Pro',
  personality: 'cloud reasoning',
  provider: 'openai-chatgpt-pro',
  // no cli field — cloud-only
};

describe('AC-C-4: cloud cat tag in @ mention picker', () => {
  it('marks cloud cat with isCloud=true and populates providerLabel', () => {
    const options = buildCatOptions([CLOUD_CAT]);
    const cloudOpt = options.find((o) => o.id === 'gpt-pro');
    expect(cloudOpt).toBeDefined();
    expect(cloudOpt?.isCloud).toBe(true);
    expect(cloudOpt?.providerLabel).toBe('via ChatGPT Pro');
  });

  it('does NOT mark local cat as cloud', () => {
    const options = buildCatOptions([LOCAL_CAT]);
    const localOpt = options.find((o) => o.id === 'opus');
    expect(localOpt).toBeDefined();
    expect(localOpt?.isCloud).toBeFalsy();
    expect(localOpt?.providerLabel).toBeFalsy();
  });

  it('mixed list: only cloud cat gets cloud tag', () => {
    const options = buildCatOptions([LOCAL_CAT, CLOUD_CAT]);
    const individuals = options.filter((o) => !o.isGroup);
    expect(individuals).toHaveLength(2);

    const local = individuals.find((o) => o.id === 'opus');
    const cloud = individuals.find((o) => o.id === 'gpt-pro');

    expect(local?.isCloud).toBeFalsy();
    expect(cloud?.isCloud).toBe(true);
    expect(cloud?.providerLabel).toBe('via ChatGPT Pro');
  });

  it('cloud cat label includes variant in @ format', () => {
    const options = buildCatOptions([CLOUD_CAT]);
    const cloudOpt = options.find((o) => o.id === 'gpt-pro');
    expect(cloudOpt?.label).toBe('@缅因猫Pro (Pro Cloud (ChatGPT))');
  });
});
