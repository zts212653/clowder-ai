import type { MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { MemoryEventDetail } from './MemoryEventDetail';
import { MemoryPersonDetail } from './MemoryPersonDetail';
import { MemoryReadState } from './MemoryReadState';
import { MemoryTaste } from './MemoryTaste';
import { MemoryTasteDetail } from './MemoryTasteDetail';
import type { MemorySourceTarget } from './memory-source-target';
import type { MemoryEvent } from './owner-memory-read';
import { isPersonDetail, type PersonDetail } from './people-types';
import { readEvent } from './read-memory-event';
import { isTasteMemory, type TasteMemory } from './taste-types';

type Target = Extract<MemorySourceTarget, { status: 'ready' }>;
type BoundMemory =
  | { family: 'taste'; data: TasteMemory }
  | { family: 'person'; data: PersonDetail }
  | { family: 'event'; data: MemoryEvent };
async function readMemoryTarget(target: Target, signal: AbortSignal): Promise<BoundMemory> {
  if (target.family === 'event')
    return { family: 'event', data: await readEvent(target.id, signal, true, target.revision) };
  const path =
    target.family === 'taste'
      ? `/api/memory/taste/${encodeURIComponent(target.id)}${target.revision === undefined ? '' : `?revision=${encodeURIComponent(target.revision)}`}`
      : `/api/memory/people/${encodeURIComponent(target.id)}${target.revision === undefined ? '' : `?deliveryRevision=${encodeURIComponent(target.revision)}`}`;
  const response = await apiFetch(path, { signal }, { afterCurrentGet: true });
  if (!response.ok) throw new Error(response.status === 409 ? 'memory_revision_changed' : 'memory_unavailable');
  const body: unknown = await response.json();
  if (
    target.family === 'taste' &&
    isTasteMemory(body) &&
    body.id === target.id &&
    (target.revision === undefined || body.revision === target.revision)
  )
    return { family: 'taste', data: body };
  if (target.family === 'person' && isPersonDetail(body) && body.personId === target.id)
    return { family: 'person', data: body };
  throw new Error('memory_unavailable');
}
export function MemorySourceDetail({ target }: { target: Target }) {
  const router = useRouter();
  const [following, follow] = useState(true);
  const [attempt, retry] = useState(0);
  const session = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const key = JSON.stringify([target.family, target.id, target.revision, attempt, session.generation]);
  const [read, setRead] = useState<{
    key: string;
    status: 'loading' | 'ready' | 'changed' | 'unavailable';
    memory?: BoundMemory;
  }>({ key: '', status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setRead({ key, status: 'loading' });
    readMemoryTarget(target, controller.signal)
      .then((memory) => {
        if (active) setRead({ key, status: 'ready', memory });
      })
      .catch((error: unknown) => {
        if (active)
          setRead({
            key,
            status:
              target.revision !== undefined && error instanceof Error && error.message === 'memory_revision_changed'
                ? 'changed'
                : 'unavailable',
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [key, target]);
  const status = read.key === key ? read.status : 'loading';
  const memory = read.key === key ? read.memory : undefined;
  const close = () => follow(false);
  const showCurrent = () => {
    if (target.revision === undefined) {
      retry((n) => n + 1);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    params.set('family', target.family);
    params.set('memoryId', target.id);
    params.delete('revision');
    router.replace(`/memory?${params}`, { scroll: false });
  };
  const applied = (receipt: MemoryOwnerActionReceipt) => {
    if (receipt.action === 'hard_forget') close();
    else showCurrent();
  };
  const navigationButton = 'shell-focusable text-compact text-cafe-accent underline';
  if (!following)
    return (
      <MemoryTaste
        initialFamily={target.family === 'person' ? 'people' : target.family === 'event' ? 'events' : 'taste'}
      />
    );
  const noun = { taste: '品味', person: '人物', event: '事件' }[target.family];
  return (
    <section className="space-y-4" aria-label={`${noun}来源`}>
      {status === 'loading' && (
        <MemoryReadState loading error={false} empty={false} noun="这条记忆" retry={() => retry((n) => n + 1)} />
      )}
      {(status === 'changed' || status === 'unavailable') && (
        <output className="block text-sm text-cafe-muted">
          {status === 'changed'
            ? '这条记忆在递来之后改过，现在的内容不是当时递来的那一版。'
            : '这条记忆暂时读不到，可能已被忘掉或已不可访问。'}
        </output>
      )}
      {status !== 'ready' && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {status === 'changed' && (
            <button type="button" onClick={showCurrent} className={navigationButton}>
              查看现在的版本
            </button>
          )}
          {status === 'unavailable' && (
            <button type="button" onClick={() => retry((n) => n + 1)} className={navigationButton}>
              重读记忆
            </button>
          )}
          <button type="button" onClick={close} className={navigationButton}>
            查看{noun}列表
          </button>
        </div>
      )}
      {memory?.family === 'taste' && (
        <MemoryTasteDetail
          entry={memory.data}
          close={close}
          reload={() => retry((n) => n + 1)}
          onApplied={applied}
          onDecisionApplied={showCurrent}
        />
      )}
      {memory?.family === 'person' && (
        <MemoryPersonDetail
          personId={target.id}
          deliveryRevision={target.revision}
          close={close}
          changed={() => retry((n) => n + 1)}
          onApplied={(kind) => {
            if (kind === 'hard_forget_person') close();
            else showCurrent();
          }}
        />
      )}
      {memory?.family === 'event' && (
        <MemoryEventDetail
          entry={memory.data}
          deliveryRevision={target.revision}
          close={close}
          reload={() => retry((n) => n + 1)}
          onApplied={applied}
          onDecisionApplied={showCurrent}
        />
      )}
    </section>
  );
}
