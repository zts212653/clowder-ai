'use client';
import { type ExactAssetVersionRefV1, exactAssetVersionRefV1Schema } from '@cat-cafe/shared';
import { createElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useEvolutionAssetReview } from '@/components/capability-evolution/evolution-asset-resource';
import { canDecideChange, writeEvolutionChange } from '@/components/capability-evolution/evolution-change-commands';
import {
  acceptProgramProjection,
  useEvolutionPrograms,
} from '@/components/capability-evolution/evolution-program-resource';
import { useEvolutionReading } from '@/components/capability-evolution/evolution-reading-state';
import { comparisonScopeKey } from '@/components/capability-evolution/exploration/exploration-comparison';
import {
  sendExplorationRequest,
  useExplorationRequests,
} from '@/components/capability-evolution/exploration/exploration-requests';
import { useExplorationWorkspace } from '@/components/capability-evolution/exploration/use-exploration-workspace';
import {
  progressRequestKey,
  requestEvolutionProgress,
  useEvolutionProgressRequests,
} from '@/components/capability-evolution/journey/evolution-progress-request';
import { writeEvolutionLifecycle } from '@/components/capability-evolution/use-evolution-lifecycle';
import { write } from './owner-api';

type Exploration = ReturnType<typeof useExplorationWorkspace>;
type Program = NonNullable<ReturnType<typeof useEvolutionPrograms>['projection']>;
type ExplorationSnapshot = { owner: Program; workspace: Exploration };

function EvolutionExplorationBinding({
  owner,
  changed,
}: {
  owner: Program;
  changed: (snapshot: ExplorationSnapshot) => void;
}) {
  const workspace = useExplorationWorkspace(owner);
  useLayoutEffect(() => changed({ owner, workspace }));
  return null;
}

interface EvolutionUi {
  evoId?: string | null;
  evoReading?: Record<
    string,
    { view: string; stage: number | null; decision: string; notice: string; asset?: ExactAssetVersionRefV1 }
  >;
}
export function useEvolutionBindings(ui: EvolutionUi, needed: boolean | number = false) {
  const readingState = useRef(useEvolutionReading.getState().programs);
  useLayoutEffect(
    () =>
      useEvolutionReading.subscribe((state) => {
        readingState.current = state.programs;
      }),
    [],
  );
  const query = useEvolutionPrograms(undefined, needed);
  const exact = useEvolutionPrograms(ui.evoId || undefined, ui.evoId ? needed : false);
  const requests = useEvolutionProgressRequests();
  const [, changed] = useState(0);
  const [exploration, setExploration] = useState<ExplorationSnapshot | null>(null);
  const explorationChanged = useCallback(
    (next: ExplorationSnapshot) =>
      setExploration((old) =>
        old?.owner === next.owner &&
        old.workspace.reading === next.workspace.reading &&
        old.workspace.resource.review === next.workspace.resource.review &&
        old.workspace.resource.catalog === next.workspace.resource.catalog &&
        old.workspace.resource.loading === next.workspace.resource.loading &&
        old.workspace.resource.error === next.workspace.resource.error &&
        old.workspace.publicationError === next.workspace.publicationError
          ? old
          : next,
      ),
    [],
  );
  const explorationRequests = useExplorationRequests();
  const projection = () => (exact.projection?.program.programId === ui.evoId ? exact.projection : null);
  const reading = () => {
    ui.evoReading ||= {};
    return (ui.evoReading[ui.evoId!] ||= { view: 'judge', stage: null, decision: '', notice: '' });
  };
  const owner = projection();
  const assets = useEvolutionAssetReview(owner, owner ? reading().asset : undefined, needed);
  const workspace = exploration?.owner === owner ? exploration.workspace : null;
  const rawData = useMemo(
    () => ({
      query: { programs: query.programs, loading: query.loading, error: query.error, rejected: query.rejected },
      exact: { id: ui.evoId, projection: exact.projection, loading: exact.loading, error: exact.error },
      requests: { records: requests.records, errors: requests.errors },
      explorationRequests: { records: explorationRequests.records, errors: explorationRequests.errors },
      assets: {
        programId: owner?.program.programId,
        review: assets.review,
        catalog: assets.catalog,
        loading: assets.loading,
        error: assets.error,
      },
      exploration: workspace && {
        programId: owner!.program.programId,
        review: workspace.resource.review,
        catalog: workspace.resource.catalog,
        loading: workspace.resource.loading,
        error: workspace.resource.error,
        blockers: workspace.resource.blockers,
        recoverySelection: workspace.resource.recoverySelection,
        publicationError: workspace.publicationError,
      },
    }),
    [
      query.programs,
      query.loading,
      query.error,
      query.rejected,
      ui.evoId,
      exact.projection,
      exact.loading,
      exact.error,
      requests.records,
      requests.errors,
      explorationRequests.records,
      explorationRequests.errors,
      owner,
      assets.review,
      assets.catalog,
      assets.loading,
      assets.error,
      workspace,
    ],
  );
  return {
    state: readingState,
    data: rawData,
    ownerView:
      needed && owner
        ? createElement(EvolutionExplorationBinding, {
            key: owner.program.programId,
            owner,
            changed: explorationChanged,
          })
        : null,
    action: async (name: string, args: Record<string, string>) => {
      if (name === 'evoSubset') {
        if (
          !workspace?.compareExperiment ||
          !workspace.experiment ||
          workspace.comparison?.status !== 'scope_required' ||
          args.k !== comparisonScopeKey(workspace.compareExperiment, workspace.experiment)
        )
          throw new Error('比较对象已变化，请重新选择');
        workspace.acceptComparisonScope('paired_subset');
        return true;
      }
      if (name === 'evolutionOpen') {
        const asset =
          args.versionRef === undefined
            ? undefined
            : exactAssetVersionRefV1Schema.parse(
                typeof args.versionRef === 'string' ? JSON.parse(args.versionRef) : args.versionRef,
              );
        ui.evoId = args.id;
        const r = reading();
        if (asset) {
          r.asset = asset;
          r.view = 'hist';
        }
        changed((n) => n + 1);
        return true;
      }
      if (name === 'refresh' && args.k === 'evolution') {
        await Promise.all([query.reload(), exact.reload(), assets.retry(), workspace?.resource.retry()]);
        return true;
      }
      if (name === 'evolutionNew') {
        const receipt = await write<{ userMessageId: string }>('/api/messages', {
          threadId: args.threadId,
          idempotencyKey: args.operationId,
          messageDisposition: 'continue_current',
          content: `我们来进化 ${args.v.trim()}`,
        });
        if (!receipt.userMessageId) throw new Error('目标请求尚未确认，请重试');
        await query.reload();
        return true;
      }
      if (
        ['evoSelect', 'evoDraft', 'evoPublication'].includes(name) ||
        (name === 'evoRequest' && !['progress', 'remind'].includes(args.intent))
      ) {
        if (!owner || !workspace) throw new Error('探索记录尚未读取');
        const { node, experiment, catalog, reading: current, change } = workspace;
        if (args.programId && args.programId !== owner.program.programId) throw new Error('进化项目已切换');
        if (name === 'evoPublication') {
          const publication = catalog?.publication;
          if (!publication) throw new Error('当前没有新的公开记录');
          await workspace.adoptPublication({
            ...publication.selectionUpdate?.nextSelection,
            selectedSourceRef: publication.current.ref,
          });
        } else if (name === 'evoSelect' && args.field !== 'evo-intent') {
          if (args.field === 'evo-node') {
            const selected = catalog?.nodes.find((n) => JSON.stringify(n.nodeRef) === args.v);
            if (!selected) throw new Error('探索节点已变化');
            workspace.selectNode(selected);
          } else if (args.field === 'evo-experiment') {
            const selected = workspace.experiments.find((e) => JSON.stringify(e.experimentRef) === args.v);
            if (!selected) throw new Error('实验已变化');
            change({ selectedExperimentRef: selected.experimentRef });
          } else if (args.field === 'evo-compare') {
            const selected = catalog?.experiments.find((e) => JSON.stringify(e.experimentRef) === args.v);
            if (args.v && !selected) throw new Error('比较实验已变化');
            change({ comparisonExperimentRef: selected?.experimentRef, comparisonChoice: 'manual' });
          }
        } else {
          if (!node) throw new Error('请先选择探索节点');
          const base = {
              nodeRef: node.nodeRef,
              title: node.title,
              ...(experiment ? { experimentRef: experiment.experimentRef } : {}),
            },
            binding =
              current.draft.binding ??
              (node.kind === 'owner_version'
                ? { ...base, kind: node.kind, versionRef: node.versionRef }
                : { ...base, kind: node.kind }),
            draft = {
              ...current.draft,
              binding,
              ...(name === 'evoSelect' ? { intent: args.v as typeof current.draft.intent } : { text: args.v }),
            };
          if (name !== 'evoRequest') change({ draft });
          else {
            if (!draft.text.trim()) throw new Error('请填写探索请求');
            const id = await sendExplorationRequest({
              workspaceId: owner.program.workspaceId,
              programId: owner.program.programId,
              cycle: owner.program.cycle,
              objectRef: owner.program.objectRef,
              threadId: owner.origin!.threadId,
              catId: owner.origin!.createdByCatId!,
              binding,
              draft,
            });
            if (!id) throw new Error('请求尚未确认，请重试');
            if (useEvolutionReading.getState().programs[owner.program.programId]?.exploration?.draft === current.draft)
              change({ draft: { intent: 'explore', text: '' } });
          }
        }
        return true;
      }
      if (!['evoLifecycle', 'evolutionRename', 'evoChangeSync', 'wsEvoDecide', 'evoRequest'].includes(name))
        return false;
      const p = projection();
      if (!p || (args.programId && args.programId !== p.program.programId)) throw new Error('请重新读取当前进化项目');
      const r = reading();
      if (args.expectedRevision !== undefined && Number(args.expectedRevision) !== p.program.sequence)
        throw new Error('项目已更新，请按当前记录重试');
      if (name === 'evoLifecycle' || name === 'evolutionRename') {
        const result = await writeEvolutionLifecycle(
          p,
          name === 'evolutionRename' ? { type: 'name', displayName: args.v } : (args.op as 'pause' | 'resume'),
        );
        if (result.conflict) throw new Error('项目已同步到最新状态，请按当前记录重试');
      } else if (name === 'evoRequest') {
        if (!['progress', 'remind'].includes(args.intent)) return false;
        await requestEvolutionProgress(p, args.intent === 'remind');
        const error = useEvolutionProgressRequests.getState().errors[progressRequestKey(p)];
        if (error) throw new Error(error);
      } else {
        if (name === 'wsEvoDecide' && (!canDecideChange(p, p.lineage?.current) || !r.decision))
          throw new Error('当前没有可提交的决策');
        const action =
          name === 'evoChangeSync'
            ? { kind: 'sync' as const }
            : {
                kind: 'decide' as const,
                decision: r.decision as 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change',
              };
        const result = await writeEvolutionChange(p, action);
        acceptProgramProjection(result.projection);
        r.notice = result.notice;
        r.decision = '';
      }
      changed((n) => n + 1);
      return true;
    },
  };
}
