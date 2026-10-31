import type {
  EvolutionPreparationReviewV1,
  EvolutionResolvedPreparationReviewV1,
  ExactAssetVersionRefV1,
} from '@cat-cafe/shared';
import { refIdentity } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { EvolutionPreparationVideo } from './EvolutionPreparationVideo';

const STATUS = {
  available: '已提供',
  planned: '计划中',
  unavailable: '暂不可用',
} as const;
const ACTIVITY = {
  running: '运行中',
  completed: '结果已完成',
  awaiting_publication: '材料待发布',
  failed: '运行失败',
} as const;

interface Props {
  review?: EvolutionPreparationReviewV1;
  loading: boolean;
  error?: string;
  mode: 'preparation' | 'candidates';
  retry: () => void;
  onSelectCandidate?: (version: ExactAssetVersionRefV1) => void;
}

function ReadFailure({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="mt-4">
      <p className="evolution-empty">{message}</p>
      <button type="button" className="evolution-link mt-2" onClick={retry}>
        重新读取材料
      </button>
    </div>
  );
}

function ResolvedMaterials({
  review,
  mode,
  onSelectCandidate,
}: {
  review: EvolutionResolvedPreparationReviewV1;
  mode: Props['mode'];
  onSelectCandidate?: Props['onSelectCandidate'];
}) {
  const groups = review.groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => (mode === 'candidates') === Boolean(item.candidateVersionRef)),
    }))
    .filter((group) => group.items.length > 0);
  if (!groups.length)
    return (
      <p className="evolution-empty mt-4">
        {mode === 'preparation' ? '目录中还没有准备材料。' : 'owner 尚未发布可阅读的候选。'}
      </p>
    );
  return (
    <div className="mt-5 space-y-6">
      <p className="evolution-publication-time">
        Owner 材料更新于 <time dateTime={review.updatedAt}>{new Date(review.updatedAt).toLocaleString('zh-CN')}</time>
      </p>
      {groups.map((group) => (
        <section key={refIdentity(group.groupRef)}>
          <h3 className="text-sm font-semibold text-cafe">{group.title}</h3>
          <div className="mt-3 space-y-3">
            {group.items.map((item) => (
              <article key={refIdentity(item.materialRef)} className="evolution-material">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {item.candidateVersionRef && onSelectCandidate ? (
                    <button
                      type="button"
                      className="evolution-link text-left text-sm"
                      onClick={() => onSelectCandidate(item.candidateVersionRef as ExactAssetVersionRefV1)}
                    >
                      {item.title}
                    </button>
                  ) : (
                    <h4 className="text-sm font-semibold text-cafe">{item.title}</h4>
                  )}
                  <span className="evolution-material-status" data-status={item.status}>
                    {STATUS[item.status]}
                  </span>
                </div>
                {item.activity && (
                  <div className="evolution-material-activity mt-2" data-activity-state={item.activity.state}>
                    <span>{ACTIVITY[item.activity.state]}</span>
                    <time dateTime={item.activity.updatedAt}>
                      {new Date(item.activity.updatedAt).toLocaleString('zh-CN')}
                    </time>
                    {item.activity.detail && <p>{item.activity.detail}</p>}
                  </div>
                )}
                <p className="mt-2 whitespace-pre-line text-sm leading-6 text-cafe-secondary">{item.summary}</p>
                {!!item.facts?.length && (
                  <dl className="evolution-material-facts mt-3">
                    {item.facts.map((fact, index) => (
                      <div key={`${index}:${fact.label}:${fact.value}`}>
                        <dt>{fact.label}</dt>
                        <dd>{fact.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {item.resources.map((resource) => {
                  const key = `${refIdentity(resource.sourceRef)}:${resource.label}`;
                  return (
                    <div key={key} className="evolution-material-resource">
                      {resource.media && (
                        <EvolutionPreparationVideo
                          programId={review.programRef.ownerStateRef}
                          label={resource.label}
                          media={resource.media}
                        />
                      )}
                      <EvolutionSource label={resource.label} source={resource.sourceRef} href={resource.ownerHref} />
                    </div>
                  );
                })}
              </article>
            ))}
          </div>
        </section>
      ))}
      {!!review.blockers.length && <p className="evolution-empty">部分材料仍有缺项；已发布内容继续保留可读。</p>}
    </div>
  );
}

export function EvolutionPreparationMaterials(props: Props) {
  if (props.loading && !props.review) return <p className="evolution-empty mt-4">正在读取准备材料…</p>;
  if (props.error) return <ReadFailure message={props.error} retry={props.retry} />;
  if (!props.review) return <ReadFailure message="准备材料暂时无法读取。" retry={props.retry} />;
  if (props.review.status === 'unknown') return <p className="evolution-empty mt-4">准备材料来源尚待接入。</p>;
  if (props.review.status === 'unpublished') return <p className="evolution-empty mt-4">owner 尚未发布准备材料。</p>;
  if (props.review.status === 'unavailable')
    return <ReadFailure message="准备材料暂时无法读取。" retry={props.retry} />;
  return <ResolvedMaterials review={props.review} mode={props.mode} onSelectCandidate={props.onSelectCandidate} />;
}
