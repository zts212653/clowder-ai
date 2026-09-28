import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { type EvolutionProgramProjection, parseProgramProjection } from './evolution-program-projection';
import { acceptProgramProjection } from './evolution-program-resource';

export function useEvolutionLifecycle(projection: EvolutionProgramProjection | null) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const run = async (action: 'pause' | 'resume' | { type: 'name'; displayName: string }) => {
    if (!projection || pending) return;
    setPending(true);
    setNotice(null);
    const { programId, sequence } = projection.program;
    const kind = typeof action === 'string' ? action : action.type;
    const clientMessageId = `workbench:${kind}:${programId}:sequence:${sequence}${kind === 'name' ? `:${crypto.randomUUID()}` : ''}`;
    const ref = { ownerFeatureId: 'F311', ownerStateRef: `evolution-lifecycle-choice:${programId}:${clientMessageId}` };
    try {
      const response = await apiFetch(`/api/capability-evolution/programs/${encodeURIComponent(programId)}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedSequence: sequence,
          clientMessageId,
          action:
            typeof action !== 'string'
              ? action
              : action === 'pause'
                ? { type: 'pause', reasonRef: ref }
                : { type: 'resume', resumeRef: ref },
        }),
      });
      const body = (await response.json()) as { projection?: unknown };
      const result = parseProgramProjection(body.projection);
      if (
        (!response.ok && response.status !== 409) ||
        !result ||
        result.program.programId !== programId ||
        result.program.workspaceId !== projection.program.workspaceId
      )
        throw new Error('这次操作未完成，请刷新后重试。');
      acceptProgramProjection(result);
      if (response.status === 409) setNotice('项目已被其他操作更新，已同步到最新状态。');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '这次操作未完成。');
    } finally {
      setPending(false);
    }
  };
  return { pending, notice, run };
}
