'use client';

import { useState } from 'react';
import { AvatarImageWithFallback } from '@/components/AvatarImageWithFallback';
import { isCanonicalAvatarUrl } from '@/lib/avatar-url';
import { CollectiveToggleSwitch } from './CollectiveToggleSwitch';
import type { ParticipationView } from './use-collective-participation';
import { useCollectiveText } from './use-collective-text';

export function CollectiveParticipationRoster({
  view,
  channelIds,
  busy,
  enabled,
  mutate,
}: {
  readonly view: ParticipationView;
  readonly channelIds: readonly string[];
  readonly busy: boolean;
  readonly enabled: boolean;
  readonly mutate: (path: string, body: Record<string, unknown>, method?: string) => Promise<boolean | undefined>;
}) {
  const t = useCollectiveText();
  const [pendingDisable, setPendingDisable] = useState<string>();
  const includedCatCount = view.cats.filter(
    (cat) =>
      cat.configured && cat.supported && cat.eligible && !view.desiredParticipation.excludedCatIds.includes(cat.id),
  ).length;
  return (
    <section aria-label={t('我的猫')} className="space-y-3">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('我的猫')}</h3>
          <p className="mt-1 text-xs text-cafe-muted">
            {t('家里')} {view.cats.length} {t('只')} · {includedCatCount} {t('只在这里')}
          </p>
        </div>
      </header>
      <div className="divide-y divide-[var(--console-border-soft)] rounded-xl bg-[var(--cafe-surface-sunken)] px-3">
        {view.cats.map((cat) => {
          const name = cat.nickname?.trim() || cat.displayName;
          const included = !view.desiredParticipation.excludedCatIds.includes(cat.id);
          const interactive = enabled && cat.configured && cat.supported && cat.eligible;
          const confirming = pendingDisable === cat.id;
          const status = participationStatus(view, cat);
          const statusId = `collective-cat-status-${cat.id}`;
          const participating = included && cat.configured && cat.supported && cat.eligible;
          return (
            <div key={cat.id} data-testid="collective-cat-row">
              <div className="grid min-h-16 grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 py-2.5">
                <AvatarImageWithFallback
                  src={ownerAvatar(cat.avatar)}
                  alt=""
                  className="h-9 w-9 rounded-full object-cover"
                />
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <strong className="text-sm font-medium text-cafe-primary">{name}</strong>
                    <span className="break-all text-xs text-cafe-muted">@{cat.id}</span>
                  </div>
                  {catIdentity(cat) && <p className="text-xs text-cafe-secondary">{catIdentity(cat)}</p>}
                  <p id={statusId} className="mt-0.5 text-xs text-cafe-muted">
                    {t(status)}
                  </p>
                </div>
                <div className="flex items-center">
                  <CollectiveToggleSwitch
                    label={`${name}（@${cat.id}）${t('参与这个共同体')}`}
                    describedBy={statusId}
                    checked={participating}
                    disabled={busy || !interactive}
                    onChange={(next) => {
                      if (!next) {
                        setPendingDisable(cat.id);
                        return;
                      }
                      void updateGlobalParticipation(view, cat.id, true, channelIds, mutate);
                    }}
                  />
                </div>
              </div>
              {confirming && (
                <div className="mb-3 rounded-lg bg-[var(--console-card-bg)] p-3 text-xs leading-5 text-cafe-secondary">
                  <p>
                    {t('关掉以后')}，{name}
                    {t('不再收到这个共同体的新请求，也不在这里发言；已经接下的工作照实际情况留在「日程」里。')}
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--console-border-soft)] px-3 py-1.5"
                      onClick={() =>
                        void updateGlobalParticipation(view, cat.id, false, channelIds, mutate).then((updated) => {
                          if (updated) setPendingDisable(undefined);
                        })
                      }
                    >
                      {t('关掉')}
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-[var(--console-border-soft)] px-3 py-1.5"
                      onClick={() => setPendingDisable(undefined)}
                    >
                      {t('取消')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!view.cats.length && <p className="py-4 text-sm text-cafe-muted">{t('家里还没有成员。')}</p>}
      </div>
    </section>
  );
}

function catIdentity(cat: ParticipationView['cats'][number]) {
  return [cat.breedDisplayName, cat.variantLabel ?? cat.defaultModel].filter(Boolean).join(' · ');
}

function participationStatus(view: ParticipationView, cat: ParticipationView['cats'][number]) {
  if (!cat.configured) return '家里已停用';
  if (!cat.supported || !cat.eligible) return '这种接入方式暂时不能参与';
  if (view.desiredParticipation.excludedCatIds.includes(cat.id)) return '未参与';
  const routedChannels = Object.keys(view.channelRoutes);
  const excludedFromEveryChannel =
    routedChannels.length > 0 &&
    routedChannels.every((channelId) =>
      view.desiredParticipation.channelOverrides[channelId]?.excludedCatIds.includes(cat.id),
    );
  if (view.published && excludedFromEveryChannel) return '已开启 · 目前没有加入任何频道';
  const joined = Object.values(view.channelRoutes).some((channel) => channel.participants[cat.id]);
  return joined && view.published ? '已加入' : '正在加入…';
}

function ownerAvatar(value?: string) {
  return value?.startsWith('/avatars/') ||
    value?.startsWith('/uploads/') ||
    (value?.startsWith('/api/cats/') && isCanonicalAvatarUrl(value))
    ? value
    : null;
}

async function updateGlobalParticipation(
  view: ParticipationView,
  catId: string,
  included: boolean,
  channelIds: readonly string[],
  mutate: (path: string, body: Record<string, unknown>, method?: string) => Promise<boolean | undefined>,
) {
  const excludedCatIds = new Set(view.desiredParticipation.excludedCatIds);
  if (included) excludedCatIds.delete(catId);
  else excludedCatIds.add(catId);
  return mutate(
    '/participation/policy',
    {
      expectedRevision: view.revision,
      channelIds,
      policy: { ...view.desiredParticipation, excludedCatIds: [...excludedCatIds].sort() },
    },
    'PUT',
  );
}
