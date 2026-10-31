'use client';

import type { ParticipationView } from './use-collective-participation';
import { useCollectiveText } from './use-collective-text';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export function CollectiveChannelListeningSettings({
  state,
  view,
  channelId,
  enabled,
  onSelectCats,
}: {
  readonly state: CollectiveWorkPolicyState;
  readonly view: ParticipationView;
  readonly channelId: string;
  readonly enabled: boolean;
  readonly onSelectCats?: () => void;
}) {
  const t = useCollectiveText();
  const participants = view.cats.filter((cat) => view.channelRoutes[channelId]?.participants[cat.id]);
  const current = state.listening?.channelListening[channelId];
  const selected = participants.find((cat) => cat.id === current?.dutyCatId);
  const fallback = selected ?? participants[0];
  const disabled = !enabled || state.busy || !state.listening;
  return (
    <section aria-label={`# ${channelId} 的消息回应`} className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold">{t('我家的猫在这个频道')}</h3>
        <p className="mt-1 text-xs text-cafe-muted">{t('仅自己可见')}</p>
      </header>
      <fieldset className="space-y-2" disabled={disabled}>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="mt-0.5 h-4 w-4 shrink-0 appearance-none rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] checked:border-4 checked:border-cafe-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            name="collective-listening"
            checked={Boolean(state.listening) && current?.mode !== 'all'}
            onChange={() => void state.listen(channelId, 'mentions')}
          />
          {t('仅在被 @ 时回应')}
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="radio"
            className="mt-0.5 h-4 w-4 shrink-0 appearance-none rounded-full border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] checked:border-4 checked:border-cafe-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            name="collective-listening"
            checked={current?.mode === 'all'}
            disabled={disabled || !participants.length}
            onChange={() => fallback && void state.listen(channelId, 'all', fallback.id)}
          />
          {t('留意所有消息')}
        </label>
      </fieldset>
      <ListeningReadState loaded={Boolean(state.listening)} error={state.error} onRetry={() => void state.read()} />
      {!participants.length ? (
        <p className="text-xs text-cafe-muted">
          {t('先让一只猫加入这个频道。')}
          {onSelectCats && (
            <button type="button" className="ml-1 underline" onClick={onSelectCats}>
              {t('选择猫…')}
            </button>
          )}
        </p>
      ) : current?.mode === 'all' && !selected ? (
        <label className="grid gap-1 text-xs text-cafe-muted">
          {t('原来的猫已不再参与')}
          <select
            aria-label={t('换一只留意消息的猫')}
            className="h-9 w-full appearance-none rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe-primary disabled:opacity-50"
            value=""
            disabled={disabled}
            onChange={(event) => void state.listen(channelId, 'all', event.target.value)}
          >
            <option value="" disabled>
              {t('换一只…')}
            </option>
            {participants.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.nickname ?? cat.displayName} · @{cat.id}
              </option>
            ))}
          </select>
        </label>
      ) : current?.mode === 'all' && selected ? (
        <label className="grid gap-1 text-xs text-cafe-secondary">
          <span>{t('由谁留意频道消息')}</span>
          <select
            aria-label={t('换一只留意消息的猫')}
            className="h-9 w-full appearance-none rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] px-3 text-sm text-cafe-primary disabled:opacity-50"
            value={selected.id}
            disabled={disabled}
            onChange={(event) => void state.listen(channelId, 'all', event.target.value)}
          >
            {participants.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.nickname ?? cat.displayName} · @{cat.id}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </section>
  );
}

function ListeningReadState({
  loaded,
  error,
  onRetry,
}: {
  readonly loaded: boolean;
  readonly error?: string;
  readonly onRetry: () => void;
}) {
  const t = useCollectiveText();
  if (!loaded && !error)
    return (
      <p aria-live="polite" className="text-xs text-cafe-muted">
        {t('正在读取频道设置…')}
      </p>
    );
  if (!error) return null;
  return (
    <p role="alert" className="text-xs text-conn-red-text">
      {t('读不到频道设置。')}
      <button type="button" className="underline" onClick={onRetry}>
        {t('重试')}
      </button>
    </p>
  );
}
