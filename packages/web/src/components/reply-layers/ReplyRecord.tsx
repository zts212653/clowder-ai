'use client';

import {
  type CodexStartupRecovery,
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2,
  MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V3,
} from '@cat-cafe/shared';
import { useState } from 'react';
import { countRecallEvents } from '@/hooks/recall-feed-model';
import type { ChatMessageMetadata } from '@/stores/chat-types';
import { usePublishLayoutAfterDisclosure } from '../cli-output/CliOutputBlock';
import { codexStartupCopy } from '../codex-startup.shell-copy';
import { MetadataBadge } from '../MetadataBadge';
import { useShellCopy } from '../shell/shell-copy';
import { NativeReplyText } from './NativeReplyText';
import { ReplySubexecutions } from './ReplySubexecutions';
import { replyLayersCopy } from './reply-layers.shell-copy';
import type { ReplyOutputProjection } from './reply-output';
import type { ReplyRecallProjection } from './reply-recall';
import type { ReplyRecordRow } from './reply-record';
import type { ReplySubexecutionRecord } from './reply-subexecution';
import { subexecutionCopy } from './subexecution.shell-copy';

/**
 * F322 B — §1.16 第 3 层, the opened execution record: thinking, one row per tool call (click a row for its detail), and the
 * model / usage / cost line last. It replaces the dark CLI block in the new shell; the data is the same `toolEvents`.
 *
 * The container keeps `data-context-quote-source="cli_output"` and the rows keep their `tool-label:` / `tool-detail:` segment ids,
 * so quoting a tool call out of the record resolves exactly as it did out of the CLI block.
 */
function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none"
      style={{ color: 'var(--shell-muted)' }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LoaderIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none animate-spin"
      style={{ color: 'var(--semantic-info)' }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function FailedIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="flex-none"
      style={{ color: 'color-mix(in oklch, var(--semantic-critical) 55%, var(--shell-ink))' }}
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function UnconfirmedIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="flex-none"
      style={{ color: 'var(--shell-muted)' }}
    >
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

type ToolRowState = 'failed' | 'running' | 'done' | 'unconfirmed';

function rowState(row: ReplyRecordRow, active: boolean): ToolRowState {
  if (row.failed) return 'failed';
  if (row.settled) return 'done';
  return active ? 'running' : 'unconfirmed';
}

function RowMark({ state }: { state: ToolRowState }) {
  if (state === 'failed') return <FailedIcon />;
  if (state === 'running') return <LoaderIcon />;
  if (state === 'done') return <CheckIcon />;
  return <UnconfirmedIcon />;
}

function ToolRow({ row, state }: { row: ReplyRecordRow; state: ToolRowState }) {
  const [open, setOpen] = useState(false);
  usePublishLayoutAfterDisclosure(open);
  const hasDetail = Boolean(row.detail);
  return (
    <div
      data-testid={`reply-record-tool-${row.id}`}
      data-failed={row.failed || undefined}
      data-state={state}
      className="min-w-0"
    >
      <button
        type="button"
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-5 w-full min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
      >
        <RowMark state={state} />
        <code
          data-context-quote-segment-id={`tool-label:${row.id}`}
          data-context-quote-projection-version={MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V3}
          className="min-w-0 truncate font-mono text-xs"
          style={{ color: 'var(--shell-body)' }}
        >
          {row.label}
        </code>
      </button>
      {open && row.detail ? (
        <div
          data-context-quote-segment-id={`tool-detail:${row.id}`}
          data-context-quote-projection-version={MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V3}
          className="mt-1 whitespace-pre-wrap break-words pl-5 font-mono text-micro"
          style={{ color: 'var(--shell-muted)' }}
        >
          {row.detail}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingRow({ text }: { text: string }) {
  const t = useShellCopy(replyLayersCopy);
  const [open, setOpen] = useState(false);
  usePublishLayoutAfterDisclosure(open);
  return (
    <div data-testid="reply-record-thinking" className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-5 w-full min-w-0 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
      >
        <span className="flex-none" style={{ color: 'var(--shell-muted)' }}>
          {t.record.thinking}
        </span>
        {open ? null : (
          <span className="min-w-0 truncate" style={{ color: 'var(--shell-body)' }}>
            {text.replace(/\s+/g, ' ').trim()}
          </span>
        )}
      </button>
      {open ? (
        <div className="mt-1 whitespace-pre-wrap break-words pl-0" style={{ color: 'var(--shell-body)' }}>
          {text}
        </div>
      ) : null}
    </div>
  );
}

export interface ReplyRecordProps {
  startupRecovery?: CodexStartupRecovery;
  id: string;
  rows: readonly ReplyRecordRow[];
  /** The reply's effective status is still active; raw streaming residue never revives a terminal turn. */
  active: boolean;
  thinking?: string;
  /** The stream's working text of a merged reply (its spoken part is the body above); shown as plain text. */
  workingText?: string;
  metadata?: ChatMessageMetadata;
  recall?: ReplyRecallProjection;
  nativeOutput?: ReplyOutputProjection;
  subexecutions?: ReplySubexecutionRecord;
  catId?: string;
}

function RecallRow({ recall }: { recall: ReplyRecallProjection }) {
  const t = useShellCopy(replyLayersCopy);
  if (recall.status === 'loading') return null;
  const counts = countRecallEvents([...recall.events]);
  const text =
    recall.status === 'unavailable'
      ? t.record.recallUnavailable
      : counts.total > 0
        ? t.record.recallBreakdown(counts.search, counts.graph, counts.delivery)
        : null;
  if (!text) return null;
  return (
    <div data-testid="reply-record-recall" data-recall-status={recall.status} style={{ color: 'var(--shell-body)' }}>
      {text}
    </div>
  );
}

export function ReplyRecord({
  id,
  rows,
  active,
  thinking,
  workingText,
  metadata,
  recall,
  nativeOutput,
  subexecutions,
  catId,
  startupRecovery,
}: ReplyRecordProps) {
  const t = useShellCopy(subexecutionCopy);
  const startupCopy = useShellCopy(codexStartupCopy);
  const [toolsOpen, setToolsOpen] = useState(false);
  usePublishLayoutAfterDisclosure(toolsOpen);
  const tools = nativeOutput
    ? nativeOutput.record.map((entry) => {
        if (entry.kind === 'text') return <NativeReplyText key={entry.id} run={entry} process />;
        const row = rows.find((row) => row.id === entry.id);
        return row ? <ToolRow key={entry.id} row={row} state={rowState(row, active)} /> : null;
      })
    : rows.map((row) => <ToolRow key={row.id} row={row} state={rowState(row, active)} />);
  return (
    <div
      id={id}
      data-testid="reply-record"
      data-context-quote-source="cli_output"
      className="ml-1 flex min-w-0 flex-col gap-1.5 border-l py-1 pl-3 text-xs"
      style={{ borderColor: 'var(--shell-hairline)', color: 'var(--shell-muted)' }}
    >
      {startupRecovery?.stage === 'ready' && startupRecovery.attempt > 1 ? (
        <p className="m-0" data-testid="startup-recovered-record">
          {startupCopy.recovered(startupRecovery.attempt)}
        </p>
      ) : null}
      {recall ? <RecallRow recall={recall} /> : null}
      {thinking ? <ThinkingRow text={thinking} /> : null}
      {workingText ? (
        <div
          data-testid="reply-record-working-text"
          data-context-quote-segment-id="stdout"
          data-context-quote-projection-version={MESSAGE_BUNDLE_CLI_QUOTE_PROJECTION_VERSION_V2}
          className="whitespace-pre-wrap break-words"
          style={{ color: 'var(--shell-body)' }}
        >
          {workingText}
        </div>
      ) : null}
      {subexecutions?.total && catId ? <ReplySubexecutions record={subexecutions} catId={catId} /> : null}
      {subexecutions?.total && rows.length ? (
        <div data-testid="reply-own-tools" className="min-w-0">
          <button
            type="button"
            aria-expanded={toolsOpen}
            onClick={() => setToolsOpen((value) => !value)}
            className="min-h-11 rounded text-left text-xs hover:underline focus-visible:ring-2 focus-visible:ring-cafe-accent"
          >
            {toolsOpen ? '⌄' : '›'} {t.ownTools(rows.length)}
          </button>
          {toolsOpen ? tools : null}
        </div>
      ) : (
        tools
      )}
      {metadata ? (
        <div data-testid="reply-record-meta" className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
          <MetadataBadge metadata={metadata} />
        </div>
      ) : null}
    </div>
  );
}
