'use client';
import type {
  EntityMemoryProposalView,
  EventMemoryCorrectionProposalView,
  MemoryOwnerSourceResponse,
  PersonMemoryProposalView,
  ProfileMemoryProposalView,
  ProfileUsageSummary,
  TasteMemoryCorrectionProposalView,
} from '@cat-cafe/shared';
import {
  readProfileOpeningReference,
  splitProfileBody,
  updateProfileOpeningReference,
} from '@cat-cafe/shared/profile-opening-reference';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryCollection } from '@/components/memory/page/MemoryLibrary';
import {
  hasValidOriginalProposals,
  isEntityProposal,
  isProfileProposal,
} from '@/components/memory/page/original-proposal-read';
import { isEntityBrowse, isMemoryEventPage, isProfileBrowse } from '@/components/memory/page/owner-memory-read';
import {
  isPeoplePage,
  isPersonDetail,
  type PersonDetail,
  type PersonSources,
} from '@/components/memory/page/people-types';
import { readEvent } from '@/components/memory/page/read-memory-event';
import {
  canOpenTasteSource,
  isTasteBrowse,
  type TasteMemory,
  type TasteSource,
} from '@/components/memory/page/taste-types';
import { useMemoryRead } from '@/components/memory/page/use-memory-read';
import { parseUnifiedAttentionRead } from '@/components/shell/parse-unified-attention';
import { apiFetch } from '@/utils/api-client';
import { failRead, request, write } from './owner-api';
import { useMemoryExploreBindings } from './useMemoryExploreBindings';

const paths = {
  person: '/api/memory/people',
  profile: '/api/memory/profile',
  event: '/api/memory/events',
  entity: '/api/memory/entities',
  taste: '/api/memory/taste',
};
type Family = keyof typeof paths;
interface Entry {
  id?: string;
  personId?: string;
  eventId?: string;
  personRevision?: string;
  revision?: string;
  title?: string;
  displayName?: string;
  canonicalName?: string;
  type?: string;
  status?: string;
  aliases?: string[];
  summary?: string;
  content?: string;
  scene?: string;
  takeaway?: string | null;
  layer?: string;
  stance?: string;
  quotes?: string[];
  claims?: PersonDetail['claims'];
  interactions?: PersonDetail['interactions'];
  proposals?: (ProfileMemoryProposalView | EntityMemoryProposalView | PersonMemoryProposalView)[];
  correctionProposals?: (EventMemoryCorrectionProposalView | TasteMemoryCorrectionProposalView)[];
  takeawayCandidate?: TasteMemory['takeawayCandidate'];
  recall?: TasteMemory['recall'];
}
interface Page {
  entries?: Entry[];
  events?: Entry[];
  meta?: { nextOffset?: number; hasMore: boolean };
}
type Source = {
  status: MemoryOwnerSourceResponse['status'];
  sources: (MemoryOwnerSourceResponse['sources'][number] | PersonSources['sources'][number])[];
};
interface Detail {
  family: Family;
  id: string;
  entry: Entry & { revision: string };
  source: Source;
  usage?: ProfileUsageSummary;
  sources: Record<string, Source>;
  correctionCards: Record<string, { threadId: string; messageId: string }>;
}
function useMemoryPages(family: 'person' | 'event', limit: number, needed: boolean | number = true) {
  const [attempt, retry] = useState(0);
  const [read, setRead] = useState({ data: null as Page | null, loading: true, error: false });
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    setRead((previous) => ({ ...previous, loading: previous.data === null, error: false }));
    void (async () => {
      let offset = 0,
        page: Page,
        entries: Entry[] = [];
      do {
        const raw = await request<unknown>(
          `${paths[family]}?${new URLSearchParams({ limit: '20', offset: String(offset) })}`,
          { signal: abort.signal },
          { afterCurrentGet: attempt > 0 },
        );
        if (!(family === 'person' ? isPeoplePage(raw) : isMemoryEventPage(raw))) throw new Error('记忆列表读取不可用');
        page = raw as Page;
        entries = entries.concat(page.entries ?? page.events!);
        offset = page.meta?.nextOffset ?? 0;
      } while (page.meta?.hasMore && entries.length < limit);
      if (!abort.signal.aborted) setRead({ data: { ...page, entries }, loading: false, error: false });
    })().catch(() => {
      if (!abort.signal.aborted) setRead({ data: null, loading: false, error: true });
    });
    return () => abort.abort();
  }, [needed, family, limit, attempt]);
  return { ...read, retry: () => retry((n) => n + 1) };
}
export function useMemoryBindings(needed: (source: string) => boolean | number = () => false) {
  const detailRequest = useRef(0);
  const selection = useRef<{ family: Family | 'document'; id: string; collection?: string } | null>(null);
  const ui = useRef({
    view: 'all',
    cat: 'taste' as Family,
    q: '',
    sort: 'recent',
    win: 7,
    src: 'all',
    who: '',
    lib: 'pending',
    docLimits: {} as Record<string, number>,
    node: '',
    graphQ: '',
    rel: {} as Record<string, boolean>,
    targets: {} as Record<string, string>,
    searched: '',
    type: 'all',
    depth: 'summary',
    limit: 10,
    brakeRange: '30',
    brakeWord: 'all',
    brakeSel: '',
    recallSources: [] as { collection: string; name: string; title: string; content: string }[],
    recallAnchor: '',
    curation: null as { enabled: boolean } | null,
    limits: { taste: 20, profile: 20, person: 20, entity: 20, event: 20 },
  });
  const [, setAttempt] = useState(0),
    [detail, setDetail] = useState<Detail | null>(null),
    [document, setDocument] = useState<{ collection: string; anchor: string; title: string; content: string } | null>(
      null,
    ),
    [load, setLoad] = useState(''),
    [error, setError] = useState('');
  const edit = useRef<{
    family: Family;
    id: string;
    op: string;
    child?: string;
    recordKind: string;
    values: Record<string, unknown>;
    quotes: { id: string; value: string }[];
  } | null>(null);
  const pending = useRef<{ signature: string; requestId: string }>();
  const people = useMemoryPages('person', ui.current.limits.person, needed('reads.person'));
  const profiles = useMemoryRead(
    `${paths.profile}?limit=${ui.current.limits.profile}&offset=0`,
    isProfileBrowse,
    needed('reads.profile'),
  );
  const events = useMemoryPages('event', ui.current.limits.event, needed('reads.event'));
  const entities = useMemoryRead(
    `${paths.entity}?limit=${ui.current.limits.entity}&offset=0`,
    isEntityBrowse,
    needed('reads.entity'),
  );
  const taste = useMemoryRead(
    `${paths.taste}?limit=${ui.current.limits.taste}&offset=0`,
    isTasteBrowse,
    needed('reads.taste'),
  );
  const reads = { person: people, profile: profiles, event: events, entity: entities, taste };
  const explore = useMemoryExploreBindings(ui.current, (source) => needed('explore.' + source));
  const open = async (family: Family, id: string, revision?: string) => {
    selection.current = { family, id };
    ui.current.view = 'all';
    const ticket = ++detailRequest.current;
    setLoad('loading');
    setError('');
    setDetail(null);
    setDocument(null);
    try {
      const base = `${paths[family]}/${encodeURIComponent(id)}`;
      if ((family === 'profile' || family === 'taste') && !revision) {
        const page = await request<Page>(paths[family], undefined, { afterCurrentGet: true });
        revision = page.entries?.find((e) => e.id === id)?.revision;
        if (!revision) throw new Error('记忆版本尚未确认');
      }
      const q = revision ? `?revision=${encodeURIComponent(revision)}` : '';
      const raw =
        family === 'event'
          ? ((await readEvent(id, new AbortController().signal, true)) as Entry)
          : await request<Entry>(base + q, undefined, { afterCurrentGet: true });
      const ownerRevision = family === 'person' ? raw.personRevision : raw.revision;
      if (family === 'person' && !isPersonDetail(raw)) throw new Error('人物读取不可用');
      if (
        (family === 'profile' || family === 'entity') &&
        !hasValidOriginalProposals(
          { proposals: raw.proposals },
          family === 'profile' ? isProfileProposal : isEntityProposal,
        )
      )
        throw new Error('记忆提议读取不可用');
      if (!ownerRevision) throw new Error('记忆版本尚未确认');
      const entry: Entry & { revision: string } = { ...raw, revision: ownerRevision };
      const correctionCards: Detail['correctionCards'] = {};
      if (entry.correctionProposals?.length) {
        for (let offset = 0; ; offset += 20) {
          const response = await apiFetch(`/api/concierge/work/decisions?view=unified&offset=${offset}&limit=20`);
          if (!response.ok) break;
          const read = parseUnifiedAttentionRead(await response.json());
          if (!read || read.status === 'unavailable') break;
          for (const row of read.items) {
            const approval = row.approval;
            if (
              approval?.sourceFeatureId === (family === 'event' ? 'F321' : 'F221') &&
              approval.navigation?.state === 'anchored' &&
              entry.correctionProposals.some((proposal) => proposal.proposalId === approval.proposalId)
            )
              correctionCards[approval.proposalId] = approval.navigation.approvalCardRef;
          }
          if (!read.page.hasMore) break;
        }
      }
      const sources: Record<string, Source> = {};
      let source: Source = { sources: [], status: 'ready' },
        usage: Detail['usage'];
      if (family === 'person')
        await Promise.all([
          ...(entry.claims ?? []).map(async (c) => {
            sources[c.claimId] = await request<Source>(
              `${base}/source?${new URLSearchParams({ kind: 'claim', itemId: c.claimId })}`,
            );
          }),
          ...(entry.interactions ?? []).map(async (c) => {
            sources[c.eventId] = await request<Source>(
              `${base}/source?${new URLSearchParams({ kind: 'event', itemId: c.eventId })}`,
            );
          }),
        ]);
      else {
        if (family === 'taste') {
          const original = await request<TasteSource>(`${base}/source?revision=${encodeURIComponent(entry.revision)}`);
          source = {
            status: original.status,
            sources: canOpenTasteSource(original)
              ? [
                  {
                    kind: 'message',
                    title: original.title,
                    threadId: original.threadId,
                    messageId: original.messageId,
                    canOpen: true,
                  },
                ]
              : [],
          };
        } else
          source = await request<MemoryOwnerSourceResponse>(
            `${base}/source?revision=${encodeURIComponent(entry.revision)}`,
          );
        if (family === 'profile')
          usage = await request<ProfileUsageSummary>(`${base}/usage?revision=${encodeURIComponent(entry.revision)}`);
      }
      if (ticket !== detailRequest.current) throw new Error('记忆选择已变化');
      setDetail({ family, id, entry, source, usage, sources, correctionCards });
      setLoad('');
    } catch (e) {
      if (ticket === detailRequest.current) {
        setLoad('error');
        setError(e instanceof Error ? e.message : '记忆读取不可用');
      }
      failRead(e);
    }
  };
  const command = async (body: Record<string, unknown>, source: { family: Family; id: string } | null = detail) => {
    if (!source) throw new Error('请重新读取记忆');
    const { family, id } = source;
    const signature = JSON.stringify([family, id, body]);
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        requestId: body.action === 'hard_forget_person' ? 'person_forget_' + crypto.randomUUID() : crypto.randomUUID(),
      };
    const receipt = await write<{ action: string; outcome: string; memoryId?: string; revision?: string }>(
      `${paths[family]}/${encodeURIComponent(id)}/actions`,
      { ...body, requestId: pending.current.requestId },
    );
    if (receipt.action !== body.action || !['applied', 'replayed'].includes(receipt.outcome))
      throw new Error('记忆修改结果尚未确认');
    pending.current = undefined;
    reads[family].retry();
    if (String(body.action).startsWith('hard_forget')) {
      setDetail(null);
      selection.current = null;
    } else await open(family, id, receipt.revision);
  };
  const action = async (name: string, args: Record<string, string>): Promise<boolean> => {
    if (await explore.action(name, args)) return true;
    if (name === 'memoryRecordSave') {
      await command(
        { action: 'correct', expectedRevision: args.expectedRevision, patch: args.patch },
        { family: args.family as Family, id: args.id },
      );
      return true;
    }
    if (name === 'profileSave') {
      await command(
        { action: 'replace_content', expectedRevision: args.expectedRevision, content: args.content },
        { family: 'profile', id: args.kind === 'capsule' ? 'capsule' : args.id },
      );
      return true;
    }
    if (name === 'personClaimSave' || name === 'personEventSave') {
      await command(
        {
          action: name === 'personClaimSave' ? 'correct_claim' : 'amend_event',
          ...(name === 'personClaimSave' ? { claimId: args.claimId } : { eventId: args.eventId }),
          expectedRevision: args.expectedRevision,
          payload: args.payload,
        },
        { family: 'person', id: args.personId },
      );
      return true;
    }
    if (name === 'personForget') {
      await command(
        {
          action: 'hard_forget_person',
          expectedPersonRevision: args.expectedPersonRevision,
          confirmed: args.confirmed,
        },
        { family: 'person', id: args.personId },
      );
      return true;
    }
    if (name === 'memoryOpen') {
      if (args.family === 'document') {
        selection.current = { family: 'document', id: args.id, collection: args.collection };
        ui.current.view = 'all';
        const ticket = ++detailRequest.current;
        setDetail(null);
        setDocument(null);
        setLoad('loading');
        try {
          let collection = args.collection;
          ui.current.recallSources = [];
          ui.current.recallAnchor = args.id;
          if (!collection) {
            const { collections } = await request<{ collections: LibraryCollection[] }>('/api/memory/catalog');
            const sources = await Promise.all(
              collections
                .filter((collection) => collection.readStatus === 'ready' && collection.status === 'active')
                .map(async (collection) => {
                  const response = await apiFetch(
                    `/api/memory/search/document?${new URLSearchParams({ collection: collection.id, anchor: args.id })}`,
                  );
                  if (response.status === 404 || response.status === 403) return null;
                  if (!response.ok) throw new Error('文档来源读取失败');
                  const doc = (await response.json()) as { title: string; content: string };
                  return { ...doc, collection: collection.id, name: collection.name };
                }),
            );
            const found = sources.filter((source) => source !== null);
            if (ticket !== detailRequest.current) return true;
            if (!found.length) throw new Error('文档来源不可读取');
            if (found.length > 1) {
              ui.current.recallSources = found;
              setLoad('');
              return true;
            }
            const source = found[0];
            collection = source.collection;
            selection.current = { family: 'document', id: args.id, collection };
            setDocument({ ...source, collection, anchor: args.id });
            setLoad('');
            return true;
          }
          const source = await request<{ title: string; content: string }>(
            `/api/memory/search/document?${new URLSearchParams({ collection, anchor: args.id })}`,
          );
          if (ticket === detailRequest.current) {
            selection.current = { family: 'document', id: args.id, collection };
            setDocument({ ...source, collection, anchor: args.id });
            setLoad('');
          }
        } catch (e) {
          if (ticket === detailRequest.current) {
            setLoad('error');
            setError(e instanceof Error ? e.message : String(e));
          }
          failRead(e);
        }
        return true;
      }
      await open(args.family as Family, args.id, args.revision);
      return true;
    }
    if (name === 'memoryBrowse') {
      selection.current = null;
      detailRequest.current++;
      setDetail(null);
      setDocument(null);
      setLoad('');
      setError('');
      setAttempt((n) => n + 1);
      return true;
    }
    if ((name === 'refresh' && args.k === 'memory-owner') || name === 'cafeMemRetry') {
      const target = selection.current;
      if (target)
        await action('memoryOpen', {
          family: target.family,
          id: target.id,
          ...(target.collection ? { collection: target.collection } : {}),
        });
      else Object.values(reads).forEach((r) => r.retry());
      return true;
    }
    if (name === 'memoryCommand') {
      await command(JSON.parse(args.body));
      return true;
    }
    if (name === 'profileOpening') {
      if (
        !detail ||
        detail.family !== 'profile' ||
        detail.id !== args.id ||
        detail.entry.revision !== args.expectedRevision
      )
        throw new Error('请重新读取记忆');
      const entry = detail.entry;
      const opening = entry.layer === 'primer' ? readProfileOpeningReference(entry.content!) : null;
      if (!opening || !['edit', 'cancel'].includes(args.op)) throw new Error('memoryOwners.opening.invalid');
      const texts = args.texts as unknown;
      if (
        args.op === 'edit' &&
        (!Array.isArray(texts) ||
          texts.length !== opening.excerpts.length ||
          texts.some((value) => typeof value !== 'string'))
      )
        throw new Error('memoryOwners.opening.invalid');
      const reference =
        args.op === 'cancel'
          ? null
          : {
              asOf: args.asOf,
              excerpts: opening.excerpts.map((excerpt, index) => ({
                ...excerpt,
                text: (texts as string[])[index].trim(),
              })),
            };
      const content = updateProfileOpeningReference(entry.content!, reference);
      if (content === null) throw new Error('memoryOwners.opening.invalid');
      await command({ action: 'replace_content', expectedRevision: args.expectedRevision, content });
      return true;
    }
    if (name === 'cafeMemAct') {
      if (!detail) throw new Error('请重新读取记忆');
      const e = detail.entry;
      if (args.op === 'retire') {
        await command({ action: 'retire', expectedRevision: e.revision });
        return true;
      }
      if (args.op === 'confirm') {
        await command({
          action: 'confirm_takeaway',
          expectedRevision: e.revision,
          candidateRevision: e.takeawayCandidate?.candidateRevision,
          takeaway: e.takeawayCandidate?.takeaway,
        });
        return true;
      }
      if (args.op === 'forget') {
        await command(
          detail.family === 'person'
            ? { action: 'hard_forget_person', expectedPersonRevision: e.personRevision, confirmed: true }
            : { action: 'hard_forget', expectedRevision: e.revision, confirmed: true },
        );
        return true;
      }
      let recordKind: string = detail.family,
        values: Record<string, unknown> = {},
        quotes: { id: string; value: string }[] = [];
      if (detail.family === 'person') {
        if (args.op === 'claim') {
          const payload = e.claims!.find((c) => c.claimId === args.id)!.payload;
          if (payload.kind === 'redacted') throw new Error('判断已撤回');
          recordKind = payload.kind === 'reported_fact' ? 'fact' : 'assessment';
          values =
            payload.kind === 'reported_fact'
              ? {
                  predicate: payload.predicate,
                  value: typeof payload.value === 'string' ? payload.value : JSON.stringify(payload.value),
                }
              : { value: payload.statement, stance: payload.stance };
        } else {
          const event = e.interactions!.find((e) => e.eventId === args.id)!;
          values = { headline: event.headline, topic: event.importanceOrTopic, notes: event.uncertaintyNotes };
        }
      } else if (detail.family === 'profile') values = { content: splitProfileBody(e.content!).body };
      else if (detail.family === 'entity') values = { name: e.canonicalName, aliases: e.aliases, stance: e.stance };
      else if (detail.family === 'event') values = { summary: e.summary };
      else {
        values = { scene: e.scene, takeaway: e.takeaway };
        quotes = e.quotes!.map((value, i) => ({ id: 'mem-edit-quote' + i, value }));
      }
      edit.current = { family: detail.family, id: detail.id, op: args.op, child: args.id, recordKind, values, quotes };
      return true;
    }
    if (name === 'memoryEditSave') {
      if (!detail || !edit.current) throw new Error('请重新读取记忆');
      const editing = edit.current;
      const e = detail.entry,
        values = JSON.parse(args.values) as Record<string, string>;
      let body: Record<string, unknown>;
      if (edit.current.family === 'person' && edit.current.op === 'claim') {
        const c = e.claims!.find((c) => c.claimId === editing.child)!;
        body = {
          action: 'correct_claim',
          claimId: c.claimId,
          expectedRevision: c.revision,
          payload: {
            ...c.payload,
            ...(c.payload.kind === 'user_assessment' ? { statement: values.value, stance: values.stance } : values),
            ...(c.payload.kind === 'reported_fact' && values.value === JSON.stringify(c.payload.value)
              ? { value: c.payload.value }
              : {}),
          },
        };
      } else if (edit.current.family === 'person') {
        const event = e.interactions!.find((event) => event.eventId === editing.child)!;
        body = {
          action: 'amend_event',
          eventId: event.eventId,
          expectedRevision: event.revision,
          payload: {
            eventKind: event.eventKind,
            headline: values.headline,
            occurredAt: event.occurredAt,
            duration: event.duration,
            importanceOrTopic: values.topic,
            uncertaintyNotes: values.notes
              .split('\n')
              .map((v) => v.trim())
              .filter(Boolean),
          },
        };
      } else if (edit.current.family === 'profile')
        body = {
          action: 'replace_content',
          expectedRevision: e.revision,
          content: splitProfileBody(e.content!).prefix + values.content,
        };
      else {
        const patch: Record<string, unknown> = { ...values };
        if (edit.current.family === 'entity') {
          patch.canonicalName = values.name;
          delete patch.name;
          patch.aliases = values.aliases
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (edit.current.family === 'taste') {
          Object.keys(patch)
            .filter((k) => k.startsWith('quote'))
            .forEach((k) => {
              delete patch[k];
            });
          patch.quotes = editing.quotes.map((_, i) => values['quote' + i]);
          patch.takeaway = values.takeaway.trim() || null;
        }
        body = { action: 'correct', expectedRevision: e.revision, patch };
      }
      await command(body);
      edit.current = null;
      return true;
    }
    if (name === 'personClaimRetire') {
      const claim = detail?.entry.claims?.find((c) => c.claimId === args.id);
      if (!claim) throw new Error('判断已变化');
      await command({ action: 'retire_claim', claimId: claim.claimId, expectedRevision: claim.revision });
      return true;
    }
    return false;
  };
  const heldDetail = useMemo(
    () =>
      detail && {
        ...detail,
        openingReference:
          detail.family === 'profile' && detail.entry.layer === 'primer'
            ? readProfileOpeningReference(detail.entry.content!)
            : null,
      },
    [detail],
  );
  const rawData = useMemo(
    () => ({
      reads: Object.fromEntries(
        Object.entries(reads).map(([name, { data, loading, error }]) => [name, { data, loading, error }]),
      ),
      detail: heldDetail,
      document,
      load,
      error,
      explore: explore.data,
    }),
    [
      people.data,
      people.loading,
      people.error,
      profiles.data,
      profiles.loading,
      profiles.error,
      events.data,
      events.loading,
      events.error,
      entities.data,
      entities.loading,
      entities.error,
      taste.data,
      taste.loading,
      taste.error,
      heldDetail,
      document,
      load,
      error,
      explore.data,
    ],
  );
  return {
    state: ui.current,
    editor: edit,
    libraryDraft: explore.draft,
    action,
    data: rawData,
  };
}
