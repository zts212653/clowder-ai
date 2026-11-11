'use client';
import type {
  AssetBindingDisposition,
  AssetCanonItem,
  AssetCanonRecord,
  ContentModificationRequest,
  WorkContextRecord,
  WorkReference,
  WorkspaceContentReviewView,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type CanonPage, canonCommand } from '@/components/workbench/content-review/asset-canon-client';
import { workspaceReviewRequestSource } from '@/components/workbench/content-review/workspace-modification-source';
import { failRead, write } from './owner-api';

interface History {
  history: { record: AssetCanonRecord; reason?: string; recordedAt?: string }[];
  nextAfter?: number;
}
interface CanonState {
  threadId: string;
  reference: WorkReference;
  load: string;
  context?: WorkContextRecord;
  page?: CanonPage;
  detail?: AssetCanonItem;
  history?: History;
  reason: string;
  target: string;
  bindingChoices: Record<string, string>;
}
export function useCanonBindings(
  threadId: string,
  workbench: { canon?: unknown },
  modify: (source: ContentModificationRequest['source'], prompt: string) => Promise<void>,
  needed: boolean | number = false,
) {
  const state = useRef<CanonState>();
  const readEpoch = useRef(0);
  const [selection, select] = useState<{ indexedVersionRef?: string } | null>(null);
  const [, changed] = useState(0),
    operations = useRef(new Map<string, string>());
  const command = <T>(input: Record<string, unknown>) => {
    const result = canonCommand<T>(state.current!.threadId, input);
    return /^(read|list)-/.test(String(input.action)) ? result.catch(failRead) : result;
  };
  const read = async (indexedVersionRef?: string, resetDraft = false) => {
    const s = state.current!,
      ticket = ++readEpoch.current;
    s.load = 'loading';
    changed((n) => n + 1);
    try {
      const context = await command<WorkContextRecord>({ action: 'read-context', reference: s.reference });
      const page = await command<CanonPage>({
        action: 'list-assets',
        purpose: 'used',
        reference: s.reference,
        metadataRevision: context.metadataRevision,
        verifyFiles: false,
        after: 0,
        limit: 50,
      });
      const selected = indexedVersionRef
        ? await Promise.all([
            command<AssetCanonItem>({ action: 'read-asset', indexedVersionRef }),
            command<History>({
              action: 'read-asset-history',
              indexedVersionRef,
              reference: s.reference,
              after: 0,
              limit: 30,
            }),
          ])
        : null;
      if (ticket !== readEpoch.current) return;
      s.context = context;
      s.page = page;
      if (selected) {
        [s.detail, s.history] = selected;
      }
      if (resetDraft) {
        s.reason = '';
        s.target = '';
        s.bindingChoices = {};
      }
      s.load = '';
    } catch (e) {
      if (ticket === readEpoch.current) s.load = 'error';
      throw e;
    } finally {
      if (ticket === readEpoch.current) changed((n) => n + 1);
    }
  };
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!needed || !selection) return;
    let active = true;
    const update = () => {
      if (!document.hidden)
        void reader.current(selection.indexedVersionRef).then(
          () => {
            if (active) window.clowderChat.dataOk('canon');
          },
          (error) => {
            if (active) window.clowderChat.dataError('canon', error);
          },
        );
    };
    update();
    const timer = setInterval(update, 30_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      active = false;
      ++readEpoch.current;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [needed, selection]);
  const mutate = async (input: Record<string, unknown>) => {
    const key = JSON.stringify(input);
    if (!operations.current.has(key)) operations.current.set(key, crypto.randomUUID());
    await command({ ...input, operationId: operations.current.get(key) });
    await read(state.current?.detail?.record.indexedVersionRef, true);
  };
  const dispositions = (): AssetBindingDisposition[] => {
    const s = state.current!,
      d = s.detail!;
    if (!s.reason.trim()) throw new Error('请填写理由');
    return d.bindings.map((b) => {
      const ref = s.bindingChoices[b.bindingRef];
      if (!ref) throw new Error('请决定原绑定如何处理');
      const target = s.page!.items.find((x) => x.record.indexedVersionRef === ref);
      return {
        bindingRef: b.bindingRef,
        expectedBindingRevision: b.bindingRevision,
        indexedVersionRef: ref === 'clear' ? null : ref,
        reason: s.reason,
        ...(target ? { expectedAssetRevision: target.record.revision } : {}),
      };
    });
  };
  const action = async (name: string, args: Record<string, string>) => {
    if (name === 'assetCanonRead') {
      if (args.reference) {
        state.current = {
          threadId,
          reference: args.reference as unknown as WorkReference,
          load: '',
          reason: '',
          target: '',
          bindingChoices: {},
        };
        workbench.canon = state.current;
      }
      if (!state.current) return true;
      select({ indexedVersionRef: args.indexedVersionRef });
      return true;
    }
    const s = state.current;
    if (name === 'assetCanonMore') {
      if (!s?.context || !s.page) throw new Error('素材来源尚未确认');
      if (args.history) {
        const page = await command<History>({
          action: 'read-asset-history',
          indexedVersionRef: s.detail!.record.indexedVersionRef,
          reference: s.reference,
          after: s.history!.nextAfter,
          limit: 30,
        });
        s.history = { ...page, history: [...s.history!.history, ...page.history] };
      } else {
        const page = await command<CanonPage>({
          action: 'list-assets',
          purpose: 'used',
          reference: s.reference,
          metadataRevision: s.context.metadataRevision,
          verifyFiles: false,
          after: s.page.nextAfter,
          snapshot: s.page.snapshot,
          limit: 50,
        });
        if (page.snapshot !== s.page.snapshot) throw new Error('素材目录已变化，请重新读取');
        s.page = { ...page, items: [...s.page.items, ...page.items] };
      }
      changed((n) => n + 1);
      return true;
    }
    if (name === 'canonAssetStatus' || name === 'assetCanonReplace' || name === 'assetCanonUpdate') {
      if (!s?.detail?.canWrite || !s.context || !s.page) throw new Error('素材当前不可修改');
      const from = s.detail.record,
        context = { reference: s.reference, metadataRevision: s.context.metadataRevision };
      if (name === 'canonAssetStatus')
        await mutate({
          action: 'set-asset-status',
          indexedVersionRef: from.indexedVersionRef,
          expectedRevision: from.revision,
          status: args.v,
          reason: s.reason,
          bindings: args.v === 'canonical' ? [] : dispositions(),
          context,
        });
      if (name === 'assetCanonReplace') {
        const to = s.page.items.find((x) => x.record.indexedVersionRef === s.target);
        if (!to?.canWrite) throw new Error('请选择可用的替代版本');
        await mutate({
          action: 'supersede-asset',
          mode: 'replace',
          fromVersionRef: from.indexedVersionRef,
          toVersionRef: to.record.indexedVersionRef,
          expectedFromRevision: from.revision,
          expectedToRevision: to.record.revision,
          reason: s.reason,
          bindings: dispositions(),
          context,
        });
      }
      if (name === 'assetCanonUpdate') {
        const update = s.page.updates?.find((u) => u.original.record.indexedVersionRef === from.indexedVersionRef);
        if (!update) throw new Error('更新来源已变化');
        if (args.decision === 'next') {
          const locator = from.version.locator;
          if (locator.kind !== 'workspace') throw new Error('该来源不能创建下一版');
          const view = await write<WorkspaceContentReviewView>('/api/workspace/content-reviews/prepare', {
            locator: { worktreeId: locator.rootId, path: locator.path },
            operationId: crypto.randomUUID(),
          });
          await modify(workspaceReviewRequestSource(view), `请基于「${from.name}」继续修改：${update.reason}`);
          return true;
        }
        if (!s.reason.trim()) throw new Error('请填写理由');
        await mutate({
          action: 'decide-asset-update',
          reference: s.reference,
          indexedVersionRef: from.indexedVersionRef,
          noticeScope: update.noticeScope,
          updateFingerprint: update.updateFingerprint,
          expectedDecisionRevision: update.decisionRevision,
          decision: 'keep_this_version',
          reason: s.reason,
        });
      }
      return true;
    }
    return false;
  };
  const value = state.current;
  const rawData = useMemo(
    () =>
      value && {
        threadId: value.threadId,
        reference: value.reference,
        load: value.load,
        context: value.context,
        page: value.page,
        detail: value.detail,
        history: value.history,
      },
    [value?.threadId, value?.reference, value?.load, value?.context, value?.page, value?.detail, value?.history],
  );
  return {
    action,
    state,
    data: rawData,
  };
}
