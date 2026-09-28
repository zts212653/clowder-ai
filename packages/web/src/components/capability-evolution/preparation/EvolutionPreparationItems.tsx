import type { EvolutionPreparationBodyV1 } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { EvolutionPreparationChoice, preparationDecider, preparationDecisionLabel } from './EvolutionPreparationChoice';
import type {
  EvolutionPreparationActivityProjection,
  EvolutionPreparationSubmissionProjection,
} from './evolution-preparation-resource';
import { PreparationDetails } from './PreparationDetails';

type PreparationItem = Extract<EvolutionPreparationBodyV1, { kind: 'object_map' }>['items'][number];

const MODIFIABILITY = {
  unknown: '待核实',
  modifiable: '可改',
  partially_modifiable: '部分可改',
  not_modifiable_this_round: '本轮不可改',
  not_applicable: '不适用',
} as const;

const ACTIVITY = {
  active: '准备中',
  terminal: '运行已结束',
  unknown: '工作状态待核实',
  identity_invalid: '工作身份未通过核验',
  superseded_by_submission: '已由后续记录承接',
} as const;

function ItemActivity({ activity }: { activity?: EvolutionPreparationActivityProjection }) {
  const visible = activity;
  return (
    <div className="evolution-preparation-state-column" data-progress-state={visible?.state ?? 'unassigned'}>
      <span className="evolution-preparation-state-label">当前活动</span>
      <span className="evolution-preparation-state-value">
        {visible?.spinning && <span aria-hidden="true" data-preparation-spinner="true" />}
        {visible ? ACTIVITY[visible.state] : '未见条目级活动'}
      </span>
      {visible?.catId && <span className="evolution-preparation-state-note">{visible.catId}</span>}
    </div>
  );
}

export function EvolutionPreparationItems({
  items,
  activities,
  submission,
  historical = false,
}: {
  items: PreparationItem[];
  activities: EvolutionPreparationActivityProjection[];
  submission?: EvolutionPreparationSubmissionProjection;
  historical?: boolean;
}) {
  return (
    <div className="evolution-preparation-items">
      {items.map((item) => {
        const activity = activities.find((candidate) => candidate.itemId === item.itemId);
        return (
          <PreparationDetails
            programId={submission?.submission?.programId ?? ''}
            readingKey={`${submission?.ref.version}:item:${item.itemId}`}
            key={item.itemId}
            className="evolution-preparation-item"
            data-preparation-item={item.itemId}
          >
            <summary>
              <span className="evolution-preparation-item-identity">
                <span className="evolution-preparation-kicker">{item.category ?? '类别尚未提交'}</span>
                <span className="evolution-preparation-item-title">{item.label}</span>
              </span>
              <span className="evolution-preparation-state-column">
                <span className="evolution-preparation-state-label">猫的建议</span>
                <span className="evolution-preparation-state-value">
                  {item.recommendation?.summary ?? '尚未提交建议'}
                </span>
              </span>
              <span className="evolution-preparation-state-column">
                <span className="evolution-preparation-state-label">{historical ? '历史选择' : '本轮决定'}</span>
                <span className="evolution-preparation-state-value">{preparationDecisionLabel(item, submission)}</span>
                <span className="evolution-preparation-state-note">谁定：{preparationDecider(item, submission)}</span>
              </span>
              <span className="evolution-preparation-item-states">
                <span className="evolution-preparation-state-column">
                  <span className="evolution-preparation-state-label">已有工作</span>
                  <span className="evolution-preparation-state-value">{historical ? '历史提交' : '已有提交'}</span>
                  <span className="evolution-preparation-state-note">
                    {item.existingWork ? '含工作与产物来源' : '工作细节尚未单列'}
                  </span>
                </span>
                {!historical && <ItemActivity activity={activity} />}
                <span className="evolution-preparation-state-column" data-modifiability={item.modifiability.state}>
                  <span className="evolution-preparation-state-label">适用边界</span>
                  <span className="evolution-preparation-state-value">{MODIFIABILITY[item.modifiability.state]}</span>
                </span>
              </span>
            </summary>
            <div className="evolution-preparation-item-body">
              <EvolutionPreparationChoice item={item} submission={submission} historical={historical} />
              <dl className="evolution-preparation-facts">
                <div>
                  <dt>具体范围</dt>
                  <dd>{item.scope}</dd>
                </div>
                <div>
                  <dt>为何关注</dt>
                  <dd>{item.why}</dd>
                </div>
                <div>
                  <dt>边界依据</dt>
                  <dd>{item.modifiability.reason}</dd>
                </div>
                {!historical && activity && (
                  <div>
                    <dt>当前动作</dt>
                    <dd>
                      {activity.focus} ·{' '}
                      <time dateTime={activity.occurredAt}>
                        {new Date(activity.occurredAt).toLocaleString('zh-CN')}
                      </time>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>下一步</dt>
                  <dd>{item.nextAction}</dd>
                </div>
              </dl>
              {item.sourceRefs.map((source, index) => (
                <EvolutionSource
                  key={`${source.ownerFeatureId}:${source.ownerStateRef}:${index}`}
                  label="调查来源"
                  source={source}
                />
              ))}
              {item.modifiability.basisRefs.map((source, index) => (
                <EvolutionSource
                  key={`${source.ownerFeatureId}:${source.ownerStateRef}:${index}`}
                  label="边界来源"
                  source={source}
                />
              ))}
            </div>
          </PreparationDetails>
        );
      })}
    </div>
  );
}
