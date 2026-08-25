'use client';

import { type ConnectorSource, isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';
import { useState } from 'react';
import { TransferTargetPicker } from '@/components/TransferTargetPicker';
import type { RichBlock, RichInteractiveBlock } from '@/stores/chat-types';
import { AudioBlock } from './AudioBlock';
import { CallbackAuthFailureBlock } from './CallbackAuthFailureBlock';
import { CardBlock, type CardConfirmationEntry } from './CardBlock';
import { ChecklistBlock } from './ChecklistBlock';
import { CommunityIssueDraftCard, isCommunityIssueDraftBlock } from './CommunityIssueDraftCard';
import { CommunityIssuePreviewCard, isCommunityIssuePreviewBlock } from './CommunityIssuePreviewCard';
import { DiffBlock } from './DiffBlock';
import { FileBlock } from './FileBlock';
import { FrustrationIssueCard, isFrustrationIssueCardBlock } from './FrustrationIssueCard';
import { HandoffProposalCard, isHandoffProposalCardBlock } from './HandoffProposalCard';
import { HtmlWidgetBlock } from './HtmlWidgetBlock';
import { InteractiveBlock } from './InteractiveBlock';
import { InteractiveBlockGroup } from './InteractiveBlockGroup';
import { MediaGalleryBlock } from './MediaGalleryBlock';
import { PersonMemoryProposalCard } from './PersonMemoryProposalCard';
import { isProposalCardBlock, ProposalCard } from './ProposalCard';
import { RichBlockForwardButton } from './RichBlockForwardButton';
import { isScheduleMutationProposalCardBlock, ScheduleMutationProposalCard } from './ScheduleMutationProposalCard';

const RICH_BLOCK_OVERLAY_ACTIONS_CLASS =
  'pointer-events-none absolute right-2 top-2 z-20 flex translate-y-1 gap-0.5 rounded-lg border border-cafe bg-cafe-surface/90 p-0.5 opacity-0 shadow-sm backdrop-blur-sm transition-[opacity,transform] duration-150 group-hover/rich-block:pointer-events-auto group-hover/rich-block:translate-y-0 group-hover/rich-block:opacity-100 group-focus-within/rich-block:pointer-events-auto group-focus-within/rich-block:translate-y-0 group-focus-within/rich-block:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(hover:none)_and_(pointer:coarse)]:translate-y-0 [@media(hover:none)_and_(pointer:coarse)]:opacity-100';

const RICH_BLOCK_FLOW_ACTIONS_CLASS =
  'pointer-events-none grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] duration-150 group-hover/rich-block:pointer-events-auto group-hover/rich-block:grid-rows-[1fr] group-hover/rich-block:opacity-100 group-focus-within/rich-block:pointer-events-auto group-focus-within/rich-block:grid-rows-[1fr] group-focus-within/rich-block:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(hover:none)_and_(pointer:coarse)]:grid-rows-[1fr] [@media(hover:none)_and_(pointer:coarse)]:opacity-100';

function RichBlockForwardActions({
  blocks,
  onForward,
  layout = 'overlay',
}: {
  blocks: readonly RichBlock[];
  onForward: (blockId: string) => void;
  layout?: 'overlay' | 'flow';
}) {
  const actions = blocks.map((block, index) => (
    <RichBlockForwardButton
      key={block.id}
      block={block}
      groupedIndex={blocks.length > 1 ? index : undefined}
      onForward={onForward}
    />
  ));

  if (layout === 'flow') {
    return (
      <div data-testid="rich-block-forward-actions" data-quote-exclude className={RICH_BLOCK_FLOW_ACTIONS_CLASS}>
        <div className="min-h-0 overflow-hidden">
          <div
            data-testid="rich-block-forward-action-dock"
            className="ml-auto mt-1 flex w-fit max-w-full flex-wrap justify-end gap-0.5 rounded-lg border border-cafe bg-cafe-surface/90 p-0.5 shadow-sm backdrop-blur-sm"
          >
            {actions}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="rich-block-forward-actions" data-quote-exclude className={RICH_BLOCK_OVERLAY_ACTIONS_CLASS}>
      {actions}
    </div>
  );
}

function RichCardRenderer({
  block,
  messageId,
  messageSource,
  confirmations,
}: {
  block: Extract<RichBlock, { kind: 'card' }>;
  messageId?: string;
  messageSource?: ConnectorSource;
  confirmations?: CardConfirmationEntry[];
}) {
  if (isPersonMemoryProposalCardBlock(block)) {
    return <PersonMemoryProposalCard block={block} messageId={messageId} />;
  }
  if (isProposalCardBlock(block)) return <ProposalCard block={block} messageId={messageId} />;
  if (isHandoffProposalCardBlock(block)) return <HandoffProposalCard block={block} messageId={messageId} />;
  if (isScheduleMutationProposalCardBlock(block)) {
    return <ScheduleMutationProposalCard block={block} messageId={messageId} />;
  }
  if (isFrustrationIssueCardBlock(block, messageSource)) {
    return <FrustrationIssueCard block={block} messageId={messageId} />;
  }
  if (isCommunityIssuePreviewBlock(block, messageSource)) {
    return <CommunityIssuePreviewCard block={block} messageId={messageId} />;
  }
  if (isCommunityIssueDraftBlock(block, messageSource)) {
    return <CommunityIssueDraftCard block={block} messageId={messageId} />;
  }
  const metaKind = (block.meta as { kind?: string } | undefined)?.kind;
  const isTrustedCallbackAuth = metaKind === 'callback_auth_failure' && messageSource?.connector === 'callback-auth';
  if (isTrustedCallbackAuth) return <CallbackAuthFailureBlock block={block} />;
  return <CardBlock block={block} messageId={messageId} confirmations={confirmations} />;
}

function RichBlockRenderer({
  block,
  catId,
  messageId,
  messageSource,
  confirmations,
  sendContext,
}: {
  block: RichBlock;
  catId?: string;
  messageId?: string;
  messageSource?: ConnectorSource;
  confirmations?: CardConfirmationEntry[];
  /** F229 Bug 2 fix: propagated to InteractiveBlock to tag interactive-send events */
  sendContext?: string;
}) {
  switch (block.kind) {
    case 'card':
      return (
        <RichCardRenderer
          block={block}
          messageId={messageId}
          messageSource={messageSource}
          confirmations={confirmations}
        />
      );
    case 'diff':
      return <DiffBlock block={block} />;
    case 'checklist':
      return <ChecklistBlock block={block} />;
    case 'media_gallery':
      return <MediaGalleryBlock block={block} />;
    case 'audio':
      return <AudioBlock block={block} catId={catId} />;
    case 'interactive':
      return <InteractiveBlock block={block} messageId={messageId} sendContext={sendContext} />;
    case 'html_widget':
      return <HtmlWidgetBlock block={block} />;
    case 'file':
      return <FileBlock block={block} />;
    default:
      return (
        <div className="rounded-lg border border-cafe px-3 py-2 text-xs text-cafe-muted">
          未知富块类型: {(block as { kind: string }).kind}
        </div>
      );
  }
}

/** A forwarded Rich Block is evidence, not a new execution surface. */
function ReadOnlyRichBlockRenderer({ block }: { block: RichBlock }) {
  if (block.kind === 'card') {
    return <CardBlock block={{ ...block, actions: undefined, meta: undefined }} />;
  }
  if (block.kind === 'interactive') {
    return (
      <CardBlock
        block={{
          id: block.id,
          kind: 'card',
          v: 1,
          title: block.title ?? '交互选项',
          bodyMarkdown: block.description,
          fields: block.options.map((option) => ({ label: option.label, value: option.description ?? '' })),
        }}
      />
    );
  }
  if (block.kind === 'html_widget') {
    return (
      <CardBlock
        block={{
          id: block.id,
          kind: 'card',
          v: 1,
          title: block.title ?? 'HTML 小组件',
          bodyMarkdown: '这是转发的只读副本，不会运行原小组件。',
        }}
      />
    );
  }
  return <RichBlockRenderer block={block} />;
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

export function RichBlocks({
  blocks,
  catId,
  messageId,
  sourceThreadId,
  sourceMessageIds,
  messageSource,
  confirmations,
  sendContext,
  readOnly = false,
  forwardingEnabled = true,
}: {
  blocks: RichBlock[];
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
  /** Forwarded blocks are inert evidence: no callbacks, specialised actions, or HTML execution. */
  readOnly?: boolean;
  /** The source must be terminal and the browser document admitted before forwarding can begin. */
  forwardingEnabled?: boolean;
}) {
  const [forwardBlockId, setForwardBlockId] = useState<string | null>(null);
  if (blocks.length === 0) return null;
  const items = readOnly ? blocks : groupBlocks(blocks);
  const forwardBlock = forwardBlockId ? blocks.find((block) => block.id === forwardBlockId) : undefined;
  return (
    <>
      <div className="mt-2 space-y-2">
        {items.map((item) =>
          'grouped' in item ? (
            <div key={item.groupId} data-rich-block-group-id={item.groupId} className="group/rich-block relative">
              <InteractiveBlockGroup blocks={item.blocks} messageId={messageId} sendContext={sendContext} />
              {!readOnly && forwardingEnabled && messageId && sourceThreadId ? (
                <RichBlockForwardActions blocks={item.blocks} layout="flow" onForward={setForwardBlockId} />
              ) : null}
            </div>
          ) : (
            <div key={item.id} data-rich-block-id={item.id} className="group/rich-block relative">
              {readOnly ? (
                <ReadOnlyRichBlockRenderer block={item} />
              ) : (
                <RichBlockRenderer
                  block={item}
                  catId={catId}
                  messageId={messageId}
                  messageSource={messageSource}
                  confirmations={confirmations}
                  sendContext={sendContext}
                />
              )}
              {!readOnly && forwardingEnabled && messageId && sourceThreadId ? (
                <RichBlockForwardActions blocks={[item]} onForward={setForwardBlockId} />
              ) : null}
            </div>
          ),
        )}
      </div>
      {forwardingEnabled && forwardBlock && messageId && sourceThreadId ? (
        <TransferTargetPicker
          open
          admissionBlocked={!forwardingEnabled}
          sourceThreadId={sourceThreadId}
          items={[
            {
              kind: 'rich_block',
              messageId,
              sourceMessageIds: sourceMessageIds ? [...sourceMessageIds] : [messageId],
              blockId: forwardBlock.id,
            },
          ]}
          onClose={() => setForwardBlockId(null)}
          onSuccess={() => setForwardBlockId(null)}
        />
      ) : null}
    </>
  );
}
