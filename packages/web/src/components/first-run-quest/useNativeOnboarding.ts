'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CatData, useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import { initialState } from '../hub-cat-editor.model';
import type { RuntimeChoice } from '../settings/members/member-runtime-draft';
import { matchesRuntime } from '../settings/members/member-runtime-draft';
import { syncDraftToStorage } from '../thread-drafts';
import { legacyCreationKey, legacySharedKey } from './legacy-creation-key';
import { buildNativeCreationPayload } from './native-creation-payload';
import { repairLegacyNativeIdentityFields } from './native-identity-repair';
import {
  type NativePartner,
  nativeRuntimeSelectable,
  newNativeRequestKey,
  recommendNativePartners,
  SMALL_GOALS,
} from './native-onboarding';
import { buildNativeTeamGoal, orderGoalPartners } from './native-team-goal';
import { prepareFirstRunEntry } from './prepareFirstRunEntry';
import type { TemplateCard } from './TemplateStep';

interface CreatedPartner {
  id: string;
  name: string;
  mention: string;
}
interface SetupDraft {
  version: 2;
  idScheme?: 'short-v1';
  journeyId: string;
  partners: NativePartner[];
  goal: string;
  lead: string;
  created: Record<string, CreatedPartner>;
  threadId?: string;
  /** Only a new, verified empty roster may prepare the personal entry reminder. */
  initialRosterEmpty?: boolean;
}
async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function newJourneyId(): string {
  // getRandomValues also works on HTTP LAN origins, where randomUUID is unavailable.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function useNativeOnboarding(
  open: boolean,
  onCreated: (id: string, name: string) => void | Promise<void>,
  mode: 'goal' | 'members' = 'goal',
) {
  const { refresh } = useCatData();
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorStage, setErrorStage] = useState<'discovery' | 'save' | null>(null);
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);
  const key = useRef('');
  const inFlight = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  const persist = useCallback((next: SetupDraft) => {
    latest.current = next;
    setDraft(next);
    try {
      localStorage.setItem(key.current, JSON.stringify(next));
    } catch {
      /* In-memory retries still work. */
    }
  }, []);

  useEffect(() => {
    void reload;
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setErrorStage(null);
    void Promise.all([
      readJson<{ userId: string }>('/api/session', { signal: controller.signal }),
      readJson<{ runtimes: RuntimeChoice[] }>(`/api/cats/native-runtimes${reload ? '?refresh=1' : ''}`, {
        signal: controller.signal,
      }),
      readJson<{ templates: TemplateCard[] }>('/api/cat-templates', { signal: controller.signal }),
      readJson<{ cats: CatData[] }>('/api/cats', { signal: controller.signal }),
    ])
      .then(([session, discovered, templates, roster]) => {
        if (controller.signal.aborted) return;
        key.current = `cat-cafe:${mode === 'members' ? 'native-team-setup' : 'native-onboarding'}:v2:${session.userId}`;
        let saved: SetupDraft | null = null;
        try {
          const parsed = JSON.parse(localStorage.getItem(key.current) ?? 'null') as SetupDraft | null;
          if (parsed?.version === 2 && typeof parsed.journeyId === 'string' && Array.isArray(parsed.partners))
            saved = parsed;
        } catch {
          /* A corrupt draft does not prevent setup. */
        }
        const journeyId = saved?.journeyId ?? newJourneyId();
        const currentCats = roster.cats;
        const partners = recommendNativePartners(discovered.runtimes, templates.templates, currentCats, journeyId).map(
          (partner) => {
            const previous = saved?.partners.find((p) => p.form && matchesRuntime(p.form, partner.runtime));
            if (!previous?.form) return partner;
            const savedMember = currentCats.find(
              (cat) => cat.id === previous.form.catId && matchesRuntime(initialState(cat), partner.runtime),
            );
            const acknowledged = saved?.created[partner.id] ?? saved?.created[previous.id];
            const confirmed = Boolean(previous.existingId || (acknowledged && savedMember?.id === acknowledged.id));
            const receiptMismatch =
              acknowledged &&
              currentCats.some(
                (cat) => cat.id === acknowledged.id && !matchesRuntime(initialState(cat), partner.runtime),
              );
            const restoredForm = confirmed && savedMember ? initialState(savedMember) : previous.form;
            // Repair a pre-identity default even when the draft is not confirmed:
            // a draft whose member is no longer in the roster (for example, a
            // clean install or a reset catalog) is a fresh recommendation and
            // must show the cat identity. An unconfirmed form whose member still
            // exists may be the exact body of a lost-response retry, so leave
            // that wire shape untouched.
            const identityRepair =
              confirmed || !savedMember
                ? repairLegacyNativeIdentityFields(restoredForm, partner.form, partner.runtime)
                : {};
            const identityChanged = Object.keys(identityRepair).length > 0;
            const form = identityChanged ? { ...restoredForm, ...identityRepair } : restoredForm;
            return {
              ...partner,
              // A repaired form is a new request: its old key may belong to a
              // different payload. A true lost-response retry keeps its key.
              creationRequestKey: receiptMismatch
                ? partner.creationRequestKey
                : identityChanged && !savedMember
                  ? newNativeRequestKey()
                  : saved?.idScheme
                    ? legacyCreationKey(previous, saved.partners)
                    : (previous.creationRequestKey ?? partner.creationRequestKey),
              legacySharedRequestKey: saved?.idScheme ? legacySharedKey(previous, saved.partners) : undefined,
              existingId: confirmed && savedMember ? savedMember.id : undefined,
              missingExisting: Boolean(previous.existingId && !savedMember),
              ...(!confirmed && savedMember && !saved?.idScheme
                ? { recoverable: { id: savedMember.id, form: initialState(savedMember) } }
                : {}),
              selected:
                nativeRuntimeSelectable(partner.runtime, form) && (!previous.runtime?.installed || previous.selected),
              form,
            };
          },
        );
        persist({
          version: 2,
          ...(!saved || saved.idScheme ? { idScheme: 'short-v1' as const } : {}),
          journeyId,
          initialRosterEmpty: saved?.initialRosterEmpty ?? (!saved && roster.cats.length === 0),
          partners,
          goal: saved?.goal ?? SMALL_GOALS[0].content,
          lead:
            partners.find((p) => {
              const previousLead = saved?.partners.find((old) => old.id === saved.lead);
              return previousLead?.form && matchesRuntime(previousLead.form, p.runtime);
            })?.id ??
            partners.find((p) => p.selected)?.id ??
            '',
          created: Object.fromEntries(
            partners.flatMap((partner) => {
              const previous = saved?.partners.find((p) => p.form && matchesRuntime(p.form, partner.runtime));
              const member = saved?.created[partner.id] ?? (previous && saved?.created[previous.id]);
              return member &&
                roster.cats.some((cat) => cat.id === member.id && matchesRuntime(initialState(cat), partner.runtime))
                ? [[partner.id, member] as const]
                : [];
            }),
          ),
          threadId: saved?.threadId,
        });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : '无法读取本机工具');
          setErrorStage('discovery');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, reload, persist, mode]);

  const patch = (changes: Partial<SetupDraft>) => {
    if (latest.current && !inFlight.current) persist({ ...latest.current, ...changes });
  };
  const patchPartner = (id: string, change: Partial<NativePartner>) => {
    if (!latest.current) return;
    patch({ partners: latest.current.partners.map((p) => (p.id === id ? { ...p, ...change } : p)) });
  };
  const start = async () => {
    const current = latest.current;
    if (
      !current ||
      loading ||
      errorStage === 'discovery' ||
      inFlight.current ||
      (mode === 'goal' && !current.goal.trim())
    )
      return;
    const selected = orderGoalPartners(
      current.partners.filter((p) => p.selected && nativeRuntimeSelectable(p.runtime, p.form)),
      current.lead,
    );
    if (!selected.length) return;
    if (selected.some((p) => p.recoverable && !p.existingId)) {
      setError('旧草稿的成员已存在，请先明确选择复用现有伙伴，或取消选择。');
      setErrorStage('save');
      return;
    }
    inFlight.current = true;
    setError('');
    setErrorStage(null);
    let progress = current;
    let pendingPartner: NativePartner | undefined;
    const headers = { 'Content-Type': 'application/json', 'X-Cat-Cafe-Onboarding-Journey': current.journeyId };
    try {
      if (mode === 'members' && current.initialRosterEmpty) {
        await prepareFirstRunEntry();
      }
      for (const selection of selected) {
        const partner = progress.partners.find((p) => p.id === selection.id) ?? selection;
        const id = partner.id;
        if (progress.created[id]) continue;
        setBusy(`正在添加 ${partner.form.displayName}…`);
        pendingPartner = partner;
        const result = partner.existingId
          ? {
              cat: {
                id: partner.existingId,
                displayName: partner.form.displayName,
                mentionPatterns: partner.form.mentionPatterns.split(/[\s,]+/).filter(Boolean),
              },
            }
          : await readJson<{ cat: { id: string; displayName: string; mentionPatterns: string[] } }>('/api/cats', {
              method: 'POST',
              headers: {
                ...headers,
                'Idempotency-Key': `onboarding:${current.journeyId}:cat:${partner.creationRequestKey ?? id}`,
              },
              body: JSON.stringify(buildNativeCreationPayload(partner.form)),
            });
        pendingPartner = undefined;
        progress = {
          ...progress,
          partners: progress.partners.map((p) => {
            if (p.id === id) return { ...p, form: { ...p.form, catId: result.cat.id } };
            // A successful server replay/create proves which legacy key/body owns this member.
            // Split the remaining collision before their first POST, even when the initial roster was empty.
            return !partner.existingId &&
              p.legacySharedRequestKey === partner.creationRequestKey &&
              p.creationRequestKey === partner.creationRequestKey
              ? { ...p, creationRequestKey: newNativeRequestKey() }
              : p;
          }),
          created: {
            ...progress.created,
            [id]: {
              id: result.cat.id,
              name: result.cat.displayName,
              mention: result.cat.mentionPatterns[0] || `@${result.cat.id}`,
            },
          },
        };
        persist(progress);
      }
      const lead = progress.created[selected.find((p) => p.id === current.lead)?.id ?? selected[0].id];
      if (mode === 'members') {
        await refresh();
        await onCreated(lead.id, lead.name);
        return;
      }
      setBusy('正在准备对话…');
      if (!progress.threadId) {
        const thread = await readJson<{ id: string }>('/api/threads', {
          method: 'POST',
          headers: { ...headers, 'Idempotency-Key': `onboarding:${current.journeyId}:thread` },
          body: JSON.stringify({ title: '第一个小目标' }),
        });
        progress = { ...progress, threadId: thread.id };
        persist(progress);
      }
      if (!progress.threadId) throw new Error('对话尚未保存，请重试');
      syncDraftToStorage(
        progress.threadId,
        buildNativeTeamGoal(
          selected.map((p) => progress.created[p.id]),
          current.goal,
        ),
      );
      refresh();
      onCreated(progress.threadId, lead.name);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '保存失败，请重试；已添加的伙伴会保留。';
      setError(
        pendingPartner
          ? `添加 ${pendingPartner.form.displayName}（${pendingPartner.runtime.label}）失败：${message}`
          : message,
      );
      setErrorStage('save');
    } finally {
      inFlight.current = false;
      setBusy('');
    }
  };
  return { draft, loading, error, errorStage, busy, patch, patchPartner, start, reload: () => setReload((n) => n + 1) };
}
