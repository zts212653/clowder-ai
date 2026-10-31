import { ExplorationIcon } from '../exploration/ExplorationIcon';
import { caseNames, type Experiment, experiments, schemeById } from './solution-example';

export function SolutionExperiment({
  experiment,
  compare,
  onCompare,
  onSource,
}: {
  experiment: Experiment;
  compare: boolean;
  onCompare(): void;
  onSource(id: string): void;
}) {
  const scheme = schemeById(experiment.scheme);
  const observation = scheme.members.find((m) => m.id === 'observation')!;
  const rubric = scheme.members.find((m) => m.id === 'rubric')!;
  const baseline = experiments[0];
  return (
    <section className="solution-experiment" aria-label="所选实验" data-experiment-detail={experiment.id}>
      <div className="solution-section-heading">
        <ExplorationIcon kind="experiment" />
        <h2>
          {experiment.id} · {experiment.title}
        </h2>
      </div>
      <p className="solution-tag">{experiment.state === 'unrun' ? '未运行 · 设计计划' : '设计示例 · 非真实运行成绩'}</p>
      <h3 className="solution-result-title">{experiment.summary}</h3>
      {experiment.cases ? (
        <>
          <div className="solution-case-grid" role="group" aria-label="六个场景的示例结果">
            {experiment.cases.map((hit, index) => (
              <div key={caseNames[index]} data-hit={hit}>
                <span className="solution-case-mark">{hit ? '●' : '○'}</span>
                <span>{caseNames[index]}</span>
                <strong>{hit ? '触球' : '未触球'}</strong>
              </div>
            ))}
          </div>
          <p className="solution-muted">
            指定脚触球计数 · 六个公开开发场景 · ● 触球 / ○ 未触球。示例图不证明真实进球或协同能力。
          </p>
        </>
      ) : (
        <div className="solution-unknown">
          <ExplorationIcon kind="warning" />
          <p>
            {experiment.state === 'mismatch'
              ? '计划与实际不一致；本次成绩不计入 S2。请先核对加载，再判断是否补测。'
              : '尚无结果。待确认观测和规约可用后，才能按新条件试跑。'}
          </p>
        </div>
      )}

      {experiment.id === 'X2' && (
        <div className="solution-comparison">
          <button type="button" className="solution-link" aria-expanded={compare} onClick={onCompare}>
            <ExplorationIcon kind="compare" />
            {compare ? '收起对照' : '与 S1 的 X1 对照'}
          </button>
          {compare && (
            <section aria-label="共同条件下的对照">
              <h3>多一次触球，也有一处回归</h3>
              <p>
                共同的六个输入、26 秒窗口、E1 环境、O1 观测与 R1
                规约；设计示例允许比较整套控制方案。两项改动的各自贡献仍未知。
              </p>
              <table className="solution-comparison-table" aria-label="X1 与 X2 示例比较">
                <thead>
                  <tr>
                    <th scope="col">场景</th>
                    <th scope="col">S1 · X1</th>
                    <th scope="col">S2 · X2</th>
                  </tr>
                </thead>
                <tbody>
                  {caseNames.map((name, index) => (
                    <tr key={name} data-regression={baseline.cases?.[index] && !experiment.cases?.[index]}>
                      <td>
                        {name}
                        {baseline.cases?.[index] && !experiment.cases?.[index] ? ' · 回归' : ''}
                      </td>
                      <td>{baseline.cases?.[index] ? '触球' : '未触球'}</td>
                      <td>{experiment.cases?.[index] ? '触球' : '未触球'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                <strong>代价：</strong>示例试跑从 8 分钟增至 10 分钟；人工核查成本缺失。按固定场景顺序完整列出六例。
              </p>
              <p>
                <strong>结论范围：</strong>仅供判断这批开发场景的整套得失。没有独立验证、采用回执或真实后续使用。
              </p>
            </section>
          )}
        </div>
      )}
      {experiment.id === 'X1' && (
        <details className="solution-rejudgment">
          <summary>同一记录的两次判断 · 原判断保留</summary>
          <ol>
            <li>
              <strong>原判断 J1 · R1：</strong>示例 4 / 6 指定脚触球。
            </li>
            <li>
              <strong>后续重判 J2 · R2：</strong>缺少越线观测，无法判断有效进球；不覆盖 J1。
            </li>
          </ol>
          <p>复用的是 X1 的记录。重判没有创建新方案，也没有假装重新运行；新观测需要重新采集。</p>
        </details>
      )}
      {experiment.id === 'X4' && (
        <p className="solution-warning">
          与 X1 / X2
          的量尺不同；没有适用的共同条件与新观测，不能排列分数高低。按当前问题选择重判、补测或仅保留原范围结论，不强制全局
          2×2。
        </p>
      )}
      <details className="solution-run-context">
        <summary>实际加载、测量条件与代价</summary>
        <details>
          <summary>逐成员核对计划与实际 · 示例回执</summary>
          <table className="solution-comparison-table">
            <thead>
              <tr>
                <th scope="col">成员</th>
                <th scope="col">计划</th>
                <th scope="col">实际</th>
              </tr>
            </thead>
            <tbody>
              {scheme.members.map((member) => (
                <tr key={member.id}>
                  <td>{member.name}</td>
                  <td>{member.revision}</td>
                  <td>
                    {experiment.state === 'unrun'
                      ? '未知'
                      : experiment.state === 'mismatch' && member.id === 'control'
                        ? 'H1 · 不符'
                        : member.revision}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>加载回执为设计数据；真实来源未接入。已核对范围、时点和 consumer 由未来的 owner 回执提供。</p>
        </details>
        <dl>
          <dt>计划方案 / 实际加载</dt>
          <dd>
            {experiment.scheme} /{' '}
            {experiment.state === 'unrun'
              ? '未知，未运行'
              : experiment.state === 'mismatch'
                ? '示例回执：H1 替代计划 H2，其余成员一致；不是完整 S1 或 S2'
                : `示例回执与 ${experiment.scheme} 的全部成员一致`}
          </dd>
          <dt>观测</dt>
          <dd>
            {observation.revision} · {observation.name}。{observation.detail}
          </dd>
          <dt>规约与判法</dt>
          <dd>
            {rubric.revision} · {rubric.name}。{rubric.detail}
          </dd>
          <dt>环境</dt>
          <dd>E1 · 同一仿真、物理参数与起始条件；不含真实世界噪声。</dd>
          <dt>样本 / 窗口</dt>
          <dd>D1 · 六个固定偏侧输入；每例 0–26 秒；公开开发用途，不是独立验证集。</dd>
          <dt>GT / 适用范围</dt>
          <dd>设计假定仿真接触读数可用于 R1；R2 的越线判法尚未校准。门槛与共同条件均是示例。</dd>
          <dt>实际代价</dt>
          <dd>{experiment.cost}</dd>
        </dl>
        <details>
          <summary>Raw · 本次实验坐标</summary>
          <pre>
            {JSON.stringify(
              {
                truth: 'design_fixture_only',
                scheme: experiment.scheme,
                experiment: experiment.id,
                actualLoad: experiment.state,
                observation: observation.revision,
                rubric: rubric.revision,
                sample: 'D1',
                window: '0–26s',
                ownerReceipt: null,
                source: 'solution-example.ts',
              },
              null,
              2,
            )}
          </pre>
        </details>
      </details>
      <details className="solution-reference">
        <summary>阅读真实鸭鸭参考归档</summary>
        <p>
          以下是 2026-09-09 v8 的真实归档，用于理解需要保留哪些原件。它不是 {experiment.id}{' '}
          的运行证据，也不能证明上方示例成绩。
        </p>
        <div className="solution-inline-actions">
          <button type="button" onClick={() => onSource('archive-frame')}>
            查看右侧更宽的真实帧
          </button>
          <button type="button" onClick={() => onSource('archive-index')}>
            查看运行索引
          </button>
          <button type="button" onClick={() => onSource('archive-summary')}>
            查看原对照说明
          </button>
        </div>
      </details>
    </section>
  );
}
