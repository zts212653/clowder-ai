'use client';

import type { ConnectorSource } from '@cat-cafe/shared';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import type { RichBlock, RichInteractiveBlock } from '@/stores/chat-types';
import type { CardConfirmationEntry } from './CardBlock';
import { useFrustrationVisibility, visibleFrustrationBlocks } from './frustration-visibility';
import { InteractiveBlockGroup } from './InteractiveBlockGroup';
import { ReadOnlyRichBlockRenderer, RichBlockRenderer } from './RichBlockContent';
import { RichBlockSelectionFrame } from './RichBlockSelectionFrame';
import type { RuntimeConversationBinding } from './runtime-conversation-model';

type BlockItem = { type: 'block'; block: RichBlock };
type GroupedItem = { type: 'group'; groupId: string; blocks: RichInteractiveBlock[] };
type WorkCardsItem = { type: 'works'; blocks: RichBlock[] };
type ResultItem = BlockItem | GroupedItem;

/** Adjacent work cards share a grid without changing selection coordinates or source order. */
function groupWorkCards(items: ResultItem[]): (ResultItem | WorkCardsItem)[] {
  const result: (ResultItem | WorkCardsItem)[] = [];
  for (const item of items) {
    const work =
      item.type === 'block' &&
      (item.block.kind === 'file' || (item.block.kind === 'card' && item.block.meta?.kind === 'work_reference'));
    if (!work || item.type !== 'block') {
      result.push(item);
      continue;
    }
    const last = result.at(-1);
    if (last?.type === 'works') last.blocks.push(item.block);
    else result.push({ type: 'works', blocks: [item.block] });
  }
  return result;
}

/** Render decisions belong to local envelopes, never extra fields on source blocks. */
function blockItem(block: RichBlock): BlockItem {
  return { type: 'block', block };
}

/** Find runs of consecutive ungrouped interactive blocks (no non-interactive gaps) */
function findConsecutiveRuns(blocks: RichBlock[]): RichInteractiveBlock[][] {
  const runs: RichInteractiveBlock[][] = [];
  let current: RichInteractiveBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'interactive' && !block.groupId && block.autoGroup !== false) {
      current.push(block);
    } else {
      if (current.length > 0) {
        runs.push(current);
        current = [];
      }
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Phase C: collect interactive blocks into groups by groupId.
 *  Auto-groups: consecutive ungrouped blocks (2+)
 *  are batched at the first block's position. Non-consecutive blocks stay solo. */
function groupBlocks(blocks: RichBlock[]): ResultItem[] {
  const result: ResultItem[] = [];
  const groupMap = new Map<string, RichInteractiveBlock[]>();
  const groupFirstIdx = new Map<string, number>();

  // Find which ungrouped blocks should be auto-grouped (consecutive runs of 2+)
  const autoGroupIds = new Set<string>();
  const blockToGroup = new Map<string, string>(); // blockId → syntheticGroupId
  const syntheticGroups = new Map<string, RichInteractiveBlock[]>();

  for (const run of findConsecutiveRuns(blocks)) {
    if (run.length >= 2) {
      const gid = `__auto_${run[0]?.id}`;
      syntheticGroups.set(gid, run);
      for (const b of run) {
        autoGroupIds.add(b.id);
        blockToGroup.set(b.id, gid);
      }
    }
  }

  // Pass 1: collect explicit groups
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === 'interactive' && block.groupId) {
      if (!groupMap.has(block.groupId)) {
        groupMap.set(block.groupId, []);
        groupFirstIdx.set(block.groupId, i);
      }
      groupMap.get(block.groupId)?.push(block);
    }
  }

  // Pass 2: build result in original order
  const emittedGroups = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind === 'interactive' && block.groupId) {
      const gid = block.groupId;
      if (groupFirstIdx.get(gid) === i) {
        result.push({ type: 'group', groupId: gid, blocks: groupMap.get(gid)! });
      }
    } else if (block.kind === 'interactive' && autoGroupIds.has(block.id)) {
      const gid = blockToGroup.get(block.id)!;
      if (!emittedGroups.has(gid)) {
        result.push({ type: 'group', groupId: gid, blocks: syntheticGroups.get(gid)! });
        emittedGroups.add(gid);
      }
    } else {
      result.push(blockItem(block));
    }
  }
  return result;
}

export function RichBlocks({
  blocks,
  publication,
  catId,
  messageId,
  sourceThreadId,
  sourceMessageIds,
  messageSource,
  confirmations,
  sendContext,
  htmlWidgetDisclosureKeys,
  runtimeInteractionCard,
  readOnly = false,
}: {
  blocks: RichBlock[];
  publication?: PublishedMessageCoordinate;
  catId?: string;
  messageId?: string;
  sourceThreadId?: string;
  sourceMessageIds?: readonly string[];
  /**
   * F174 D2b-1 cloud P2 #1397: trusted-provenance gate for sub-renderers.
   * The callback-auth-failure renderer requires `messageSource.connector ===
   * 'callback-auth'` so a regular card with spoofed `meta.kind` can't pose
   * as a system warning + trigger hide-similar. Other renderers ignore this.
   */
  messageSource?: ConnectorSource;
  confirmations?: CardConfirmationEntry[];
  /** F229 Bug 2 fix: context tag for interactive-send events (e.g. 'concierge').
   *  Prevents InteractiveBlock events from leaking to the wrong thread's handler. */
  sendContext?: string;
  htmlWidgetDisclosureKeys?: Readonly<Record<string, string>>;
  runtimeInteractionCard?: RuntimeConversationBinding;
  /** Forwarded blocks are inert evidence: no callbacks, specialised actions, or HTML execution. */
  readOnly?: boolean;
}) {
  const visibility = useFrustrationVisibility(blocks, readOnly ? undefined : messageSource?.connector);
  const shownBlocks = readOnly ? blocks : visibleFrustrationBlocks(visibility);
  if (shownBlocks.length === 0) return null;
  const items =
    readOnly || runtimeInteractionCard ? shownBlocks.map(blockItem) : groupWorkCards(groupBlocks(shownBlocks));
  const renderBlock = (block: RichBlock) => (
    <RichBlockSelectionFrame
      key={block.id}
      block={block}
      index={shownBlocks.indexOf(block)}
      messageId={messageId}
      readOnly={readOnly}
    >
      {readOnly ? (
        <ReadOnlyRichBlockRenderer block={block} />
      ) : (
        <RichBlockRenderer
          block={block}
          publication={publication}
          catId={catId}
          messageId={messageId}
          sourceThreadId={sourceThreadId}
          sourceMessageIds={sourceMessageIds}
          messageSource={messageSource}
          confirmations={confirmations}
          sendContext={sendContext}
          runtimeInteractionCard={runtimeInteractionCard}
          htmlWidgetDisclosureKeys={htmlWidgetDisclosureKeys}
        />
      )}
    </RichBlockSelectionFrame>
  );
  return (
    <div className="mt-2 space-y-2">
      {items.map((item) =>
        item.type === 'group' ? (
          <div key={item.groupId} data-rich-block-group-id={item.groupId} className="group/rich-block relative">
            <InteractiveBlockGroup blocks={item.blocks} messageId={messageId} sendContext={sendContext} />
          </div>
        ) : item.type === 'works' ? (
          <div key={`works-${item.blocks[0]?.id}`} className="chat-work-gallery">
            <div className="chat-work-grid">{item.blocks.map(renderBlock)}</div>
          </div>
        ) : (
          renderBlock(item.block)
        ),
      )}
    </div>
  );
}
