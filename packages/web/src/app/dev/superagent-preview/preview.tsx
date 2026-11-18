'use client';

import { useEffect, useRef, useState } from 'react';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { sampleThreads } from './fixtures';
import styles from './preview.module.css';
import { type PreviewScene, useSuperagentPreview } from './state';

/** Native shell experience draft; every work item and transition is synthetic. */
export function SuperagentPreview() {
  const { scene, scope, scopeOpen, decision, feedback, delivered, set } = useSuperagentPreview();
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const enabled = scene === 'active';
  const configured = !['uninstalled', 'setup'].includes(scene);
  const status = { uninstalled: '未安装', setup: '待设置', active: '监听中', paused: '已暂停', error: '不可用' }[scene];

  useEffect(() => {
    if (scopeOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [scopeOpen]);

  useEffect(() => {
    const content = history.current;
    if (content) content.scrollTop = content.scrollHeight;
  }, [scene, decision, feedback, delivered, source]);

  const reply = (text: string) => {
    if (!text.trim()) return;
    set({ decision: text.trim(), delivered: false });
    setDraft('');
  };

  return (
    <section className={styles.page} id="superagent-conversation" aria-label="Superagent 体验稿">
      <div className={styles.demo}>
        <span>体验稿 · 合成样例，未启用真实监听或执行</span>
        <div className={styles.demoActions}>
          <label>
            场景{' '}
            <select
              aria-label="体验场景"
              value={scene}
              onChange={(event) =>
                set({ scene: event.target.value as PreviewScene, decision: '', feedback: false, delivered: false })
              }
            >
              <option value="active">正在跟进</option>
              <option value="uninstalled">未安装</option>
              <option value="setup">待设置</option>
              <option value="paused">已暂停</option>
              <option value="error">连接失败</option>
            </select>
          </label>
          <button type="button" disabled={!enabled} onClick={() => set({ feedback: true })}>
            样例：原话题收到反馈
          </button>
          <button type="button" disabled={!enabled || !decision} onClick={() => set({ delivered: true })}>
            样例：工作完成
          </button>
        </div>
      </div>
      <header className={styles.header}>
        <div className={styles.identity}>
          <span className={styles.avatar}>
            <ShellGlyph name="sparkles" />
          </span>
          <div>
            <h1>我的助手</h1>
            <p>
              <span className={enabled ? styles.online : styles.offline} />
              {status}
              {configured && ` · 关注 ${scope.length} 个会话`}
            </p>
          </div>
        </div>
        {scene !== 'uninstalled' && (
          <div className={styles.headerActions}>
            <button type="button" className="console-button-secondary" onClick={() => set({ scopeOpen: true })}>
              监听范围
            </button>
            {configured && scene !== 'error' && (
              <button
                type="button"
                className="console-button-secondary"
                onClick={() => set({ scene: enabled ? 'paused' : 'active' })}
              >
                {enabled ? '暂停' : '恢复监听'}
              </button>
            )}
          </div>
        )}
      </header>
      <div className={styles.history} ref={history}>
        {scene === 'uninstalled' ? (
          <div className={styles.empty}>
            <h2>让工作持续向前</h2>
            <p>在多个会话中发现获准的工作，跟进已有事项，在需要你时带着具体问题回来。</p>
            <button
              type="button"
              className="console-button-primary"
              onClick={() => set({ scene: 'setup', scopeOpen: true })}
            >
              安装并设置
            </button>
            <small>当前按钮演示安装后的体验，不会安装真实插件。</small>
          </div>
        ) : scene === 'setup' ? (
          <div className={styles.empty}>
            <h2>先告诉我关注哪里</h2>
            <p>选择会话和工作范围后，我才能开始跟进。你可以随时暂停或调整。</p>
            <button type="button" className="console-button-primary" onClick={() => set({ scopeOpen: true })}>
              设置监听范围
            </button>
          </div>
        ) : (
          <div className={styles.transcript}>
            {scene === 'paused' && (
              <p className={styles.notice} role="status">
                监听已暂停。不会接收新事项或派发新工作；已经运行的工作仍可单独取消。
              </p>
            )}
            {scene === 'error' && (
              <div className={styles.notice} role="alert">
                <p>执行成员暂时不可用，尚未派发的工作已保留。</p>
                <button type="button" className="console-button-secondary" onClick={() => set({ scene: 'active' })}>
                  重试连接
                </button>
              </div>
            )}
            <div className={styles.user}>
              <span>你</span>
              <p>帮我盯住发布准备和导出修复。常规调查、修改和验证你来推进，涉及发布取舍时再找我。</p>
            </div>
            <article className={styles.assistant}>
              <span className={styles.speaker}>我的助手</span>
              <p>我接住了这两件事。导出修复在继续验证，发布说明还需要你定一个优先级；你可以继续处理别的。</p>
              <div className={styles.workList}>
                <button type="button" className={styles.work} onClick={() => setSource('export')}>
                  <span>
                    <strong>修复导出失败</strong>
                    <small>
                      {feedback ? '已收到原话题的审查意见，继续同一项修复' : '正在检查修复结果，无需你处理'}
                    </small>
                  </span>
                  <span className={styles.workState}>{delivered ? '已交付' : '进行中'} ↗</span>
                </button>
                <button type="button" className={styles.work} onClick={() => setSource('release')}>
                  <span>
                    <strong>准备发布说明</strong>
                    <small>{decision ? '已收到你的决定，继续整理发布材料' : '需要确定本轮发布的优先级'}</small>
                  </span>
                  <span className={styles.workState}>{delivered ? '已交付' : decision ? '进行中' : '待你决定'} ↗</span>
                </button>
              </div>
              {!decision && (
                <section className={styles.question} aria-label="发布优先级决定">
                  <small>需要你的决定 · 来自版本发布准备</small>
                  <h2>这轮发布优先稳定性，还是赶上演示？</h2>
                  <p>建议先保证稳定性，演示使用已验证版本；这样不会把尚未完成的导出修复带入正式发布。</p>
                  <div className={styles.choices}>
                    <button
                      type="button"
                      disabled={!enabled}
                      className="console-button-primary"
                      onClick={() => reply('稳定性优先，演示使用已验证版本。')}
                    >
                      稳定性优先
                    </button>
                    <button
                      type="button"
                      disabled={!enabled}
                      className="console-button-secondary"
                      onClick={() => reply('演示优先，先准备演示范围与风险说明。')}
                    >
                      先准备演示
                    </button>
                  </div>
                </section>
              )}
            </article>
            {feedback && (
              <article className={styles.assistant}>
                <span className={styles.speaker}>我的助手</span>
                <p>导出修复的原话题收到了新意见，我已经把反馈接回同一项工作。当前仍是两件事，没有另外建单。</p>
              </article>
            )}
            {decision && (
              <>
                <div className={styles.user}>
                  <span>你</span>
                  <p>{decision}</p>
                </div>
                <article className={styles.assistant}>
                  <span className={styles.speaker}>我的助手</span>
                  <p>收到，决定已经带回发布准备。我继续推进，有可用结果再回来。</p>
                </article>
              </>
            )}
            {delivered && (
              <article className={styles.assistant}>
                <span className={styles.speaker}>我的助手</span>
                <p>两件事的结果已经准备好，并已回到各自的原话题。这里是摘要：</p>
                <ul>
                  <li>导出修复：复现与验证记录已整理，可以审查。</li>
                  <li>发布准备：按你的决定更新了发布说明与演示安排。</li>
                </ul>
                <button type="button" className="console-button-secondary" onClick={() => setSource('release')}>
                  查看原处交付
                </button>
              </article>
            )}
            {source && (
              <section className={styles.source} aria-label="原话题样例">
                <div className={styles.sourceTitle}>
                  <strong>{sampleThreads.find((item) => item.id === source)?.title}</strong>
                  <button type="button" aria-label="关闭原话题样例" onClick={() => setSource(null)}>
                    ×
                  </button>
                </div>
                <p>
                  {source === 'export'
                    ? '同事：导出在大文件时失败。审查补充：取消之后也要验证临时文件是否正确处理。'
                    : '同事：发布说明需要补上导出修复，演示版本还没定。'}
                </p>
                <p className={styles.muted}>原话题样例 · 正式版在这里打开真实会话与交付消息。</p>
              </section>
            )}
          </div>
        )}
      </div>
      {configured && (
        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            reply(draft);
          }}
        >
          <label className="sr-only" htmlFor="superagent-reply">
            回复我的助手
          </label>
          <textarea
            id="superagent-reply"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="补充决定，或告诉我下一步关注什么…"
            disabled={!enabled}
          />
          <div>
            <span>样例回复会续接上面的发布事项</span>
            <button type="submit" className="console-button-primary" disabled={!enabled || !draft.trim()}>
              发送
            </button>
          </div>
        </form>
      )}
      <dialog
        ref={dialog}
        className={styles.dialog}
        onCancel={() => set({ scopeOpen: false })}
        onClose={() => set({ scopeOpen: false })}
      >
        <div className={styles.sourceTitle}>
          <h2>监听范围</h2>
          <button type="button" aria-label="关闭监听范围" onClick={() => set({ scopeOpen: false })}>
            ×
          </button>
        </div>
        <p className={styles.muted}>关注选中的会话；未选中的内容不会用于主动接单。</p>
        <div className={styles.scopeList}>
          {sampleThreads.map((thread) => (
            <label key={thread.id}>
              <input
                type="checkbox"
                checked={scope.includes(thread.id)}
                onChange={(event) =>
                  set({ scope: event.target.checked ? [...scope, thread.id] : scope.filter((id) => id !== thread.id) })
                }
              />
              <span>
                <strong>{thread.title}</strong>
                <small>{thread.note}</small>
              </span>
            </label>
          ))}
        </div>
        <p className={styles.notice}>当前样例：调查、修改和验证由执行成员推进；发布与范围变化仍需要你决定。</p>
        <footer>
          <button type="button" className="console-button-secondary" onClick={() => set({ scopeOpen: false })}>
            关闭
          </button>
          <button
            type="button"
            className="console-button-primary"
            disabled={scope.length === 0}
            onClick={() => set({ scopeOpen: false, scene: 'active' })}
          >
            {configured ? '保存并监听' : '启用监听'}
          </button>
        </footer>
      </dialog>
    </section>
  );
}
