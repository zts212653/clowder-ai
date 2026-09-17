import { z } from 'zod';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { apiFetch } from '@/utils/api-client';
import { type EvolutionProgramProjection, parseProgramProjection } from '../evolution-program-projection';
import { recoverRequestRecords } from '../evolution-request-persistence';

const receiptSchema = z.object({
  status: z.enum(['queued', 'processing', 'duplicate']),
  userMessageId: z.string().min(1).max(200),
});
const recordSchema = z.object({ clientMessageId: z.string().uuid(), receipt: receiptSchema.optional() });
type RequestRecord = z.infer<typeof recordSchema>;
interface RequestState {
  records: Record<string, RequestRecord>;
  pending: Record<string, boolean>;
  errors: Record<string, string | undefined>;
}

/** Local retry coordinates only. The actual work request and its delivery live in F117/F264. */
export const useEvolutionProgressRequests = create<RequestState>()(
  persist(() => ({ records: {}, pending: {}, errors: {} }), {
    name: 'f311-progress-requests-v1',
    storage: createJSONStorage(() => localStorage),
    partialize: ({ records }) => ({ records }),
    merge: (persisted, current) => {
      const records = recoverRequestRecords(persisted, recordSchema);
      return records ? { ...current, records } : current;
    },
  }),
);

export function progressRequestKey({ program }: EvolutionProgramProjection): string {
  return `${program.workspaceId}:${program.programId}:${program.sequence}`;
}

export function progressRequestLabel({ program }: EvolutionProgramProjection): string | undefined {
  if (program.lifecycle !== 'active' || program.stage === 'awaiting_approval') return undefined;
  return ['writing_back', 'revalidating', 'deciding'].includes(program.stage) ? '请猫猫跟进结果' : '请猫猫推进评估';
}

export async function requestEvolutionProgress(projection: EvolutionProgramProjection, remind = false): Promise<void> {
  const key = progressRequestKey(projection);
  const state = useEvolutionProgressRequests.getState();
  if (state.pending[key] || (state.records[key]?.receipt && !remind) || !progressRequestLabel(projection)) return;
  const { origin } = projection;
  if (!origin?.createdByCatId) return;
  useEvolutionProgressRequests.setState((current) => ({
    pending: { ...current.pending, [key]: true },
    errors: { ...current.errors, [key]: undefined },
  }));
  try {
    // Re-read the workspace-fenced source before any write. A stale view must not wake a guessed contact.
    const response = await apiFetch(
      `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}`,
    );
    const fresh = response.ok ? parseProgramProjection(await response.json()) : null;
    if (!fresh) throw new Error('暂时无法确认项目与发起对话，请重试。');
    if (
      progressRequestKey(fresh) !== key ||
      fresh.origin?.threadId !== origin.threadId ||
      fresh.origin.createdByCatId !== origin.createdByCatId ||
      !progressRequestLabel(fresh)
    )
      throw new Error('项目已更新，请刷新后再试。');
    const rosterResponse = await apiFetch('/api/cats');
    const roster = z
      .object({
        cats: z.array(z.object({ id: z.string(), roster: z.object({ available: z.boolean().optional() }).nullish() })),
      })
      .safeParse(rosterResponse.ok ? await rosterResponse.json() : null);
    if (
      !roster.success ||
      !roster.data.cats.some((cat) => cat.id === origin.createdByCatId && cat.roster?.available !== false)
    )
      throw new Error('发起猫猫当前不可用，请回到发起对话确认接手者。');
    const record = (!remind && state.records[key]) || { clientMessageId: crypto.randomUUID() };
    // Persist before POST so a lost response/reload reuses the canonical message idempotency key.
    useEvolutionProgressRequests.setState((current) => ({ records: { ...current.records, [key]: record } }));
    const sent = await apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: origin.threadId,
        idempotencyKey: record.clientMessageId,
        messageDisposition: 'continue_current',
        content: `@${origin.createdByCatId}\n请推进现有能力项目 ${projection.program.programId}。\n先读取项目最新状态，沿本对话已有任务继续执行；若责任已交接，查证当前持球者后按现有链路协调，不新建重复项目。请补齐当前阶段可完成的目标约定、评估角色和真实证据，准备好后走正式工具推进，并回报已完成的动作、剩余缺口和下一步。若只有我能决定，请给出具体待决事项。不要只回复状态或让我再去另一个页面催；不要跳过审批、伪造证据或把本请求当作采用授权。`,
      }),
    });
    if (!sent.ok) throw new Error('推进请求未确认送达，请重试确认同一请求。');
    const receipt = receiptSchema.safeParse(await sent.json());
    if (!receipt.success) throw new Error('尚未取得送达回执，请重试确认同一请求。');
    useEvolutionProgressRequests.setState((current) => ({
      records: { ...current.records, [key]: { ...record, receipt: receipt.data } },
    }));
  } catch (error) {
    useEvolutionProgressRequests.setState((current) => ({
      errors: {
        ...current.errors,
        [key]:
          error instanceof Error && !(error instanceof TypeError)
            ? error.message
            : '网络暂时中断，请重试确认同一请求。',
      },
    }));
  } finally {
    useEvolutionProgressRequests.setState((current) => ({ pending: { ...current.pending, [key]: false } }));
  }
}
