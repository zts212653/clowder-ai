import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyTermDictionary,
  correctTranscription,
  mergeTermEntries,
  refreshSpeechAliases,
  removeFillers,
} from '@/utils/transcription-corrector';

/* ------------------------------------------------------------------ */
/*  applyTermDictionary                                                */
/* ------------------------------------------------------------------ */

describe('applyTermDictionary', () => {
  it('replaces a single known term', () => {
    expect(applyTermDictionary('用 icp 协议')).toBe('用 MCP 协议');
  });

  it('is case-insensitive', () => {
    expect(applyTermDictionary('ICP server')).toBe('MCP server');
    expect(applyTermDictionary('Icp server')).toBe('MCP server');
  });

  it('replaces Chinese misrecognitions', () => {
    expect(applyTermDictionary('法式的很快')).toBe('Fastify很快');
    expect(applyTermDictionary('锐的死连接')).toBe('Redis连接');
    expect(applyTermDictionary('瑞迪斯连接')).toBe('Redis连接');
  });

  it('handles multiple terms in one string', () => {
    const input = '用 icp 和 type script 开发';
    expect(applyTermDictionary(input)).toBe('用 MCP 和 TypeScript 开发');
  });

  it('leaves unknown words unchanged', () => {
    const input = '这是一段正常的文字';
    expect(applyTermDictionary(input)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(applyTermDictionary('')).toBe('');
  });

  it('replaces all original dictionary entries correctly', () => {
    expect(applyTermDictionary('为的')).toBe('void');
    expect(applyTermDictionary('那的js')).toBe('Node.js');
    expect(applyTermDictionary('组单的')).toBe('Zustand');
    expect(applyTermDictionary('威士伯')).toBe('Whisper');
    expect(applyTermDictionary('work tree')).toBe('worktree');
    expect(applyTermDictionary('re base')).toBe('rebase');
  });

  it('corrects cat names (proven misrecognitions)', () => {
    expect(applyTermDictionary('免因猫帮我review')).toBe('缅因猫帮我review');
    expect(applyTermDictionary('面因猫说')).toBe('缅因猫说');
    expect(applyTermDictionary('棉因猫')).toBe('缅因猫');
    expect(applyTermDictionary('绵因猫')).toBe('缅因猫');
    expect(applyTermDictionary('免疫猫')).toBe('缅因猫');
    expect(applyTermDictionary('先罗猫')).toBe('暹罗猫');
    expect(applyTermDictionary('仙罗猫')).toBe('暹罗猫');
    expect(applyTermDictionary('产屎官')).toBe('co-creator');
    expect(applyTermDictionary('铲史官')).toBe('co-creator');
    expect(applyTermDictionary('铲是官')).toBe('co-creator');
    expect(applyTermDictionary('不偶猫很可爱')).toBe('布偶猫很可爱');
  });

  it('preserves literal homophones in ordinary speech', () => {
    expect(applyTermDictionary('线线中间有空隙，我先先停一下。')).toBe('线线中间有空隙，我先先停一下。');
  });

  it('corrects AI model and brand names', () => {
    expect(applyTermDictionary('克劳德很聪明')).toBe('Claude很聪明');
    expect(applyTermDictionary('科德斯 review')).toBe('Codex review');
    expect(applyTermDictionary('奥普斯模型')).toBe('Opus模型');
    expect(applyTermDictionary('杰米尼')).toBe('Gemini');
    expect(applyTermDictionary('桑奈特')).toBe('Sonnet');
    expect(applyTermDictionary('海酷')).toBe('Haiku');
    expect(applyTermDictionary('安索皮克')).toBe('Anthropic');
  });

  it('corrects framework and tool names', () => {
    expect(applyTermDictionary('泰尔温样式')).toBe('Tailwind样式');
    expect(applyTermDictionary('优维康服务')).toBe('uvicorn服务');
    expect(applyTermDictionary('fast api接口')).toBe('FastAPI接口');
    expect(applyTermDictionary('web socket连接')).toBe('WebSocket连接');
    expect(applyTermDictionary('亨德赛特记忆')).toBe('Hindsight记忆');
  });
});

/* ------------------------------------------------------------------ */
/*  removeFillers                                                      */
/* ------------------------------------------------------------------ */

describe('removeFillers', () => {
  it('removes a single filler word', () => {
    expect(removeFillers('嗯我想问一下')).toBe('我想问一下');
  });

  it('removes filler at end of string', () => {
    expect(removeFillers('看看这个啊')).toBe('看看这个');
  });

  it('removes filler between words', () => {
    expect(removeFillers('先那个看一下代码')).toBe('先 看一下代码');
  });

  it('removes multiple different fillers', () => {
    expect(removeFillers('嗯那个就是说帮我看看')).toBe('帮我看看');
  });

  it('removes consecutive identical fillers', () => {
    expect(removeFillers('嗯嗯嗯开始吧')).toBe('开始吧');
  });

  it('collapses resulting whitespace', () => {
    expect(removeFillers('先  嗯  看看')).toBe('先 看看');
  });

  it('preserves content without fillers', () => {
    const clean = '请帮我 review 这段代码';
    expect(removeFillers(clean)).toBe(clean);
  });

  it('returns empty string unchanged', () => {
    expect(removeFillers('')).toBe('');
  });

  it('handles string that is only fillers', () => {
    expect(removeFillers('嗯啊那个')).toBe('');
  });

  it('removes longer fillers before shorter ones', () => {
    // "就是说" should be removed as a whole, not leave "说"
    expect(removeFillers('就是说我觉得')).toBe('我觉得');
    // "就是" within "就是说" should already be consumed
    expect(removeFillers('就是我觉得')).toBe('我觉得');
  });

  it('removes 然后呢 and 对对对', () => {
    expect(removeFillers('然后呢我们继续')).toBe('我们继续');
    expect(removeFillers('对对对没错')).toBe('没错');
  });
});

/* ------------------------------------------------------------------ */
/*  correctTranscription (full pipeline)                               */
/* ------------------------------------------------------------------ */

describe('correctTranscription', () => {
  beforeEach(() => {
    refreshSpeechAliases([{ mentionPatterns: ['@砚砚', '@宪宪'] }]);
  });

  it('applies both term replacement and filler removal', () => {
    const input = '嗯那个用 icp 和 type script 开发';
    expect(correctTranscription(input)).toBe('用 MCP 和 TypeScript 开发');
  });

  it('handles term replacement that would overlap fillers', () => {
    // Term replacement happens first, so fillers in the result
    // of replacement do not cause issues
    const input = '法式的很快啊';
    expect(correctTranscription(input)).toBe('Fastify很快');
  });

  it('returns empty string unchanged', () => {
    expect(correctTranscription('')).toBe('');
  });

  it('handles input with only fillers', () => {
    expect(correctTranscription('嗯啊那个就是')).toBe('');
  });

  it('handles realistic voice input', () => {
    const input = '嗯那个帮我看看 icp 的 work tree 配置啊就是 锐的死 连接有问题';
    const expected = '帮我看看 MCP 的 worktree 配置 Redis 连接有问题';
    expect(correctTranscription(input)).toBe(expected);
  });

  it('handles realistic voice input with cat names', () => {
    const input = '嗯让免因猫帮我 review 一下那个克劳德的 web socket 代码';
    const expected = '让缅因猫帮我 review 一下 Claude的 WebSocket 代码';
    expect(correctTranscription(input)).toBe(expected);
  });

  it.each([
    '这个汤咸咸的，味道不错。',
    '把盒子包得严严实实。',
    '他险险逃过一劫，我闲闲地坐了一会儿。',
    '我同事叫艳艳，燕燕下周也要来。',
    '线线中间有空隙，我先先停一下。',
    '宪宪，你看这两条线线。砚砚，帮我包严严实实。',
  ])('preserves ordinary words and names once transcribed: %s', (input) => {
    expect(correctTranscription(input)).toBe(input);
    expect(correctTranscription(input, mergeTermEntries([{ from: 'git hub', to: 'GitHub' }]))).toBe(input);
  });

  it('corrects nickname homophones only in explicit spoken mentions', () => {
    expect(correctTranscription('at 咸咸 review 和 艾特 严严 出来')).toBe('@宪宪 review 和 @砚砚 出来');
    expect(correctTranscription('at 严严实实')).toBe('at 严严实实');
  });

  it.each([
    ['先先', '宪宪'],
    ['献献', '宪宪'],
    ['嫌嫌', '宪宪'],
    ['咸咸', '宪宪'],
    ['现现', '宪宪'],
    ['弦弦', '宪宪'],
    ['险险', '宪宪'],
    ['闲闲', '宪宪'],
    ['严严', '砚砚'],
    ['言言', '砚砚'],
    ['烟烟', '砚砚'],
    ['眼眼', '砚砚'],
    ['艳艳', '砚砚'],
    ['雁雁', '砚砚'],
    ['燕燕', '砚砚'],
    ['研研', '砚砚'],
    ['岩岩', '砚砚'],
  ])('recognizes the old spelling %s when used to mention %s', (spelling, nickname) => {
    expect(correctTranscription(`艾特 ${spelling}，帮我看看`)).toBe(`@${nickname}，帮我看看`);
  });

  it('requires a registered target to repair a spoken nickname', () => {
    refreshSpeechAliases([]);
    expect(correctTranscription('艾特 先先，帮我看看')).toBe('艾特 先先，帮我看看');
  });

  it('keeps an exact registered alias ahead of a nickname homophone', () => {
    refreshSpeechAliases([{ mentionPatterns: ['@宪宪', '@咸咸'] }]);
    expect(correctTranscription('at 咸咸 出来')).toBe('@咸咸 出来');
  });

  it('normalizes speech-style at-mentions for cat nicknames', () => {
    const input = 'at咱的砚砚 和 at 宪宪 你们出来了';
    const expected = '@砚砚 和 @宪宪 你们出来了';
    expect(correctTranscription(input)).toBe(expected);
  });

  it('normalizes @。 + nickname style mentions', () => {
    const input = '@。砚砚 先看这个';
    const expected = '@砚砚 先看这个';
    expect(correctTranscription(input)).toBe(expected);
  });
});
