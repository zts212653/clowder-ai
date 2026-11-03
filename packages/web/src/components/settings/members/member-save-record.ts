import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { MemberSaveTrace } from '@/utils/member-save-trace';
import { buildCatPayload, type HubCatEditorFormState } from '../../hub-cat-editor.model';
import { buildMemberPatchPayload, type CatPayloadContext } from '../../hub-cat-editor.payload';
import { type MemberDraft, rebaseMemberDraft } from './member-editor-state';
import { readMemberResponse } from './member-save-extras';

/** Reconcile an uncertain S1 before another write; the create ID never changes implicitly. */
export async function saveMemberRecord(input: {
  snapshot: MemberDraft;
  form: HubCatEditorFormState;
  context: CatPayloadContext;
  trace: MemberSaveTrace;
  commit: (draft: MemberDraft) => void;
  conflict: () => void;
  onBeforeCreate?: () => Promise<void>;
}) {
  const { snapshot, form, context, trace, commit } = input;
  const baseline = snapshot.baseline;
  const catId = baseline?.id ?? form.catId.trim();
  const payload = baseline ? buildMemberPatchPayload(form, baseline, context) : buildCatPayload(form, null, context);
  if (baseline && !Object.keys(payload).length && !snapshot.pendingWrite) return baseline;
  if (baseline?.configurationRevision) Object.assign(payload, { expectedRevision: baseline.configurationRevision });
  const read = async (id: string) => {
    const body = await apiFetch('/api/cats').then(readMemberResponse<{ cats: CatData[] }>);
    return body.cats.find((member) => member.id === id);
  };
  const adopted = (member: CatData, intent: NonNullable<MemberDraft['pendingWrite']>) => {
    const remaining = buildMemberPatchPayload(intent.form, member, intent.context) as Record<string, unknown>;
    return Object.entries(intent.payload).every(([key, value]) => {
      if (key === 'catId' || key === 'expectedRevision') return true;
      if (key === 'cli' && value && remaining.cli) {
        const fields = remaining.cli as Record<string, unknown>;
        return Object.keys(value).every((field) => !Object.hasOwn(fields, field));
      }
      return !Object.hasOwn(remaining, key);
    });
  };
  if (snapshot.pendingWrite) {
    const pending = snapshot.pendingWrite;
    const member = await read(pending.catId);
    if (member && adopted(member, pending)) {
      if (
        Object.entries(form).some(
          ([field, value]) =>
            JSON.stringify(value) !== JSON.stringify(pending.form[field as keyof HubCatEditorFormState]),
        )
      ) {
        commit(rebaseMemberDraft({ ...snapshot, pendingWrite: undefined }, member, pending.form));
        throw new Error('已找回上次保存的成员并保留新草稿，请核对后再次保存。');
      }
      return member;
    }
    if (member && (pending.create || member.configurationRevision !== pending.payload.expectedRevision)) {
      input.conflict();
      throw new Error('该成员已有其他配置，未重复创建或覆盖；草稿已保留，请核对。');
    }
    if (pending.catId !== catId) throw new Error('上次创建结果尚未确认，请先核对原成员 ID，不能换 ID 重复创建。');
    if (!pending.create && !member) throw new Error('该成员已不存在，草稿已保留。');
  }
  if (!baseline && input.onBeforeCreate) await trace.phase('onboarding.entry', input.onBeforeCreate);
  const pendingWrite = { catId, create: !baseline, form, payload, context };
  commit({ ...snapshot, pendingWrite });
  let rejected = false;
  return trace.phase('member.write', () =>
    apiFetch(baseline ? `/api/cats/${baseline.id}` : '/api/cats', {
      method: baseline ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json', ...trace.headers() },
      body: JSON.stringify(payload),
    })
      .then((response) => {
        rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
        if (response.status === 409 || response.status === 428) input.conflict();
        return readMemberResponse<{ cat: CatData }>(response);
      })
      .then((body) => body.cat)
      .catch(async (error: unknown) => {
        if (rejected) {
          commit({ ...snapshot, pendingWrite: undefined });
          throw error;
        }
        const member = await read(catId).catch(() => undefined);
        if (member && adopted(member, pendingWrite)) return member;
        throw error;
      }),
  );
}
