import type { EvolutionPreparationBodyV1 } from '@cat-cafe/shared';
import { jumpToApprovalAnchor } from '@/components/ApprovalProvenanceLinks';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { EvolutionPreparationSubmissionProjection } from './evolution-preparation-resource';

type Item = Extract<EvolutionPreparationBodyV1, { kind: 'object_map' }>['items'][number];
export const CHOICE = { explore: '纳入探索', fixed: '保持固定', excluded: '暂不纳入', undecided: '尚未决定' } as const;

export function preparationDecisionLabel(item: Item, submission?: EvolutionPreparationSubmissionProjection) {
  const decision = item.decision;
  if (!decision) return '尚未决定';
  if (decision.state !== 'undecided' && 'input' in decision.responsibility) {
    const coordinate = decision.responsibility.input;
    const input = submission?.inputSources?.find(
      (source) =>
        source.itemId === item.itemId &&
        source.messageId === coordinate.messageId &&
        source.threadId === coordinate.threadId,
    );
    if (input?.status !== 'available') return '决定来源待核实';
  }
  return CHOICE[decision.state];
}

export function preparationDecider(item: Item, submission?: EvolutionPreparationSubmissionProjection) {
  const decision = item.decision;
  if (!decision) return '待核实';
  if (decision.state === 'undecided')
    return { cat: '猫继续判断', human: '人的价值 / 预算选择', unknown: '待核实' }[decision.neededFrom];
  return decision.responsibility.kind === 'human'
    ? '人类原输入'
    : `${submission?.authorCatId ?? '提交猫'} · ${decision.responsibility.basis === 'technical' ? '技术决定' : '沿已有授权'}`;
}

export function EvolutionPreparationChoice({
  item,
  submission,
  historical = false,
}: {
  item: Item;
  submission?: EvolutionPreparationSubmissionProjection;
  historical?: boolean;
}) {
  const decision = item.decision;
  const input = submission?.inputSources?.find((source) => source.itemId === item.itemId);
  return (
    <div className="evolution-preparation-choice">
      {historical && <p className="evolution-preparation-alert">历史准备选择 · 不代表本轮当前决定</p>}
      <dl className="evolution-preparation-facts">
        <div>
          <dt>猫的建议</dt>
          <dd>{item.recommendation?.summary ?? '尚未提交建议'}</dd>
        </div>
        {item.recommendation && (
          <div>
            <dt>建议依据</dt>
            <dd>{item.recommendation.reason}</dd>
          </div>
        )}
        <div>
          <dt>{historical ? '当时的选择' : '本轮决定'}</dt>
          <dd>{preparationDecisionLabel(item, submission)}</dd>
        </div>
        {decision && (
          <div>
            <dt>决定理由</dt>
            <dd>{decision.reason}</dd>
          </div>
        )}
        <div>
          <dt>谁定</dt>
          <dd>{preparationDecider(item, submission)}</dd>
        </div>
        <div>
          <dt>已有工作</dt>
          <dd>{item.existingWork?.summary ?? '本项已有准备提交；具体工作与产物尚未单独说明。'}</dd>
        </div>
      </dl>
      {decision?.state === 'undecided' && decision.neededFrom === 'human' && (
        <p>这项价值或预算取舍仍待人的真实输入；技术准备可沿已有授权继续。</p>
      )}
      {input && (
        <div className="evolution-preparation-input-source">
          {input.status === 'available' ? (
            <>
              <span>
                人类原输入 ·{' '}
                <time dateTime={input.occurredAt}>
                  {input.occurredAt && new Date(input.occurredAt).toLocaleString('zh-CN')}
                </time>
              </span>
              <button
                type="button"
                className="evolution-link"
                onClick={() => jumpToApprovalAnchor(input.threadId, input.messageId)}
              >
                回读人的原输入
              </button>
            </>
          ) : (
            <p role="status">人的原输入已不可读或身份未能核验；保留历史陈述，当前决定不能确认。</p>
          )}
        </div>
      )}
      {item.recommendation?.basisRefs.map((source, i) => (
        <EvolutionSource key={i} label="建议来源" source={source} />
      ))}
      {decision &&
        decision.state !== 'undecided' &&
        decision.basisRefs.map((source, i) => <EvolutionSource key={i} label="决定依据" source={source} />)}
      {item.existingWork?.sourceRefs.map((source, i) => (
        <EvolutionSource key={i} label="已有工作来源" source={source} />
      ))}
      {submission?.threadId && submission.messageId && (
        <button
          type="button"
          className="evolution-link"
          onClick={() => jumpToApprovalAnchor(submission.threadId!, submission.messageId!)}
        >
          回读猫的提交 · {submission.authorCatId}
        </button>
      )}
      <p className="evolution-preparation-state-note">
        准备选择只记录本轮安排。内容已提交，尚不表示独立验证、实验已执行或正式采用。
      </p>
    </div>
  );
}
