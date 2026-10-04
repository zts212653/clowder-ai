'use client';
import { useCallback, useEffect, useState } from 'react';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createEvolutionProgramSurface } from '@/components/workbench/real-surface-adapters';
import { SOLUTION_PREVIEW_ID } from '../solution-example';
import { DuckDemoEvidence } from './DuckDemoEvidence';
import { DuckDemoReplay } from './DuckDemoReplay';
import { chapters, demoRuns, type VersionId, versions } from './demo-data';
import '../solution-lineage.css';
import './duck-demo.css';

const storageKey = 'f311-duck-simulation-reading-v1';
export function DuckEvolutionDemo() {
  const [chapter, setChapter] = useState(0);
  const [versionId, setVersion] = useState<VersionId>('V1');
  const [runId, setRun] = useState('X1');
  const [playing, setPlaying] = useState(false);
  const [guide, setGuide] = useState(true);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  const main = useF307ExperienceWorkbenchStore(
    (s) => s.mainAreaAttentionSurfaceId === createEvolutionProgramSurface(SOLUTION_PREVIEW_ID).id,
  );
  const version = versions.find((v) => v.id === versionId)!;
  const run = demoRuns.find((r) => r.id === runId)!;
  const selected = chapters[chapter];
  useEffect(() => {
    useF307ExperienceWorkbenchStore.getState().dispatch({
      type: 'refresh-surface',
      surface: createEvolutionProgramSurface(SOLUTION_PREVIEW_ID, '鸭鸭模拟进化'),
    });
  }, []);
  const advance = useCallback((next: number) => {
    const n = Math.min(chapters.length - 1, Math.max(0, next));
    setChapter(n);
    setVersion(chapters[n].version);
    setRun(chapters[n].run);
  }, []);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const state = JSON.parse(raw);
        if (
          !Number.isInteger(state.chapter) ||
          !chapters[state.chapter] ||
          !versions.some((v) => v.id === state.version) ||
          !demoRuns.some((r) => r.id === state.run && r.scheme === state.version)
        )
          throw Error('invalid reading');
        setChapter(state.chapter);
        setVersion(state.version);
        setRun(state.run);
      }
    } catch {
      setNotice('上次阅读位置无法恢复，已回到第一幕。');
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ chapter, version: versionId, run: runId }));
    } catch {
      setNotice('阅读位置暂不能保存；当前演示仍可继续。');
    }
  }, [ready, chapter, versionId, runId]);
  useEffect(() => {
    if (!playing) return;
    if (chapter === chapters.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => advance(chapter + 1), 12000);
    return () => window.clearTimeout(timer);
  }, [playing, chapter, advance]);
  return (
    <div
      className="solution-gate evolution-workspace duck-demo"
      data-testid="f311-duck-evolution-demo"
      role="region"
      aria-label="鸭鸭模拟进化演示"
      onKeyDown={(e) => {
        if (e.target instanceof HTMLElement && e.target.matches('input,select')) return;
        if (e.key === ' ' && e.target instanceof HTMLElement && e.target.matches('button,summary')) return;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          setPlaying(false);
          advance(chapter + 1);
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          setPlaying(false);
          advance(chapter - 1);
        }
        if (e.key === ' ') {
          e.preventDefault();
          setPlaying((p) => !p);
        }
      }}
    >
      <aside className="solution-fixture">
        <strong>模拟进化 · 数据与回执均为编写的示例</strong>
        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setGuide((g) => !g);
          }}
        >
          {guide ? '隐藏讲解控制' : '显示讲解控制'}
        </button>
      </aside>
      <div className="solution-content">
        <nav className="solution-topnav">
          <span>鸭鸭 / 整体方案与进化过程</span>
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
        <header className="duck-header">
          <p className="solution-eyebrow">目标：让鸭鸭有效踢到移动的球</p>
          <h1>一只鸭，怎样变得更会踢球？</h1>
          <p>看清不足 → 选择改法 → 用证据比较 → 在合适的范围留下改动</p>
        </header>
        {notice && <output>{notice}</output>}
        {guide && (
          <section className="duck-guide" aria-label="模拟故事讲解控制">
            <div className="duck-controls">
              <button
                type="button"
                disabled={chapter === 0}
                onClick={() => {
                  setPlaying(false);
                  advance(chapter - 1);
                }}
              >
                上一幕
              </button>
              <strong>
                {chapter + 1} / {chapters.length}
              </strong>
              <button
                type="button"
                disabled={chapter === chapters.length - 1}
                onClick={() => {
                  setPlaying(false);
                  advance(chapter + 1);
                }}
              >
                下一幕
              </button>
              <button
                type="button"
                aria-pressed={playing}
                onClick={() => {
                  if (chapter === 6) advance(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? '暂停讲解' : '播放讲解'}
              </button>
            </div>
            <div className="duck-chapters">
              {chapters.map((c, i) => (
                <button
                  type="button"
                  key={c.label}
                  aria-pressed={chapter === i}
                  onClick={() => {
                    setPlaying(false);
                    advance(i);
                  }}
                >
                  {i + 1} {c.label}
                </button>
              ))}
            </div>
            <h2>{selected.title}</h2>
            <p>{selected.text}</p>
          </section>
        )}
        <section className="duck-lineage" aria-label="四套整体方案的谱系">
          <svg className="duck-lineage-edges" viewBox="0 0 900 220" preserveAspectRatio="none" aria-hidden="true">
            <path d="M160 110 H310 V50 H420 M310 110 V170 H420 M510 50 H600 V110 H740 M510 170 H600 V110" />
          </svg>
          {versions.map((v) => (
            <button
              type="button"
              key={v.id}
              data-version={v.id}
              aria-pressed={versionId === v.id}
              onClick={() => {
                setPlaying(false);
                setVersion(v.id);
                setRun(demoRuns.find((r) => r.scheme === v.id)!.id);
              }}
            >
              <small>{v.parents.length ? `${v.parents.join(' + ')} →` : '比较基线'}</small>
              <strong>{v.id}</strong>
              <span>{v.title}</span>
              <small>
                {v.members.control} · {v.members.observation} · {v.members.rubric}
              </small>
            </button>
          ))}
        </section>
        <section className="duck-version" aria-label="所选整体方案">
          <p className="solution-eyebrow">正在阅读 {version.id} · 点选不会改变采用</p>
          <h2>{version.title}</h2>
          <p>
            <strong>改了什么：</strong>
            {version.change}
          </p>
          <p>
            <strong>为什么先改这里：</strong>
            {version.why}
          </p>
          <p className="duck-caution">{version.limit}</p>
        </section>
        {chapter < 2 && <DuckDemoReplay />}
        <div className="duck-run-picker" role="group" aria-label="同一版本的实验">
          {demoRuns
            .filter((r) => r.scheme === version.id)
            .map((r) => (
              <button
                type="button"
                key={r.id}
                aria-pressed={runId === r.id}
                onClick={() => {
                  setPlaying(false);
                  setRun(r.id);
                }}
              >
                {r.id} · {r.sampleSet}
                {r.loaded ? '' : ' · 加载不符'}
              </button>
            ))}
        </div>
        <DuckDemoEvidence key={run.id} version={version} run={run} />
        {chapter === 6 && (
          <section className="duck-adoption" aria-label="模拟采用与实际使用">
            <h2>决定与使用，分别留证</h2>
            <p>
              <strong>模拟决定 A1：</strong>只让左侧训练 consumer 试用 V4，接受 25% 开销增加；右侧仍用 V3。
            </p>
            <p>
              <strong>模拟加载 L1：</strong>左侧 consumer 的九个成员与 V4 完全匹配；右侧 consumer 匹配
              V3。最新版本不等于全局生效。
            </p>
            <p>
              <strong>下一轮：</strong>继续收集左侧新失败与成本；若超过 30%
              预算或出现重复退步，停止该范围试用、回退并保留原记录。右侧退步需另提候选，不能藏进总分。
            </p>
            <p className="duck-small">这是演示结尾，没有真实批准、发布或运行；也未证明多鸭协作已经改善。</p>
          </section>
        )}
        <footer className="duck-footer">
          全页版本、运行、成绩、轨迹和采用回执都是 mock。真实鸭鸭 Program 未改变。箭头切幕，空格播放/暂停。
        </footer>
      </div>
    </div>
  );
}
