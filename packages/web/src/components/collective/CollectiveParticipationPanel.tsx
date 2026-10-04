'use client';
import { useMemo, useState } from 'react';
import { AvatarImageWithFallback } from '@/components/AvatarImageWithFallback';
import { CollectiveCatParticipation, participationControl } from './CollectiveCatParticipation';
import { CollectiveWorkPolicySettings } from './CollectiveWorkPolicySettings';
import { CollectiveWorkRequests } from './CollectiveWorkRequests';
import {
  type ParticipationView,
  useCollectiveAutoReconcile,
  useCollectiveParticipation,
} from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export type { ParticipationView } from './use-collective-participation';

export function CollectiveParticipationPanel({
  connectionId,
  channelId,
  channels,
}: {
  readonly connectionId: string;
  readonly channelId: string;
  readonly channels: readonly string[];
}) {
  const state = useCollectiveParticipation(connectionId);
  const channelIds = useMemo(() => [...new Set([...channels, channelId])], [channelId, channels]);
  useCollectiveAutoReconcile(state, channelIds);
  return <CollectiveParticipationContent state={state} channelId={channelId} channels={channels} />;
}

export function CollectiveParticipationContent({
  state,
  channelId,
  channels,
  canParticipate = true,
  workPolicy,
}: {
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly canParticipate?: boolean;
  readonly workPolicy?: CollectiveWorkPolicyState;
}) {
  const { view, busy, error, notice, mutate, reload } = state;
  const [catId, setCatId] = useState<string>();
  const [selectionVersion, setSelectionVersion] = useState(0);
  const cat = view?.cats.find((item) => item.id === catId);
  const channelIds = useMemo(() => [...new Set([...channels, channelId])].sort(), [channelId, channels]);
  const requests =
    view?.requests.filter(
      (request) =>
        request.event.location?.channelId === channelId ||
        (!request.event.location &&
          request.event.target.kind === 'channel' &&
          request.event.target.channelId === channelId),
    ) ?? [];
  return (
    <div className="space-y-5">
      {view && workPolicy && (
        <CollectiveWorkPolicySettings state={workPolicy} view={view} channelId={channelId} enabled={canParticipate} />
      )}
      {!canParticipate && (
        <p className="text-xs text-cafe-muted">连接已撤销，原有私人工作仍然保留。重新配对后可以再安排参与。</p>
      )}
      {view && (
        <section aria-label="本频道的伙伴">
          <h3 className="text-sm font-semibold">带上这台 Café 的伙伴</h3>
          <p className="mt-1 text-xs leading-5 text-cafe-secondary">
            可参与的伙伴默认出现在本频道成员栏，其他成员可以点名请求回应。先看清名单；不想带来的猫可在下方排除。
          </p>
          <div className="mt-3 space-y-2">
            {view.cats.map((item) => (
              <div key={item.id} className="flex gap-3 rounded-xl border border-[var(--console-border-soft)] p-3">
                <AvatarImageWithFallback
                  src={ownerAvatar(item.avatar)}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-full object-cover"
                />
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.displayName}</span>
                  {item.defaultModel && <span className="block text-xs text-cafe-muted">{item.defaultModel}</span>}
                  {item.roleDescription && (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-cafe-secondary">{item.roleDescription}</p>
                  )}
                  <span className="mt-1 block text-xs text-cafe-muted">{catStatus(view, item, channelId)}</span>
                </div>
              </div>
            ))}
            {!view.cats.length && <p className="text-sm text-cafe-muted">这台 Café 还没有登记伙伴。</p>}
          </div>
          <p className="mt-3 text-xs leading-5 text-cafe-muted">
            名单表示参与资格，不代表猫现在在线。回到频道点名后，以消息的接收和回复状态为准。
          </p>
        </section>
      )}
      <section className="border-t border-[var(--console-border-soft)] pt-4" aria-label="这段讨论带回的请求与工作">
        <h3 className="mb-3 text-sm font-semibold">这段讨论带回的请求与工作</h3>
        {!view ? (
          <p className="text-xs leading-5 text-cafe-muted">{error ?? '正在读取这段讨论的工作…'}</p>
        ) : !requests.length ? (
          <p className="text-xs leading-5 text-cafe-muted">本频道还没有带回的工作。</p>
        ) : (
          <CollectiveWorkRequests
            requests={requests}
            tasks={view.tasks}
            busy={busy}
            mutate={async (path, body) => {
              await mutate(path, body);
            }}
            control={participationControl}
          />
        )}
      </section>
      {view && (
        <details className="border-t border-[var(--console-border-soft)] pt-4 text-xs text-cafe-secondary">
          <summary className="cursor-pointer font-medium">管理参与伙伴</summary>
          <p className="mt-3 leading-5">具备公共参与资格的伙伴会自动加入；这里只设置不参与的例外。</p>
          <div className="mt-3 space-y-3">
            {view.cats.map((item) => {
              const globallyExcluded = view.desiredParticipation.excludedCatIds.includes(item.id);
              const channelExcluded =
                view.desiredParticipation.channelOverrides[channelId]?.excludedCatIds.includes(item.id) ?? false;
              const included = !globallyExcluded && !channelExcluded;
              return (
                <div key={item.id} className="rounded-xl border border-[var(--console-border-soft)] p-3">
                  <label className="flex items-center gap-2 text-sm text-cafe-primary">
                    <input
                      type="checkbox"
                      checked={included && item.eligible}
                      disabled={busy || !canParticipate || !item.eligible || globallyExcluded}
                      onChange={(event) =>
                        void mutate(
                          '/participation/policy',
                          {
                            expectedRevision: view.revision,
                            channelIds,
                            policy: channelPolicy(view, item.id, channelId, event.target.checked),
                          },
                          'PUT',
                        )
                      }
                    />
                    {item.displayName} 参与 # {channelId}
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={participationControl}
                      disabled={busy || !canParticipate}
                      onClick={() =>
                        void mutate(
                          '/participation/policy',
                          {
                            expectedRevision: view.revision,
                            channelIds,
                            policy: globalPolicy(view, item.id, globallyExcluded),
                          },
                          'PUT',
                        )
                      }
                    >
                      {globallyExcluded ? '恢复默认范围' : '所有频道都不带它'}
                    </button>
                    {item.eligible && (
                      <button
                        type="button"
                        className={participationControl}
                        onClick={() => {
                          setCatId(item.id);
                          setSelectionVersion((value) => value + 1);
                        }}
                      >
                        设置 {item.displayName} 的私人持续委托
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {cat && (
            <CollectiveCatParticipation
              key={`${cat.id}:${selectionVersion}`}
              cat={cat}
              view={view}
              channelId={channelId}
              channels={channelIds}
              busy={busy || !canParticipate}
              mutate={mutate}
            />
          )}
        </details>
      )}
      {error && (
        <div role="alert" className="text-xs text-conn-red-text">
          <p>{error}</p>
          <button type="button" className="mt-2 underline" onClick={() => void reload()}>
            重新读取
          </button>
        </div>
      )}
      {notice && <output className="block text-xs leading-5 text-cafe-secondary">{notice}</output>}
    </div>
  );
}

function ownerAvatar(value?: string) {
  return value?.startsWith('/avatars/') || value?.startsWith('/uploads/') ? value : null;
}

function catStatus(view: ParticipationView, cat: ParticipationView['cats'][number], channelId: string) {
  const catId = cat.id;
  if (!cat.configured) return '已不在当前 Café 配置中';
  if (!cat.eligible) return '暂时无法公共参与';
  if (view.desiredParticipation.excludedCatIds.includes(catId)) return '已从全部频道排除';
  if (view.desiredParticipation.channelOverrides[channelId]?.excludedCatIds.includes(catId)) return '已从本频道排除';
  if (view.channelRoutes[channelId]?.participants[catId] && view.published)
    return view.standingInterests[channelId]?.[catId]?.status === 'active'
      ? '正在本频道参与 · 值守回应请求'
      : '正在本频道参与';
  return '等待自动接入';
}

function channelPolicy(
  view: NonNullable<ReturnType<typeof useCollectiveParticipation>['view']>,
  catId: string,
  channelId: string,
  included: boolean,
) {
  const exclusions = new Set(view.desiredParticipation.channelOverrides[channelId]?.excludedCatIds ?? []);
  if (included) exclusions.delete(catId);
  else exclusions.add(catId);
  const channelOverrides = { ...view.desiredParticipation.channelOverrides };
  if (exclusions.size) channelOverrides[channelId] = { excludedCatIds: [...exclusions].sort() };
  else delete channelOverrides[channelId];
  return { ...view.desiredParticipation, channelOverrides };
}

function globalPolicy(
  view: NonNullable<ReturnType<typeof useCollectiveParticipation>['view']>,
  catId: string,
  currentlyExcluded: boolean,
) {
  const exclusions = new Set(view.desiredParticipation.excludedCatIds);
  if (currentlyExcluded) exclusions.delete(catId);
  else exclusions.add(catId);
  return { ...view.desiredParticipation, excludedCatIds: [...exclusions].sort() };
}
