import { type ReactNode, useMemo } from 'react';
import type {
  CollectiveCollaborationProjection,
  CollectiveEventEnvelope,
  CollectiveMembership,
} from './client-types.js';
import { projectCollectiveHome } from './collective-home-model.js';
import { SharedArtifactLibrary } from './SharedArtifactLibrary.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function CollectiveHome({
  collective,
  events,
  collaboration,
  connection,
  error,
  onOpenNavigation,
  onOpenEvent,
}: {
  readonly collective: CollectiveMembership;
  readonly events: readonly CollectiveEventEnvelope[];
  readonly collaboration?: CollectiveCollaborationProjection;
  readonly connection: 'online' | 'offline';
  readonly error?: string;
  readonly onOpenNavigation: () => void;
  readonly onOpenEvent: (channelId: string, eventId: string) => void;
}) {
  const shared = useSharedArtifacts();
  const projection = useMemo(() => projectCollectiveHome(events, collaboration), [collaboration, events]);
  const loading = collaboration === undefined && !error;
  const unavailable = Boolean(error || connection === 'offline');
  const activityState: HomeSectionState = unavailable
    ? 'error'
    : loading
      ? 'loading'
      : projection.activities.length
        ? 'ready'
        : 'empty';
  const worksState: HomeSectionState = unavailable ? 'error' : loading ? 'loading' : 'unavailable';
  return (
    <section className="collective-home" data-testid="collective-home" aria-label={`${collective.name}首页`}>
      <div
        className="collective-home-hero"
        role="img"
        aria-label="几家人和猫在长桌旁共同创作，墨墨把毛笔递给新来的小猫"
      >
        <button
          type="button"
          className="mobile-navigation collective-home-navigation"
          data-testid="collective-home-navigation"
          aria-label="频道导航"
          onClick={onOpenNavigation}
        >
          ☰
        </button>
        <div className="collective-home-title">
          <h1>{collective.name}</h1>
          <p>人和猫在这里一起讨论、协作和交付。</p>
        </div>
      </div>
      <div className="collective-home-content">
        {unavailable && (
          <output className="collective-home-notice">
            暂时无法更新共同体首页。频道仍可打开；连接恢复后会自动重试。
          </output>
        )}
        {projection.partial && (
          <output className="collective-home-notice">部分内容暂不可读，只显示当前有权打开的公共记录。</output>
        )}
        <HomeSection title="最近动态" state={activityState} empty="这里还没有公共任务动态。">
          {projection.activities.map((activity) => (
            <button
              key={activity.id}
              type="button"
              className="collective-home-activity"
              data-testid="collective-home-activity"
              onClick={() => onOpenEvent(activity.channelId, activity.eventId)}
            >
              <span className="collective-home-actor">{activity.actorName}</span>
              <span>
                {activity.actionLabel} <strong>{activity.title}</strong>
              </span>
              <small>
                # {activity.channelId} · {formatHomeTime(activity.at)}
              </small>
            </button>
          ))}
        </HomeSection>
        {shared?.api ? (
          <SharedArtifactLibrary title="最近作品" />
        ) : (
          <HomeSection title="最近作品" state={worksState} empty="这里还没有公开作品。" />
        )}
      </div>
    </section>
  );
}

function HomeSection({
  title,
  state,
  empty,
  children,
}: {
  readonly title: string;
  readonly state: HomeSectionState;
  readonly empty: string;
  readonly children?: ReactNode;
}) {
  const fallback = {
    loading: '正在读取…',
    empty,
    error: '暂时无法读取；连接恢复后会自动重试。',
    unavailable: '作品列表还没有可靠的公开来源。',
  } as const;
  return (
    <section className="collective-home-section" aria-label={title} aria-busy={state === 'loading' || undefined}>
      <h2>{title}</h2>
      {state === 'ready' ? children : <p className="collective-home-empty">{fallback[state]}</p>}
    </section>
  );
}

type HomeSectionState = 'loading' | 'empty' | 'ready' | 'error' | 'unavailable';

function formatHomeTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
