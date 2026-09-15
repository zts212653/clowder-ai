'use client';

import type { EvolutionProgramOriginV1 } from '@cat-cafe/shared';
import { useLayoutEffect, useRef } from 'react';
import { CapabilityEvolutionProgramDetail } from './CapabilityEvolutionProgramDetail';
import { CapabilityEvolutionProgramRow } from './CapabilityEvolutionProgramRow';
import {
  type EvolutionProgramPresentationProjection,
  evolutionProgramPresentation,
  productStatus,
} from './capability-evolution-presentation';
import { EvolutionProgramOrigin } from './EvolutionProgramOrigin';
import { useEvolutionAssetReview } from './evolution-asset-resource';
import { useEvolutionPrograms } from './evolution-program-resource';
import { DEFAULT_READING, useEvolutionReading } from './evolution-reading-state';
import { StartEvolution } from './StartEvolution';
import { useEvolutionScroll } from './use-evolution-scroll';
import './evolution-workspace.css';

function ProgramFocus({
  projection,
  onSelect,
}: {
  projection: EvolutionProgramPresentationProjection;
  onSelect: () => void;
}) {
  const status = productStatus(projection);
  const asset = useEvolutionAssetReview(projection);
  const target = evolutionProgramPresentation(projection.program, projection.origin);
  return (
    <section className="evolution-focus" aria-label="当前关注项目">
      <p className="text-xs font-semibold text-cafe-secondary">{status.label}</p>
      <h2 className="mt-3 text-xl font-semibold leading-8 text-cafe">{target.title}</h2>
      <EvolutionProgramOrigin projection={projection} />
      <p className="mt-2 text-sm leading-6 text-cafe-secondary">{status.description}</p>
      {asset.catalog && (
        <p className="mt-3 text-xs text-cafe-muted">
          {asset.catalog.currentVersionRefs.length
            ? `当前采用：${asset.catalog.currentVersionRefs.map((ref) => ref.version).join('、')}`
            : '尚无采用记录'}
        </p>
      )}
      <button type="button" className="evolution-primary mt-5" onClick={onSelect}>
        查看进展
      </button>
    </section>
  );
}

function WorkspaceProgramDetail({
  programId,
  onClose,
  onOpenProgram,
}: {
  programId: string;
  onClose: () => void;
  onOpenProgram: (programId: string, displayName?: string, origin?: EvolutionProgramOriginV1) => void;
}) {
  const { projection, error, reload } = useEvolutionPrograms(programId);
  if (!projection)
    return (
      <section>
        <button type="button" className="evolution-link" onClick={onClose}>
          ← 全部项目
        </button>
        <p role="status" className="evolution-empty mt-5">
          {error ?? '正在读取项目详情…'}
        </p>
        {error && (
          <button type="button" className="evolution-link mt-4" onClick={() => void reload()}>
            重试
          </button>
        )}
      </section>
    );
  return (
    <>
      <CapabilityEvolutionProgramDetail
        projection={projection}
        onClose={onClose}
        onOpenProgram={(id) => onOpenProgram(id, projection.program.displayName, projection.origin)}
      />
      {error && (
        <p role="status" className="evolution-empty">
          读取暂时中断，正在显示最近一次记录。
        </p>
      )}
    </>
  );
}

export function CapabilityEvolutionWorkspace({
  targetThreadId,
  onOpenProgram,
}: {
  targetThreadId: string | null;
  onOpenProgram: (programId: string, displayName?: string, origin?: EvolutionProgramOriginV1) => void;
}) {
  const { programs, loading, error, rejected, reload } = useEvolutionPrograms();
  const workspaceKey = targetThreadId ?? 'global';
  const selectedProgramId = useEvolutionReading((state) => state.workspaceProgramIds[workspaceKey] ?? null);
  const selectWorkspaceProgram = useEvolutionReading((state) => state.selectWorkspaceProgram);
  const homeScroll = useRef(0);
  const selected = programs.find((item) => item.program.programId === selectedProgramId);
  const { viewport, onScroll } = useEvolutionScroll(selectedProgramId ?? '', 'detail', selected !== undefined);
  const active = programs.filter((item) => item.program.lifecycle !== 'terminal');
  const completed = programs.filter((item) => item.program.lifecycle === 'terminal');
  const focus = [...active].sort((a, b) => {
    const attention = (item: EvolutionProgramPresentationProjection) =>
      item.program.stage === 'awaiting_approval' || item.program.stage === 'deciding'
        ? 2
        : item.program.stage !== 'constituting'
          ? 1
          : 0;
    return attention(b) - attention(a) || b.program.updatedAt.localeCompare(a.program.updatedAt);
  })[0];
  useLayoutEffect(() => {
    if (viewport.current)
      viewport.current.scrollTop = selectedProgramId
        ? (useEvolutionReading.getState().programs[selectedProgramId] ?? DEFAULT_READING).scroll.detail
        : homeScroll.current;
  }, [selectedProgramId]);
  const select = (id: string) => {
    homeScroll.current = viewport.current?.scrollTop ?? 0;
    selectWorkspaceProgram(workspaceKey, id);
  };
  return (
    <div
      className="evolution-workspace min-h-0 flex-1 overflow-y-auto"
      ref={viewport}
      data-testid="capability-evolution-workspace"
      onScroll={(event) => {
        if (!selectedProgramId) return;
        onScroll(event.currentTarget.scrollTop);
      }}
    >
      <div className="evolution-content space-y-7">
        {selected ? (
          <WorkspaceProgramDetail
            programId={selected.program.programId}
            onClose={() => selectWorkspaceProgram(workspaceKey, null)}
            onOpenProgram={onOpenProgram}
          />
        ) : (
          <>
            <header>
              <p className="evolution-eyebrow">目标与进展</p>
              <h1 className="evolution-title mt-2">能力进化</h1>
              <p className="mt-3 text-sm leading-6 text-cafe-secondary">从一个目标开始，让每次改进有据可循。</p>
            </header>
            {focus && <ProgramFocus projection={focus} onSelect={() => select(focus.program.programId)} />}
            <section aria-labelledby="capability-evolution-programs-heading">
              <div className="mb-4 flex items-baseline justify-between gap-3">
                <h2 id="capability-evolution-programs-heading" className="text-sm font-semibold text-cafe">
                  能力项目
                </h2>
                <button type="button" className="evolution-link" onClick={() => void reload()}>
                  刷新
                </button>
              </div>
              {loading ? (
                <p className="evolution-empty py-6">正在读取能力进化记录…</p>
              ) : error && !programs.length ? (
                <p className="evolution-empty py-6">
                  暂时无法读取进化记录，请稍后刷新。系统不会用临时数据冒充真实进展。
                </p>
              ) : !programs.length && !rejected ? (
                <p className="evolution-empty py-6">
                  还没有进化记录。在下方写下想改进什么，由你从目标对话发送即可开始。
                </p>
              ) : null}
              {rejected > 0 && (
                <output className="evolution-empty mb-4 block">
                  {rejected} 项进化记录暂时无法读取；
                  {programs.length ? '其余记录仍可使用。' : '原始记录仍安全保留，请刷新或更新页面。'}
                </output>
              )}
              <div className="space-y-2">
                {active.map((projection) => (
                  <CapabilityEvolutionProgramRow
                    key={projection.program.programId}
                    projection={projection}
                    selected={false}
                    onSelect={() => select(projection.program.programId)}
                  />
                ))}
              </div>
              {!!completed.length && (
                <details className="mt-5">
                  <summary className="cursor-pointer text-xs text-cafe-secondary">
                    已完成的项目 · {completed.length}
                  </summary>
                  <div className="mt-3 space-y-2">
                    {completed.map((projection) => (
                      <CapabilityEvolutionProgramRow
                        key={projection.program.programId}
                        projection={projection}
                        selected={false}
                        onSelect={() => select(projection.program.programId)}
                      />
                    ))}
                  </div>
                </details>
              )}
            </section>
            <details open={!programs.length} className="border-t border-cafe-subtle pt-5">
              <summary className="cursor-pointer text-sm font-semibold text-cafe">提出新目标</summary>
              <div className="mt-4">
                <StartEvolution key={targetThreadId ?? 'unbound'} targetThreadId={targetThreadId} />
              </div>
            </details>
          </>
        )}
        {error && programs.length > 0 && (
          <p role="status" className="evolution-empty">
            读取暂时中断，正在显示最近一次记录。
          </p>
        )}
      </div>
    </div>
  );
}
