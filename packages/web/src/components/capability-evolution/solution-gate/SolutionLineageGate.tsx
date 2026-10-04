'use client';

import { useEffect, useRef, useState } from 'react';
import { createCapabilityEvolutionWorkspaceSurface } from '@/components/workbench/capability-evolution-workspace-adapter';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { useEvolutionReading } from '../evolution-reading-state';
import { ExplorationIcon } from '../exploration/ExplorationIcon';
import { SolutionExperiment } from './SolutionExperiment';
import { SolutionMembers } from './SolutionMembers';
import { SolutionSource } from './SolutionSource';
import {
  changedMembers,
  experiments,
  type SchemeId,
  SOLUTION_PREVIEW_ID,
  schemeById,
  schemes,
} from './solution-example';
import { useSolutionReading } from './solution-reading';
import './solution-lineage.css';
import './solution-results.css';
import './solution-responsive.css';

export function SolutionLineageGate() {
  const { reading, ready, notice, update } = useSolutionReading();
  const [controls, setControls] = useState(false);
  const [scenario, setScenario] = useState('full');
  const viewport = useRef<HTMLDivElement>(null);
  const main = useF307ExperienceWorkbenchStore(
    (store) => store.mainAreaAttentionSurfaceId === createEvolutionProgramSurface(SOLUTION_PREVIEW_ID).id,
  );
  const scheme = schemeById(reading.scheme);
  const experiment = experiments.find((run) => run.id === reading.runs[reading.scheme])!;
  const runs = experiments.filter((run) => run.scheme === reading.scheme);
  const count = changedMembers(scheme).length;
  useEffect(() => {
    const store = useF307ExperienceWorkbenchStore.getState();
    store.dispatch({
      type: 'refresh-surface',
      surface: createEvolutionProgramSurface(SOLUTION_PREVIEW_ID, '鸭鸭协同踢球 · 设计示例'),
    });
  }, []);
  useEffect(() => {
    if (ready && viewport.current) viewport.current.scrollTop = reading.source ? 0 : reading.scroll;
    // Reading scroll is restored on navigation, not on every scroll event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, reading.source, main]);
  const chooseScheme = (id: SchemeId) => update({ scheme: id, source: null, compare: false, role: 'all' });
  const openSource = (id: string) => update({ source: id, scroll: viewport.current?.scrollTop ?? 0 });
  const returnToWorkspace = () => {
    const store = useF307ExperienceWorkbenchStore.getState();
    const home = createCapabilityEvolutionWorkspaceSurface('thread-f311-workspace-contract');
    useEvolutionReading.getState().selectWorkspaceProgram('thread-f311-workspace-contract', null);
    store.exitMainAreaAttention();
    store.dispatch({ type: 'open-surface', surface: home, entitlement: { kind: 'user', reason: 'surface-tab' } });
  };
  return (
    <div
      className="solution-gate evolution-workspace"
      ref={viewport}
      data-testid="f311-solution-lineage-gate"
      onScroll={(event) => {
        if (ready && !reading.source) update({ scroll: event.currentTarget.scrollTop });
      }}
    >
      <aside className="solution-fixture" aria-label="设计稿控制">
        <span>设计示例 · 未连接真实方案记录</span>
        <button type="button" onClick={() => setControls((value) => !value)}>
          {controls ? '隐藏夹具控制' : '夹具控制'}
        </button>
        {controls && (
          <label>
            阅读场景
            <select aria-label="设计稿场景" value={scenario} onChange={(event) => setScenario(event.target.value)}>
              <option value="full">完整示例</option>
              <option value="unknown">当前沿用未知</option>
              <option value="empty">尚无方案</option>
              <option value="failed">读取失败</option>
              <option value="source-failed">原件失败</option>
            </select>
          </label>
        )}
      </aside>
      <div className="solution-content">
        <nav className="solution-topnav" aria-label="方案导航">
          <button type="button" onClick={returnToWorkspace}>
            ← 能力进化
          </button>
          <button
            type="button"
            onClick={() => {
              const store = useF307ExperienceWorkbenchStore.getState();
              if (main) store.exitMainAreaAttention();
              else store.enterMainAreaAttention(createEvolutionProgramSurface(SOLUTION_PREVIEW_ID).id);
            }}
          >
            {main ? '返回侧栏' : '在主区展开'}
          </button>
        </nav>
        <header className="solution-header">
          <p className="solution-eyebrow">能力目标 / 整体方案</p>
          <h1>鸭鸭协同踢球</h1>
          <p>让鸭子有效踢球，让队友形成配合，并留下能核查的过程。</p>
          <div className="solution-use" data-current-use>
            <ExplorationIcon kind="branch" />
            <strong>{scenario === 'unknown' ? '当前沿用未知' : '沿用 S1 · 示例'}</strong>
            <span>
              {scenario === 'unknown'
                ? '缺少 owner 生效回执，不能由最新版本推断。'
                : '沿用回执为设计示意；真实 Program 的采用与使用未验证。'}
            </span>
          </div>
        </header>
        {notice && (
          <p role="status" className="solution-warning">
            {notice}
          </p>
        )}
        {reading.source ? (
          <SolutionSource
            sourceId={reading.source}
            unavailable={scenario === 'source-failed'}
            onClose={() => update({ source: null })}
          />
        ) : scenario === 'empty' ? (
          <section className="solution-empty">
            <h2>尚无可读方案</h2>
            <p>目标已保留。还没有发布精确组成，不根据准备材料拼出一个“已运行版本”。</p>
          </section>
        ) : scenario === 'failed' ? (
          <section className="solution-empty">
            <h2>方案读取失败</h2>
            <p>阅读位置仍保留；没有把旧缓存当作当前沿用。</p>
            <button type="button" onClick={() => setScenario('full')}>
              重试读取
            </button>
          </section>
        ) : (
          <>
            <section className="solution-overview" aria-label="所选方案">
              <p className="solution-eyebrow">
                正在阅读 {scheme.id} {scheme.parent ? `/ 基于 ${scheme.parent}` : '/ 基线'}
              </p>
              <h2>{scheme.title}</h2>
              <p>{scheme.change}</p>
              <div className="solution-reason">
                <strong>为什么这样改</strong>
                <p>{scheme.why}</p>
              </div>
              <p className="solution-conclusion">{scheme.conclusion}</p>
              <button
                type="button"
                className="solution-link"
                aria-expanded={reading.members}
                onClick={() => update({ members: !reading.members })}
              >
                <ExplorationIcon kind="code" />
                {reading.members ? '收起组成' : `展开组成与差异 · ${count ? `${count} 项改变` : '基线'}`}
              </button>
              {reading.members && (
                <SolutionMembers
                  scheme={scheme}
                  experiment={experiment}
                  role={reading.role}
                  onRole={(role) => update({ role })}
                  onSource={openSource}
                />
              )}
            </section>
            <section className="solution-lineage" aria-label="方案派生关系">
              <div className="solution-section-heading">
                <ExplorationIcon kind="branch" />
                <h2>一条控制分支，一条测量分支</h2>
              </div>
              <p className="solution-muted">点选只改变阅读位置。下面的父边与编号都是设计示意。</p>
              <div className="solution-branch-layout">
                <svg className="solution-edges" viewBox="0 0 500 170" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M175 85 H225 V40 H295 M225 85 V130 H295" />
                </svg>
                {schemes.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-scheme-node={item.id}
                    aria-pressed={reading.scheme === item.id}
                    onClick={() => chooseScheme(item.id)}
                  >
                    <span className="solution-node-top">
                      <strong>{item.id}</strong>
                      <span>{item.parent ? `从 ${item.parent} 派生` : '比较基线'}</span>
                    </span>
                    <span className="solution-node-title">{item.title}</span>
                    <small>
                      {item.id === 'S1'
                        ? '1 次实验 · 2 次判断'
                        : item.id === 'S2'
                          ? '2 次实验 · 1 次加载不符'
                          : '1 项待运行计划'}
                    </small>
                  </button>
                ))}
              </div>
            </section>
            <section className="solution-runs" aria-label="本方案实验">
              <div className="solution-section-heading">
                <ExplorationIcon kind="experiment" />
                <h2>这套方案的实验</h2>
              </div>
              <p className="solution-muted">补测保留方案身份；新组合才增加方案。每次实验有自己的加载、条件和结果。</p>
              <div className="solution-run-picker">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    aria-pressed={experiment.id === run.id}
                    onClick={() => update({ runs: { ...reading.runs, [scheme.id]: run.id }, compare: false })}
                  >
                    <strong>{run.id}</strong>
                    <span>{run.title}</span>
                  </button>
                ))}
              </div>
              <SolutionExperiment
                key={experiment.id}
                experiment={experiment}
                compare={reading.compare}
                onCompare={() => update({ compare: !reading.compare })}
                onSource={openSource}
              />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
