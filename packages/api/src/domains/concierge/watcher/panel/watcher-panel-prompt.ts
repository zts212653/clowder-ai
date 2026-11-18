import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry, type WatcherPanelRound } from '@cat-cafe/shared';
import type { WatcherPanelContextWindow } from './watcher-panel-context.js';

/**
 * The instruction every member reads, word for word. It is owned and frozen by the watcher thread in this
 * document; the code only reads its 「## 正文」 text block and records a digest per round.
 */
export const WATCHER_PANEL_INSTRUCTION_PATH =
  'docs/discussions/2026-11-16-watcher-usefulness-experiment/watcher-instruction.md';

export interface WatcherPanelGuidance {
  text: string;
  digest: string;
}

function findInstruction(): string | undefined {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(directory, WATCHER_PANEL_INSTRUCTION_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

/** The first ```text block under 「## 正文」; anything else in the document is commentary. */
export function extractWatcherPanelInstruction(markdown: string): string {
  const heading = markdown.search(/^## 正文\s*$/mu);
  if (heading < 0) throw new Error('watcher_panel_instruction_body_missing');
  const block = /^```text\n([\s\S]*?)\n```/mu.exec(markdown.slice(heading));
  const text = block?.[1]?.trim();
  if (!text) throw new Error('watcher_panel_instruction_body_missing');
  return text;
}

export function loadWatcherPanelGuidance(path = findInstruction()): WatcherPanelGuidance {
  if (!path) throw new Error('watcher_panel_instruction_unavailable');
  const text = extractWatcherPanelInstruction(readFileSync(path, 'utf8'));
  return { text, digest: `sha256:${createHash('sha256').update(text).digest('hex')}` };
}

export function watcherPanelCatName(catId: string): string {
  const config = catRegistry.tryGet(catId)?.config;
  return config?.nickname ?? config?.displayName ?? catId;
}

const QUIET_REASON: Record<NonNullable<WatcherPanelRound['quiet']>, string> = {
  paused: '这条线程的守望暂停中，这一轮只看，递不了话，也不提议',
  label_muted: '这条线程打了免打扰标签，这一轮只看，递不了话，也不提议',
  woken_by_watcher: '刚结束的这一轮是被守望猫的话叫起来的，这一轮只看，递不了话，也不提议',
};

/** The instruction verbatim, then this round's facts and material. */
export function watcherPanelPrompt(input: {
  threadId: string;
  threadTitle?: string;
  workerCatId: string;
  cutoffMessageId: string;
  cutoffAt: number;
  context: WatcherPanelContextWindow;
  quiet?: WatcherPanelRound['quiet'];
  guidance: WatcherPanelGuidance;
}): string {
  const window =
    input.context.mode === 'hot'
      ? `下面是你上次看到的截止时刻之后、到这一轮截止为止的新原话，另补了这段时间里结束、但开始得更早的回复${input.context.truncated ? '；太长了，只放了最近的部分，前面的自己往前翻' : ''}。`
      : `下面是截止时刻之前最近的 ${input.context.messageCount} 条原话${input.context.truncated ? '；更早的没放进来，需要时自己往前翻' : '，已是这条线程的全部'}。`;
  return `<守望猫说明>
${input.guidance.text}
</守望猫说明>

<这一轮>
线程：「${input.threadTitle ?? '未命名'}」（threadId=${input.threadId}）。
刚结束一轮工作的是 ${watcherPanelCatName(input.workerCatId)}（@${input.workerCatId}），它这一轮的回复是 messageId=${input.cutoffMessageId}。
这一轮截止在它结束的时刻 ${new Date(input.cutoffAt).toISOString()}。这之后出现的消息不算这一轮的材料，别往后读。${input.quiet ? `\n${QUIET_REASON[input.quiet]}。` : ''}
往前翻：cat_cafe_get_thread_context(threadId="${input.threadId}", messageId=<最早一条的 messageId>, before=50, after=0)。
</这一轮>

<线程原话 mode="${input.context.mode}">
${window}
${input.context.body}
</线程原话>`;
}
