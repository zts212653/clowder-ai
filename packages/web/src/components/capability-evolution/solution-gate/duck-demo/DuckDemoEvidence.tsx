import { useState } from 'react';
import { calibration, caseInputs, environment, judgeGoal } from './demo-conditions';
import {
  caseSets,
  comparable,
  comparisonRun,
  type DemoRun,
  type DemoVersion,
  evaluations,
  eventPacket,
  type MemberId,
  memberNames,
  score,
  versions,
} from './demo-data';

export function DuckDemoEvidence({ version, run }: { version: DemoVersion; run: DemoRun }) {
  const evaluation = evaluations[run.evaluation as keyof typeof evaluations];
  const other = comparisonRun(run);
  const [row, setRow] = useState(0);
  const parent = versions.find((v) => v.id === version.parents[0]);
  return (
    <>
      <section className="duck-coordinates" aria-label="这一版用什么看和判">
        <div>
          <small>整体方案</small>
          <strong>{version.id}</strong>
          <span>
            {version.members.control} + {version.members.config}，含下面的眼睛与尺子
          </span>
        </div>
        <div>
          <small>观测 · 眼睛</small>
          <strong>{version.members.observation}</strong>
          <span>{version.members.observation === 'O1' ? '球位 / 动作 / 指定脚接触' : '接触 + 整球越线'}</span>
        </div>
        <div>
          <small>评估方案 · 怎么判</small>
          <strong>
            {run.evaluation} / {evaluation.rubric}
          </strong>
          <span>
            {evaluation.title} · {run.sampleSet} · E1 · 26 秒
          </span>
        </div>
      </section>
      <details className="duck-details">
        <summary>展开组成：具体改了哪几样？</summary>
        <p>整体版本引用每个成员的精确示例版本。观测和规约就在这份清单里。</p>
        <ul className="duck-members">
          {(Object.keys(memberNames) as MemberId[]).map((id) => (
            <li key={id} data-changed={parent && parent.members[id] !== version.members[id]}>
              <span>{memberNames[id]}</span>
              <strong>
                {parent && parent.members[id] !== version.members[id] ? `${parent.members[id]} → ` : ''}
                {version.members[id]}
              </strong>
            </li>
          ))}
        </ul>
        {version.id === 'V4' && (
          <p>来源边：H2/C2 ← V2；O2/R2 ← V3。其余 M1/B1/P1/E1/D1 一致；此处不是凭时间先后猜合并关系。</p>
        )}
      </details>
      <details className="duck-details">
        <summary>展开评估方案：rubric、benchmark 和证据怎么接？</summary>
        <dl>
          <dt>{evaluation.observation} 观测配置</dt>
          <dd>{evaluation.sees}</dd>
          <dt>Rubric / 通过条件</dt>
          <dd>{evaluation.rule}</dd>
          <dt>判卷与聚合</dt>
          <dd>{evaluation.verifier}</dd>
          <dt>Benchmark / 测试集</dt>
          <dd>
            {run.sampleSet} · {caseSets[run.sampleSet].length} 个冻结输入，E1 相同场地/摩擦/球参数，每例 0–26 秒。
            {run.sampleSet === 'D1'
              ? '公开开发场景，已用于改法选择。'
              : '本故事中冻结候选后首次打开的八个左侧输入；没有用于调参。'}{' '}
            EV 是评估方案版本；换样本必须另记条件。
          </dd>
          <dt>判法校准（模拟设定）</dt>
          <dd>
            四条合成边界记录：球自行越线、仅球心越线、踢球期外触碰、合法触球后整球越线；R2
            仅最后一条通过。本示例未连接真实物理引擎或真实专家质检。
          </dd>
          <dd>
            <details>
              <summary>模拟配置与四条校准记录</summary>
              <pre>
                {JSON.stringify(
                  {
                    environment,
                    inputs: caseInputs[run.sampleSet],
                    units: '[x,y,vx,vy] 米/秒',
                    calibration: calibration.map((c) => ({ ...c, actual: judgeGoal(c.event) })),
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </dd>
          <dt>能说明什么</dt>
          <dd>只演示证据如何组织；数值不能证明真实鸭鸭能力。LLM 解释候选原因，模拟器/verifier 按规约判结果。</dd>
        </dl>
      </details>
      <section className="duck-results" aria-label="本次模拟实验">
        <div className="duck-run-heading">
          <h3>
            {run.id} · {run.loaded ? '模拟结果' : '模拟中止记录'}
          </h3>
          <span>{run.minutes} 分钟 · 编写的成本</span>
        </div>
        {!run.loaded ? (
          <p className="duck-caution">
            计划 H2，实际示例回执 H1；其余成员与 V2 计划一致。运行中止，成绩不归属 V2；没有因此增加一个版本。
          </p>
        ) : (
          <>
            <div className="duck-scores">
              <div>
                <strong>{score(run.contact)}</strong>
                <span>指定脚触球</span>
              </div>
              <div>
                <strong>{score(run.goals)}</strong>
                <span>有效进球{run.goals ? '' : ' · 缺越线观测'}</span>
              </div>
            </div>
            {other && comparable(run, other) && (
              <p className="duck-comparison-note">
                与 {other.scheme} / {other.id} 相比：
                {evaluation.rubric === 'R1'
                  ? `触球 ${score(other.contact)} → ${score(run.contact)}`
                  : `进球 ${score(other.goals)} → ${score(run.goals)}`}
                ；成本 {other.minutes} → {run.minutes} 分钟。
                {run.sampleSet === 'D1' ? '六例全部保留，右侧退步未隐藏。' : '只支持左侧范围，不能外推到右侧。'}
              </p>
            )}
            <div className="duck-table-wrap">
              <table aria-label="逐场景模拟比较">
                <thead>
                  <tr>
                    <th>场景</th>
                    {other && (
                      <th>
                        {other.scheme}
                        <br />触 / 进
                      </th>
                    )}
                    <th>
                      {version.id}
                      <br />触 / 进
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {caseSets[run.sampleSet].map((name, i) => (
                    <tr key={name} data-regression={other?.contact?.[i] && !run.contact?.[i]}>
                      <td>
                        {name}
                        {other?.contact?.[i] && !run.contact?.[i] ? ' · 退步' : ''}
                      </td>
                      {other && (
                        <td>
                          {other.contact?.[i] ? '是' : '否'} / {other.goals ? (other.goals[i] ? '是' : '否') : '?'}
                        </td>
                      )}
                      <td>
                        {run.contact?.[i] ? '是' : '否'} / {run.goals ? (run.goals[i] ? '是' : '否') : '?'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="duck-small">触 / 进 = 指定脚触球 / 有效进球。? 是未观测，不是失败。所有结果均为模拟。</p>
          </>
        )}
        <details className="duck-details">
          <summary>本次加载与原始模拟事件</summary>
          <p>
            {run.loaded
              ? `本故事中的加载回执逐项匹配 ${version.id}，覆盖全部九个成员。`
              : '模拟加载失败：control = H1，不是计划 H2。'}{' '}
            这不是生产运行回执。
          </p>
          <pre>
            {JSON.stringify(
              {
                planned: version.members,
                loaded: { ...version.members, control: run.loaded ? version.members.control : 'H1' },
                truth: 'mock_receipt',
              },
              null,
              2,
            )}
          </pre>
          <label>
            查看场景{' '}
            <select aria-label="模拟事件场景" value={row} onChange={(e) => setRow(Number(e.target.value))}>
              {caseSets[run.sampleSet].map((name, i) => (
                <option key={name} value={i}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <pre>{JSON.stringify(eventPacket(run, row), null, 2)}</pre>
        </details>
        {version.id === 'V1' && (
          <details className="duck-details">
            <summary>后来用 R2 重判 X1，会发生什么？</summary>
            <p>J1 / R1：4/6 触球，保留。J2 / R2：缺越线观测，无法重判。没有覆盖原判断，也没有假装重新跑过。</p>
          </details>
        )}
      </section>
    </>
  );
}
