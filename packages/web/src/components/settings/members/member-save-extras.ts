import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { MemberSaveTrace } from '@/utils/member-save-trace';
import {
  buildCodexConfigPatches,
  buildStrategyPayload,
  initialState,
  toCodexRuntimeSettings,
  toStrategyForm,
} from '../../hub-cat-editor.model';
import type { CatStrategyEntry } from '../../hub-strategy-types';
import type { MemberDraft } from './member-editor-state';

export async function readMemberResponse<T>(response: Response): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body !== null && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : {};
    throw new Error(
      typeof error.message === 'string'
        ? error.message
        : typeof error.error === 'string'
          ? error.error
          : `请求失败 (${response.status})`,
    );
  }
  return body as T;
}

/** S2/S3 reconcile independently: preserve committed resources and never overwrite a third value. */
export async function saveMemberExtras(
  snapshot: MemberDraft,
  member: CatData,
  trace: MemberSaveTrace,
  commit: (draft: MemberDraft) => void,
) {
  let next = {
    ...snapshot,
    baseline: member,
    form: initialState(member),
    runtimeDrafts: undefined,
    pendingWrite: undefined,
  };
  commit(next);
  const strategy = snapshot.strategy;
  if (strategy && JSON.stringify(strategy) !== JSON.stringify(snapshot.strategyBaseline)) {
    const target = buildStrategyPayload(strategy);
    const baseline = snapshot.strategyBaseline ? buildStrategyPayload(snapshot.strategyBaseline) : {};
    const changes = Object.fromEntries(
      Object.entries(target).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline[key])),
    );
    const read = async () => {
      const body = await apiFetch('/api/config/session-strategy').then(
        readMemberResponse<{ cats: CatStrategyEntry[] }>,
      );
      const entry = body.cats.find((item) => item.catId === member.id);
      if (!entry) throw new Error('会话策略暂不可读取，成员设置已保留。');
      return entry;
    };
    let saved = await read();
    const current = buildStrategyPayload(toStrategyForm(saved));
    const remaining = Object.fromEntries(
      Object.entries(changes).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(current[key])),
    );
    if (
      Object.keys(remaining).some(
        (key) => snapshot.strategyBaseline && JSON.stringify(current[key]) !== JSON.stringify(baseline[key]),
      )
    )
      throw new Error('会话策略已在其他页面修改，草稿已保留，请核对后补交。');
    if (Object.keys(remaining).length) {
      if (!saved.overrideRevision) throw new Error('请刷新以读取会话策略的保存版本。');
      saved = await trace.phase('strategy.write', () =>
        apiFetch(`/api/config/session-strategy/${member.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...trace.headers() },
          body: JSON.stringify({ ...remaining, expectedRevision: saved.overrideRevision }),
        })
          .then(readMemberResponse<CatStrategyEntry>)
          .catch(async (error: unknown) => {
            const actual = await read();
            const value = buildStrategyPayload(toStrategyForm(actual));
            if (Object.keys(changes).some((key) => JSON.stringify(value[key]) !== JSON.stringify(target[key])))
              throw error;
            return actual;
          }),
      );
    }
    const savedStrategy = toStrategyForm(saved);
    next = { ...next, strategy: savedStrategy, strategyBaseline: savedStrategy };
    commit(next);
  }
  if (snapshot.codexSettings && snapshot.codexBaseline) {
    const changes = buildCodexConfigPatches(snapshot.codexSettings, snapshot.codexBaseline);
    if (changes.length) {
      const read = () =>
        apiFetch('/api/config').then(
          readMemberResponse<{
            config: Parameters<typeof toCodexRuntimeSettings>[0];
            revisions: Record<string, string>;
          }>,
        );
      const current = await read();
      const settings = toCodexRuntimeSettings(current.config);
      for (const patch of changes) {
        const field =
          patch.key === 'cli.codexSandboxMode'
            ? 'sandboxMode'
            : patch.key === 'cli.codexApprovalPolicy'
              ? 'approvalPolicy'
              : 'authMode';
        if (settings[field] !== patch.value) {
          if (settings[field] !== snapshot.codexBaseline[field])
            throw new Error('客户端设置已在其他页面修改，草稿已保留，请核对后补交。');
          const expectedRevision = current.revisions?.[patch.key];
          if (!expectedRevision) throw new Error('请刷新以读取客户端设置的保存版本。');
          await trace.phase('codex.write', () =>
            apiFetch('/api/config', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...trace.headers() },
              body: JSON.stringify({ ...patch, expectedRevision }),
            })
              .then(readMemberResponse<unknown>)
              .catch(async (error: unknown) => {
                const actual = await read();
                if (toCodexRuntimeSettings(actual.config)[field] !== patch.value) throw error;
              }),
          );
        }
        next = { ...next, codexBaseline: { ...next.codexBaseline!, [field]: snapshot.codexSettings[field] } };
        commit(next);
      }
    }
  }
  return next;
}
