'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import type { useWorkspace } from '@/hooks/useWorkspace';
import type { ChatData } from './chat-models';
import type { ChatUiState } from './types';
import { useBoardBindings } from './useBoardBindings';
import { useCanonBindings } from './useCanonBindings';
import { useChatOwnerBindings } from './useChatOwnerBindings';
import { useDesktopUpdateBindings } from './useDesktopUpdateBindings';
import { DocumentOwnerBinding, useDocumentBindings } from './useDocumentBindings';
import { useEvaluationBindings } from './useEvaluationBindings';
import { useEvolutionBindings } from './useEvolutionBindings';
import { useFilmBindings } from './useFilmBindings';
import { useGeneralBindings } from './useGeneralBindings';
import { useHomeBindings } from './useHomeBindings';
import { useMemoryBindings } from './useMemoryBindings';
import { useMessageSourceBindings } from './useMessageSourceBindings';
import { useOpsBindings } from './useOpsBindings';
import { usePreviewBindings } from './usePreviewBindings';
import { useRecentWorks } from './useRecentWorks';
import { useReplayBindings } from './useReplayBindings';
import { ReviewOwnerBinding, useReviewBindings } from './useReviewBindings';
import { useScheduleBindings } from './useScheduleBindings';
import { useSettingsBindings } from './useSettingsBindings';
import { type SidebarSource, useSidebarBindings } from './useSidebarBindings';
import { useSignalBindings } from './useSignalBindings';
import { useTeamBindings } from './useTeamBindings';
import { useTerminalBindings } from './useTerminalBindings';
import { useTrashBindings } from './useTrashBindings';
import { useVoiceBindings } from './useVoiceBindings';
import { useWorkbenchBindings } from './useWorkbenchBindings';

export interface ProjectBindings {
  data: Record<string, unknown>;
  sidebarData: SidebarSource;
  sidebarError: unknown;
  action: (name: string, args: Record<string, string>, element?: HTMLElement) => Promise<unknown>;
}

export function ProjectDataBinding({
  data,
  workspace,
  needed = new Set(),
  readGeneration = 1,
  fields,
  target,
  ui,
  changed,
}: {
  data: ChatData;
  needed?: ReadonlySet<string>;
  readGeneration?: number;
  workspace: ReturnType<typeof useWorkspace>;
  fields: Record<string, unknown>;
  target: () => string;
  ui: ChatUiState;
  changed: (binding: ProjectBindings) => void;
}) {
  const need = (source: string) =>
    [...needed].some((key) => key === source || key.startsWith(source + '.')) ? readGeneration : false;
  const workbench = useWorkbenchBindings(data, workspace, {
    git: need('project.workbench.git'),
    native: need('project.workbench.native'),
    execution: need('project.workbench.execution'),
    recall: need('project.workbench.recall'),
    tasks: need('project.workbench.tasks'),
    file: need('project.workbench.opened'),
  });
  const terminal = useTerminalBindings(workspace.worktreeId, workbench.state, need('project.terminal'));
  const home = useHomeBindings(data, workbench.state, need('project.home'));
  const recentWorks = useRecentWorks(data, need('project.recentWorks'));
  const desktop = useDesktopUpdateBindings();
  const sidebar = useSidebarBindings(data, need('sidebar'));
  const sources = useMessageSourceBindings(data, need('project.sources'));
  const chatOwners = useChatOwnerBindings(data, need('project.chatOwners.proposals'), need('project.chatOwners.vote'));
  const general = useGeneralBindings(data.threadId, ui, (source) => need('project.general.' + source));
  const settings = useSettingsBindings();
  const board = useBoardBindings(data, workbench.state, need('project.board'), [
    ...new Set(
      [...needed]
        .filter((key) => key.startsWith('project.board.docs.'))
        .map((key) => key.slice('project.board.docs.'.length).split('.')[0]),
    ),
  ]);
  const schedule = useScheduleBindings(need('project.schedule'));
  const evaluation = useEvaluationBindings(data, need('project.evaluation'));
  const signals = useSignalBindings(workbench.state, need('project.signals'));
  const team = useTeamBindings(need('project.team'));
  const ops = useOpsBindings(data, workbench.state, need('project.ops'));
  const preview = usePreviewBindings(data, workspace.worktreeId, need('project.preview'));
  const replay = useReplayBindings(board.replaySources, need('project.replay'));
  const evolution = useEvolutionBindings(workbench.state, need('project.evolution'));
  const reviews = useReviewBindings(
    data.threadId,
    ui,
    recentWorks.owners,
    need('project.reviews'),
    need('project.reviews.global'),
  );
  const memory = useMemoryBindings((source) => need('project.memory.' + source));
  const trash = useTrashBindings(need('project.trash'));
  const document = useDocumentBindings(fields, workbench.opened);
  const canon = useCanonBindings(
    data.threadId,
    workbench.state,
    async (source, prompt) => {
      await reviews.action('contentModify', { op: 'open', source: source as unknown as string, prompt });
    },
    need('project.canon'),
  );
  const film = useFilmBindings(workbench.state, data.threadId, need('project.film'));
  const voice = useVoiceBindings(data.threadId, target, workspace, fields, (source) => need('project.voice.' + source));
  const bindings = {
    workbench,
    terminal,
    home,
    recentWorks,
    desktop,
    sidebar,
    sources,
    chatOwners,
    general,
    settings,
    board,
    schedule,
    evaluation,
    signals,
    team,
    ops,
    preview,
    replay,
    evolution,
    voice,
    reviews,
    memory,
    trash,
    film,
    canon,
    document,
  };
  const bindingRefs = useRef(bindings);
  bindingRefs.current = bindings;
  const held = useRef<Record<string, unknown>>({});
  const collect = () => {
    let next = held.current;
    for (const [name, binding] of Object.entries(bindingRefs.current)) {
      if (name === 'sidebar') continue;
      const value = binding.data,
        previous = next[name];
      if (Object.is(previous, value)) continue;
      if (next === held.current) next = { ...next };
      next[name] = value;
    }
    const failures = Object.fromEntries(readFailures.current);
    if (
      Object.entries(failures).some(
        ([key, value]) => (next.readFailures as Record<string, Error> | undefined)?.[key] !== value,
      ) ||
      Object.keys((next.readFailures ?? {}) as object).length !== Object.keys(failures).length
    )
      next = { ...next, readFailures: failures };
    held.current = next;
    return next;
  };
  const readFailures = useRef(new Map<string, Error>());
  const [, refreshReads] = useState(0);
  const rawData = collect();
  useLayoutEffect(() => {
    Object.assign(ui, {
      voice: voice.state,
      m: memory.state,
      memoryEdit: memory.editor,
      memoryLibraryDraft: memory.libraryDraft,
      evolutionReading: evolution.state,
      evalDuty: evaluation.state,
    });
    ui.workspace = { workbench: workbench.state, preview: preview.state, reviews: reviews.state };
    const sidebarError = sidebar.error || readFailures.current.get('sidebar');
    changed({
      get data() {
        return collect();
      },
      sidebarData: sidebarError ? { ...sidebar.data, owner: null } : sidebar.data,
      sidebarError,
      action: async (name, args, element) => {
        for (const [owner, binding] of Object.entries(bindingRefs.current)) {
          if (!('action' in binding)) continue;
          try {
            const result = await binding.action(name, args, element);
            if (result) {
              if (readFailures.current.delete(owner)) {
                refreshReads((n) => n + 1);
              }
              return result;
            }
          } catch (error) {
            // Publish the owning read failure with the next raw snapshot.
            if (error instanceof Error && error.name === 'PdlReadError') {
              readFailures.current.set(owner, error);
              refreshReads((n) => n + 1);
            }
            throw error;
          }
        }
        return false;
      },
    });
  }, [
    rawData,
    sidebar.data,
    sidebar.error,
    ui,
    changed,
    voice.state,
    memory.state,
    memory.editor,
    memory.libraryDraft,
    evolution.state,
    evaluation.state,
    workbench.state,
    preview.state,
    reviews.state,
  ]);
  return (
    <>
      {evolution.ownerView}
      {board.ownerView}
      {need('project.reviews.review') && reviews.reviewId ? (
        <ReviewOwnerBinding
          key={reviews.reviewId}
          reviewId={reviews.reviewId}
          round={reviews.round}
          generation={readGeneration}
          changed={reviews.changed}
        />
      ) : null}
      {need('project.document') &&
      workbench.opened &&
      !workbench.opened.file.binary &&
      /^(text\/|application\/(json|javascript))/.test(workbench.opened.file.mime) ? (
        <DocumentOwnerBinding
          key={JSON.stringify([workbench.opened.worktreeId, workbench.opened.file.path, workbench.opened.file.sha256])}
          worktreeId={workbench.opened.worktreeId}
          file={workbench.opened.file}
          generation={readGeneration}
          changed={document.changed}
        />
      ) : null}
    </>
  );
}
