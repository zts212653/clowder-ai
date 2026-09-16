import type { EvolutionPreparationBodyV1, EvolutionPreparationSubmissionV1 } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import { EvolutionPreparationGtSources } from './EvolutionPreparationGtSources';
import { EvolutionPreparationItems } from './EvolutionPreparationItems';
import { EvolutionPreparationRubrics } from './EvolutionPreparationRubrics';
import {
  type EvolutionPreparationSectionProjection,
  type EvolutionPreparationSubmissionProjection,
  isVisiblePreparationSubmission,
} from './evolution-preparation-resource';
import { PreparationDetails } from './PreparationDetails';
import { SubmissionHeader, SubmissionMeta } from './PreparationSubmissionMeta';

function CommonEnding({ body }: { body: EvolutionPreparationBodyV1 }) {
  return (
    <>
      {body.unknowns.length > 0 && (
        <div className="evolution-preparation-unknowns">
          <strong>仍未知</strong>
          <ul>
            {body.unknowns.map((unknown) => (
              <li key={unknown}>{unknown}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="evolution-preparation-next">下一步：{body.nextAction}</p>
    </>
  );
}

function SubmissionBody({
  programId,
  submission,
  section,
  gtLabels,
  focusedGtSourceKey,
  onJumpGtSource,
  value,
  historical = false,
}: {
  programId: string;
  submission: EvolutionPreparationSubmissionV1;
  section: EvolutionPreparationSectionProjection;
  gtLabels: Readonly<Record<string, string>>;
  focusedGtSourceKey?: string;
  onJumpGtSource: (sourceKey: string, criterionId: string, revision: string) => void;
  value: EvolutionPreparationSubmissionProjection;
  historical?: boolean;
}) {
  const { body } = submission;
  if (body.kind === 'object_map') {
    return (
      <div className="evolution-preparation-body">
        <blockquote className="evolution-preparation-goal">“{body.goalStatement}”</blockquote>
        <p className="evolution-preparation-summary">{body.summary}</p>
        <EvolutionPreparationItems
          items={body.items}
          activities={section.activities}
          submission={value}
          historical={historical}
        />
        <CommonEnding body={body} />
      </div>
    );
  }
  if (body.kind === 'success_contract') {
    return (
      <div className="evolution-preparation-body">
        <p className="evolution-preparation-summary">{body.summary}</p>
        <EvolutionPreparationRubrics
          programId={programId}
          revision={submission.revision}
          criteria={body.criteria}
          gtLabels={gtLabels}
          onJumpGtSource={(key, criterion) => onJumpGtSource(key, criterion, submission.revision)}
        />
        <CommonEnding body={body} />
      </div>
    );
  }
  if (body.kind === 'measurement_plan') {
    return (
      <div className="evolution-preparation-body">
        <p className="evolution-preparation-summary">{body.summary}</p>
        <h4 className="evolution-preparation-subheading">GT 来源、采集与可信性</h4>
        <p>模拟器、benchmark 和线上使用可以组合取证；渠道不等于 GT 域，采集完成也不等于判断可靠。</p>
        <EvolutionPreparationGtSources
          programId={programId}
          sources={body.gtSources}
          focusedSourceKey={focusedGtSourceKey}
          submission={value}
        />
        {body.conditions.length > 0 && (
          <>
            <h4 className="evolution-preparation-subheading">实验条件</h4>
            <EvolutionPreparationItems
              items={body.conditions}
              activities={section.activities}
              submission={value}
              historical={historical}
            />
          </>
        )}
        <h4 className="evolution-preparation-subheading">比较约定</h4>
        <dl className="evolution-preparation-facts evolution-preparation-comparison">
          <div>
            <dt>观察单位</dt>
            <dd>{body.comparison.unit}</dd>
          </div>
          <div>
            <dt>本轮主变量</dt>
            <dd>{body.comparison.primaryVariable}</dd>
          </div>
          <div>
            <dt>保持可比</dt>
            <dd>{body.comparison.controls.join('、') || '尚待确认。'}</dd>
          </div>
          <div>
            <dt>开发证据</dt>
            <dd>{body.comparison.developmentEvidence}</dd>
          </div>
          <div>
            <dt>独立留出</dt>
            <dd>{body.comparison.independentHoldout}</dd>
          </div>
          <div>
            <dt>可重复性</dt>
            <dd>{body.comparison.repeatability}</dd>
          </div>
        </dl>
        <CommonEnding body={body} />
      </div>
    );
  }
  return (
    <div className="evolution-preparation-body">
      <p className="evolution-preparation-summary">{body.summary}</p>
      <dl className="evolution-preparation-facts">
        <div>
          <dt>基线状态</dt>
          <dd>
            {body.baselineState === 'owner_verified'
              ? 'Owner 已核验'
              : body.baselineState === 'draft'
                ? '初步草案'
                : '仍未知'}
          </dd>
        </div>
        <div>
          <dt>观察单位</dt>
          <dd>{body.observationUnit}</dd>
        </div>
      </dl>
      <h4 className="evolution-preparation-subheading">当前事实</h4>
      <div className="evolution-preparation-fact-cards">
        {body.facts.length ? (
          body.facts.map((fact) => (
            <article key={fact.factId} className="evolution-preparation-fact-card" data-fact-state={fact.state}>
              <header>
                <h5>{fact.label}</h5>
                <span>
                  {fact.state === 'owner_verified' ? 'Owner 已核验' : fact.state === 'reported' ? '已有报告' : '仍未知'}
                </span>
              </header>
              <p>{fact.limitation}</p>
              {fact.sourceRefs.map((source, index) => (
                <EvolutionSource
                  key={`${source.ownerFeatureId}:${source.ownerStateRef}:${index}`}
                  label="事实来源"
                  source={source}
                />
              ))}
            </article>
          ))
        ) : (
          <p className="evolution-empty">还没有可核验的基线事实。</p>
        )}
      </div>
      <h4 className="evolution-preparation-subheading">竞争解释</h4>
      <div className="evolution-preparation-explanations">
        {body.competingExplanations.map((explanation) => (
          <article key={explanation.explanationId}>
            <h5>{explanation.hypothesis}</h5>
            <p>区分下一步：{explanation.discriminatingNextStep}</p>
            {explanation.evidenceFor.map((source, index) => (
              <EvolutionSource key={`for:${source.ownerStateRef}:${index}`} label="支持证据" source={source} />
            ))}
            {explanation.evidenceAgainst.map((source, index) => (
              <EvolutionSource key={`against:${source.ownerStateRef}:${index}`} label="反证" source={source} />
            ))}
          </article>
        ))}
      </div>
      <CommonEnding body={body} />
    </div>
  );
}

function SourceFailure({ current }: { current: EvolutionPreparationSubmissionProjection }) {
  const message =
    current.status === 'materializing'
      ? '提交意图已经登记，但正文尚未完成持久化。请由同一命令重试恢复；这里不会假装已经提交。'
      : current.status === 'source_unavailable'
        ? '这版提交的来源已不可用，正文不会从浏览器缓存或旧版本借用。'
        : '这版提交的来源、作者或内容校验未通过，正文已停止展示。';
  return <output className="evolution-preparation-alert">{message}</output>;
}

export function EvolutionPreparationSection({
  programId,
  section,
  gtLabels,
  focusedGtSourceKey,
  onJumpGtSource,
  historicalCurrent = false,
}: {
  programId: string;
  section: EvolutionPreparationSectionProjection;
  gtLabels: Readonly<Record<string, string>>;
  focusedGtSourceKey?: string;
  onJumpGtSource: (sourceKey: string, criterionId: string, revision: string) => void;
  historicalCurrent?: boolean;
}) {
  const current = section.current;
  const sectionActivity = section.activities.find(
    (activity) => !activity.itemId && activity.state !== 'superseded_by_submission',
  );
  return (
    <section className="evolution-preparation-section" aria-label="当前准备内容">
      {sectionActivity && (
        <div className="evolution-preparation-section-activity" data-activity-state={sectionActivity.state}>
          {sectionActivity.spinning && <span aria-hidden="true" data-preparation-spinner="true" />}
          <strong>
            {
              {
                active: '正在进行',
                terminal: '运行已结束',
                unknown: '活动状态待核实',
                identity_invalid: '工作身份未通过核验',
                superseded_by_submission: '已由后续记录承接',
              }[sectionActivity.state]
            }
          </strong>
          <span>{sectionActivity.focus}</span>
          {sectionActivity.catId && <span>· {sectionActivity.catId}</span>}
        </div>
      )}
      {!current ? (
        <div className="evolution-preparation-empty">
          <h3>还没有提交</h3>
          <p>
            {sectionActivity
              ? '已有工作记录，等待新的猫从这里继续。'
              : '待猫继续准备；没有真实工作记录时不显示猫名或转圈。'}
          </p>
        </div>
      ) : (
        <article className="evolution-preparation-submission" data-current-source-status={current.status}>
          <SubmissionHeader value={current} />
          {historicalCurrent && (
            <p className="evolution-preparation-alert">这是对应原规约的历史取证稿，不代表当前测量准备。</p>
          )}
          {current.status === 'needs_update' && (
            <output className="evolution-preparation-alert">
              依赖的准备稿已经变化；这版内容仍可回读，但继续使用前需要按当前修订更新。
            </output>
          )}
          {isVisiblePreparationSubmission(current) ? (
            <SubmissionBody
              programId={programId}
              submission={current.submission}
              value={current}
              historical={historicalCurrent}
              section={section}
              gtLabels={gtLabels}
              focusedGtSourceKey={focusedGtSourceKey}
              onJumpGtSource={onJumpGtSource}
            />
          ) : (
            <SourceFailure current={current} />
          )}
          <SubmissionMeta value={current} />
        </article>
      )}
      {section.history.length > 0 && (
        <PreparationDetails
          programId={programId}
          readingKey={`${section.section}:history`}
          className="evolution-preparation-history"
        >
          <summary>以前的提交 · {section.history.length}</summary>
          <div>
            {section.history.map((entry) => (
              <PreparationDetails
                programId={programId}
                readingKey={`${entry.ref.version}:history`}
                key={`${entry.ref.ownerStateRef}:${entry.ref.version}`}
                className="evolution-preparation-history-entry"
              >
                <summary>
                  {entry.submission?.title ?? '来源不可用的提交'} · {entry.ref.version?.slice(0, 16)}…
                </summary>
                <SubmissionHeader value={entry} />
                {isVisiblePreparationSubmission(entry) ? (
                  <SubmissionBody
                    programId={programId}
                    submission={entry.submission}
                    value={entry}
                    historical
                    section={section}
                    gtLabels={{}}
                    focusedGtSourceKey={undefined}
                    onJumpGtSource={onJumpGtSource}
                  />
                ) : (
                  <SourceFailure current={entry} />
                )}
                <SubmissionMeta value={entry} />
              </PreparationDetails>
            ))}
          </div>
        </PreparationDetails>
      )}
    </section>
  );
}
