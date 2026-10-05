'use client';
import { type Dispatch, type SetStateAction, useState } from 'react';
import type { ParticipationView } from './use-collective-participation';

export const participationControl =
  'min-w-0 max-w-full rounded-lg border border-[var(--console-border-soft)] bg-[var(--cafe-surface-sunken)] px-3 py-2 text-sm text-cafe-primary';
const action =
  'rounded-lg bg-cafe-accent px-3 py-2 text-sm font-semibold text-[var(--cafe-accent-foreground)] disabled:opacity-50';

export function CollectiveCatParticipation({
  cat,
  view,
  channelId,
  channels,
  busy,
  mutate,
}: {
  readonly cat: ParticipationView['cats'][number];
  readonly view: ParticipationView;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly busy: boolean;
  readonly mutate: (path: string, body: Record<string, unknown>, method?: string) => Promise<boolean | undefined>;
}) {
  const binding = Object.values(view.bindings).find((item) => item.catId === cat.id);
  const [selectedChannels, setSelectedChannels] = useState(binding?.standingWork?.channelIds ?? [channelId]);
  const [standingHumans, setStandingHumans] = useState(binding?.standingWork?.requestingHumanIds ?? []);
  const [scopeAcknowledged, setScopeAcknowledged] = useState(false);
  const [standing, setStanding] = useState(Boolean(binding?.standingWork));
  const [expectedRevision] = useState(view.revision);
  const stale = expectedRevision !== view.revision;
  const previousScope = binding?.standingWork?.channelIds ?? [];
  const scopeChanged =
    standing &&
    Boolean(binding?.standingWork) &&
    (selectedChannels.length !== previousScope.length || selectedChannels.some((id) => !previousScope.includes(id)));
  const scopeUnconfirmed = scopeChanged && !scopeAcknowledged;
  const humans = participatingHumans(view, standingHumans);
  const allChannels = [...new Set([...channels, ...selectedChannels])];
  const save = (enabled: boolean) =>
    void mutate(
      '/participation',
      standingMutationBody({
        catId: cat.id,
        enabled,
        expectedRevision,
        channelId,
        selectedChannels,
        standing,
        standingHumans,
        standingWork: binding?.standingWork,
      }),
      'PUT',
    );
  return (
    <section
      className="space-y-4 border-t border-[var(--console-border-soft)] pt-4"
      aria-label={`${cat.displayName}的私人持续委托`}
    >
      <div>
        <h3 className="font-semibold">{cat.displayName} 的私人持续委托</h3>
        <p className="mt-1 text-xs leading-5 text-cafe-muted">公共参与不会自动授予私人执行；只有这里的明确选择会。</p>
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={standing} onChange={(event) => setStanding(event.target.checked)} />
        <span>允许指定成员的明确持续委托进入它的私人工作</span>
      </label>
      {standing && (
        <StandingScopeFields
          channels={allChannels}
          selectedChannels={selectedChannels}
          setSelectedChannels={setSelectedChannels}
          setScopeAcknowledged={setScopeAcknowledged}
          humans={humans}
          standingHumans={standingHumans}
          setStandingHumans={setStandingHumans}
          standingWork={binding?.standingWork}
        />
      )}
      {scopeChanged && (
        <label className="flex items-start gap-2 text-xs leading-5 text-cafe-secondary">
          <input
            type="checkbox"
            checked={scopeAcknowledged}
            onChange={(event) => setScopeAcknowledged(event.target.checked)}
          />
          <span>将私人授权调整为所选频道；确认后，所选成员的持续委托可在这些频道进入私人工作。</span>
        </label>
      )}
      {stale && (
        <p role="alert" className="text-xs text-conn-amber-text">
          参与设置已有更新，请重新选择这只猫后再保存。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={action}
          disabled={
            busy ||
            stale ||
            scopeUnconfirmed ||
            !cat.supported ||
            !selectedChannels.length ||
            (standing && !standingHumans.length)
          }
          onClick={() => save(true)}
        >
          {busy ? '保存中…' : '保存私人授权'}
        </button>
        {binding?.standingWork && (
          <button type="button" className={participationControl} disabled={busy || stale} onClick={() => save(false)}>
            撤回私人授权
          </button>
        )}
      </div>
    </section>
  );
}

function StandingScopeFields({
  channels,
  selectedChannels,
  setSelectedChannels,
  setScopeAcknowledged,
  humans,
  standingHumans,
  setStandingHumans,
  standingWork,
}: {
  readonly channels: readonly string[];
  readonly selectedChannels: readonly string[];
  readonly setSelectedChannels: Dispatch<SetStateAction<string[]>>;
  readonly setScopeAcknowledged: Dispatch<SetStateAction<boolean>>;
  readonly humans: ReadonlyMap<string, string>;
  readonly standingHumans: readonly string[];
  readonly setStandingHumans: Dispatch<SetStateAction<string[]>>;
  readonly standingWork?: ParticipationView['bindings'][string]['standingWork'];
}) {
  return (
    <div className="space-y-3 text-xs text-cafe-secondary">
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">允许来自哪些频道</legend>
        {channels.map((id) => (
          <label key={id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selectedChannels.includes(id)}
              onChange={() => {
                setSelectedChannels(toggle(selectedChannels, id));
                setScopeAcknowledged(false);
              }}
            />
            # {id}
          </label>
        ))}
      </fieldset>
      <div className="space-y-2">
        <p className="leading-5">仅接受你勾选的成员；家里的工作内容不会因此公开。</p>
        {[...humans].map(([id, name]) => (
          <label key={id} className="flex gap-2">
            <input
              type="checkbox"
              checked={standingHumans.includes(id)}
              onChange={() => setStandingHumans(toggle(standingHumans, id))}
            />
            {name}
          </label>
        ))}
        {!humans.size && <p>收到成员的请求后，可以在这里为其设置授权。</p>}
        {standingWork?.threadId ? (
          <a className="block underline" href={`/thread/${encodeURIComponent(standingWork.threadId)}`}>
            查看已授权的私人工作对话
          </a>
        ) : (
          <p>确认后，会为这只猫建立私人工作对话。</p>
        )}
        <p>
          {standingWork?.expiresAt
            ? `现有授权到期：${new Date(standingWork.expiresAt).toLocaleString()}`
            : '授权持续到你撤回。'}
        </p>
      </div>
    </div>
  );
}

function participatingHumans(view: ParticipationView, selected: readonly string[]) {
  const humans = new Map(
    view.requests.flatMap((item) =>
      item.event.actor.kind === 'human' ? [[item.event.actor.humanId, item.event.actor.displayName] as const] : [],
    ),
  );
  for (const id of selected) if (!humans.has(id)) humans.set(id, id);
  return humans;
}

function standingMutationBody(input: {
  readonly catId: string;
  readonly enabled: boolean;
  readonly expectedRevision: number;
  readonly channelId: string;
  readonly selectedChannels: readonly string[];
  readonly standing: boolean;
  readonly standingHumans: readonly string[];
  readonly standingWork?: ParticipationView['bindings'][string]['standingWork'];
}) {
  const body: Record<string, unknown> = {
    catId: input.catId,
    enabled: input.enabled,
    expectedRevision: input.expectedRevision,
    channelIds: input.selectedChannels.length ? input.selectedChannels : [input.channelId],
  };
  if (input.enabled && input.standing) {
    body.standingWork = {
      requestingHumanIds: input.standingHumans,
      expiresAt: input.standingWork?.expiresAt ?? null,
      ...(input.standingWork?.threadId ? { threadId: input.standingWork.threadId } : {}),
    };
  }
  return body;
}

function toggle(values: readonly string[], id: string) {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}
