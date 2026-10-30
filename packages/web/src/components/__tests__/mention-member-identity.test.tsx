import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { refreshCoCreatorMentionData, refreshMentionData, resetMentionDataForTest } from '@/lib/mention-highlight';
import { resolveSender } from '@/lib/resolve-sender';
import { buildCatOptions } from '../chat-input-options';
import { buildComposerRecipientIdentities } from '../composer-routing-presentation';
import { MarkdownContent } from '../MarkdownContent';

const whale: CatData = {
  id: 'dsh',
  displayName: '小鲸鱼',
  nickname: '鲸鲸',
  mentionPatterns: ['@dsh'],
  clientId: 'dsh',
  carrier: 'cli',
  defaultModel: 'fixture',
  color: { primary: '#334455', secondary: '#ddeeff' },
  avatar: '',
  roleDescription: '',
  personality: '',
};

describe('member identity across mention and reply surfaces', () => {
  beforeEach(resetMentionDataForTest);

  it('uses the same name and nickname in the menu, insertion, sent prose and reply header', () => {
    const option = buildCatOptions([whale]).find((cat) => cat.id === 'dsh');
    expect(option?.label).toBe('@小鲸鱼 · 鲸鲸');
    expect(option?.insert).toBe('@小鲸鱼 · 鲸鲸 ');
    expect(buildComposerRecipientIdentities([whale]).get('dsh')).toEqual({
      label: '小鲸鱼 · 鲸鲸',
      insert: '@小鲸鱼 · 鲸鲸 ',
    });
    refreshMentionData([whale]);
    const history = '@dsh 请看一下';
    const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: history }));
    expect(html).toContain('@小鲸鱼 · 鲸鲸');
    expect(html).not.toContain('>@dsh<');
    expect(history).toBe('@dsh 请看一下');
    expect(resolveSender('dsh', () => whale, { name: '用户', aliases: [], mentionPatterns: [] }).label).toBe(
      '小鲸鱼 · 鲸鲸',
    );
  });

  it.each(['', '   ', '小鲸鱼', ' 小鲸鱼 '])('deduplicates empty or repeated nickname %j', (nickname) => {
    expect(formatCatDisplayName({ ...whale, nickname })).toBe('小鲸鱼');
  });

  it('falls back to a unique registered handle when two members have the same visible identity', () => {
    const other = { ...whale, id: 'dsh-two', mentionPatterns: ['@dsh-two'] };
    expect(
      buildCatOptions([whale, other])
        .filter((cat) => !cat.isGroup)
        .map((cat) => cat.insert),
    ).toEqual(['@dsh ', '@dsh-two ']);
  });

  it('does not steal an existing registered alias or a stable id from another member', () => {
    const other = { ...whale, id: 'other', displayName: '别的猫', nickname: '', mentionPatterns: ['@小鲸鱼 · 鲸鲸'] };
    const options = buildCatOptions([whale, other]);
    expect(options.find((cat) => cat.id === 'dsh')?.insert).toBe('@dsh ');
    const prefixOwner = { ...other, mentionPatterns: ['@小鲸鱼'] };
    expect(buildCatOptions([whale, prefixOwner]).find((cat) => cat.id === 'dsh')?.insert).toBe('@dsh ');
    const namedLikeId = { ...other, displayName: 'dsh', mentionPatterns: ['@other'] };
    expect(buildCatOptions([whale, namedLikeId]).find((cat) => cat.id === 'other')?.insert).toBe('@other ');
  });

  it('keeps unavailable members in collision checks without making them selectable', () => {
    const other = {
      ...whale,
      id: 'other',
      mentionPatterns: ['@other'],
      roster: { family: 'fixture', roles: [], lead: false, available: false, evaluation: '' },
    };
    expect(
      buildCatOptions([whale, other])
        .filter((cat) => !cat.isGroup)
        .map((cat) => cat.insert),
    ).toEqual(['@dsh ']);
    refreshMentionData([whale, other]);
    const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: '@小鲸鱼 · 鲸鲸 @dsh' }));
    expect((html.match(/<button /g) ?? []).length).toBe(1);
  });

  it('preserves configurable human aliases in both mention insertion and display', () => {
    const cat = { ...whale, displayName: 'Felix', nickname: '' };
    refreshCoCreatorMentionData(['@Felix']);
    refreshMentionData([cat]);
    expect(buildCatOptions([cat]).find((option) => option.id === 'dsh')?.insert).toBe('@dsh ');
    expect(buildComposerRecipientIdentities([cat]).get('dsh')?.insert).toBe('@dsh ');
    const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: '@Felix 请看' }));
    expect(html).toContain('color:#F5A623');
  });
});
