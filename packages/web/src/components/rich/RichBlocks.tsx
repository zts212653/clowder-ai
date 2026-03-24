'use client';

import type { RichBlock, RichInteractiveBlock } from '@/stores/chat-types';
import { AudioBlock } from './AudioBlock';
import { CardBlock } from './CardBlock';
import { ChecklistBlock } from './ChecklistBlock';
import { DiffBlock } from './DiffBlock';
import { FileBlock } from './FileBlock';
import { HtmlWidgetBlock } from './HtmlWidgetBlock';
import { InteractiveBlock } from './InteractiveBlock';
import { InteractiveBlockGroup } from './InteractiveBlockGroup';
import { MediaGalleryBlock } from './MediaGalleryBlock';

function RichBlockRenderer({ block, catId, messageId }: { block: RichBlock; catId?: string; messageId?: string }) {
  switch (block.kind) {
    case 'card':
      return <CardBlock block={block} messageId={messageId} />;
    case 'diff':
      return <DiffBlock block={block} />;
    case 'checklist':
      return <ChecklistBlock block={block} />;
    case 'media_gallery':
      return <MediaGalleryBlock block={block} />;
    case 'audio':
      return <AudioBlock block={block} catId={catId} />;
    case 'interactive':
      return <InteractiveBlock block={block} messageId={messageId} />;
    case 'html_widget':
      return <HtmlWidgetBlock block={block} />;
    case 'file':
      return <FileBlock block={block} />;
    default:
      return (
        <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-400">
          未知富块类型: {(block as { kind: string }).kind}
        </div>
      );
  }
}

type GroupedItem = { grouped: true; groupId: string; blocks: RichInteractiveBlock[] };
type ResultItem = RichBlock | GroupedItem;

/** Find runs of consecutive ungrouped interactive blocks (no non-interactive gaps) */
function findConsecutiveRuns(blocks: RichBlock[]): RichInteractiveBlock[][] {
  const runs: RichInteractiveBlock[][] = [];
  let current: RichInteractiveBlock[] = [];
  for (const block of blocks) {
    if (block.kind === 'interactive' && !block.groupId) {
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
        result.push({ grouped: true, groupId: gid, blocks: groupMap.get(gid)! });
      }
    } else if (block.kind === 'interactive' && autoGroupIds.has(block.id)) {
      const gid = blockToGroup.get(block.id)!;
      if (!emittedGroups.has(gid)) {
        result.push({ grouped: true, groupId: gid, blocks: syntheticGroups.get(gid)! });
        emittedGroups.add(gid);
      }
    } else {
      result.push(block);
    }
  }
  return result;
}

export function RichBlocks({ blocks, catId, messageId }: { blocks: RichBlock[]; catId?: string; messageId?: string }) {
  if (blocks.length === 0) return null;
  const items = groupBlocks(blocks);
  return (
    <div className="mt-2 space-y-2">
      {items.map((item) =>
        'grouped' in item ? (
          <InteractiveBlockGroup key={item.groupId} blocks={item.blocks} messageId={messageId} />
        ) : (
          <RichBlockRenderer key={item.id} block={item} catId={catId} messageId={messageId} />
        ),
      )}
    </div>
  );
}
