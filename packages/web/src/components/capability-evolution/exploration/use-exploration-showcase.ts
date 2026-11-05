import {
  type EvolutionExplorationExperimentV1,
  type EvolutionExplorationRecordV1,
  type EvolutionResolvedExplorationReviewV1,
  evolutionExplorationReviewV1Schema,
  evolutionExplorationSelectionMatches,
  refIdentity,
} from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { apiFetch } from '@/utils/api-client';
import type { EvolutionProgramProjection } from '../evolution-program-projection';

export type ShowcaseRow = { label: string; experiment: EvolutionExplorationExperimentV1; caseId?: string };
type Read = { record?: EvolutionExplorationRecordV1; error?: string };
/** Exact bounded owner reads; local display state only, aborted with this visible reading deck. */
export function useExplorationShowcase(projection: EvolutionProgramProjection, rows: ShowcaseRow[], eligible: boolean) {
  const visible = useWorkspaceSurfaceVisibility();
  const rowKey = JSON.stringify(rows.map((row) => [row.label, refIdentity(row.experiment.experimentRef)]));
  const scope = JSON.stringify([projection.program.programId, refIdentity(projection.program.objectRef)]);
  const [reads, setReads] = useState<Record<string, Read>>({});
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: identities fence the owner scope and exact deck; fresh equivalent catalog objects must not restart reads.
  useEffect(() => {
    if (!visible || !eligible) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
      setReads((previous) =>
        Object.fromEntries(
          rows.map((row) => {
            const key = refIdentity(row.experiment.experimentRef);
            return [key, previous[key] ?? { error: '原件读取超时；恢复来源后可重试。' }];
          }),
        ),
      );
    }, 20_000);
    setReads({});
    void Promise.all(
      rows.map(async (row) => {
        const key = refIdentity(row.experiment.experimentRef);
        try {
          const record = await readShowcaseRecord(projection, row, controller.signal);
          if (controller.signal.aborted) return;
          setReads((previous) => ({
            ...previous,
            [key]: record ? { record } : { error: '本场景原件当前不可读；不借别的场景替代。' },
          }));
        } catch {
          if (!controller.signal.aborted)
            setReads((previous) => ({ ...previous, [key]: { error: '原件读取失败；恢复来源后可重试。' } }));
        }
      }),
    ).finally(() => window.clearTimeout(timer));
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [scope, rowKey, attempt, visible, eligible]);
  const retry = () => setAttempt((value) => value + 1);
  return { reads, retry };
}

function findShowcaseRecord(records: EvolutionExplorationRecordV1[], caseId?: string) {
  return caseId === undefined ? records[0] : records.find((record) => record.caseId === caseId);
}

function matchesShowcaseScope(review: EvolutionResolvedExplorationReviewV1, projection: EvolutionProgramProjection) {
  return (
    refIdentity(review.programRef) ===
      refIdentity({ ownerFeatureId: 'F311', ownerStateRef: projection.program.programId }) &&
    refIdentity(review.objectRef) === refIdentity(projection.program.objectRef)
  );
}

async function readShowcaseRecord(projection: EvolutionProgramProjection, row: ShowcaseRow, signal: AbortSignal) {
  const selection = { selectedNodeRef: row.experiment.nodeRef, selectedExperimentRef: row.experiment.experimentRef };
  const key = refIdentity(row.experiment.experimentRef);
  const query = new URLSearchParams(Object.entries(selection).map(([name, ref]) => [name, JSON.stringify(ref)]));
  const response = await apiFetch(
    `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}/exploration?${query}`,
    { signal: signal },
  );
  const parsed = evolutionExplorationReviewV1Schema.safeParse(await response.json());
  if (
    !response.ok ||
    !parsed.success ||
    parsed.data.status !== 'resolved' ||
    !matchesShowcaseScope(parsed.data, projection) ||
    !evolutionExplorationSelectionMatches(parsed.data, selection)
  )
    throw Error('来源身份、选择或完整性未通过核验');
  const detail = parsed.data.details.find((detail) => refIdentity(detail.experimentRef) === key);
  const record = detail?.status === 'resolved' ? findShowcaseRecord(detail.records, row.caseId) : undefined;

  return record;
}
