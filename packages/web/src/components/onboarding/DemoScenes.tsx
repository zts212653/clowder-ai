'use client';

import { useEffect, useState } from 'react';
import styles from './DemoScenes.module.css';

interface DemoScenesProps {
  scene: number;
  demoScene: number;
  paused: boolean;
  onAdvance: (nextScene: number) => void;
  onUpdateDemo: (updates: { demoPaused?: boolean; demoScene?: number }) => void;
}

/**
 * 场景 1-5: 脚本演示
 * 展示三猫协作改进结果的过程
 */
export function DemoScenes({ scene, paused, onAdvance, onUpdateDemo }: DemoScenesProps) {
  const [typingText, setTypingText] = useState('');
  const [typingIndex, setTypingIndex] = useState(0);

  const fullText = '帮我写一段猫咖欢迎文案，并请另一只猫帮我看看新用户是否能看懂。';

  useEffect(() => {
    if (scene !== 2 || paused || typingIndex >= fullText.length) return;
    const timer = setTimeout(() => {
      setTypingIndex((prev) => prev + 1);
      setTypingText(fullText.slice(0, typingIndex + 1));
    }, 30);
    return () => clearTimeout(timer);
  }, [scene, typingIndex, paused, fullText]);

  useEffect(() => {
    if (scene !== 2 || paused || typingIndex < fullText.length) return;
    const timer = setTimeout(() => onAdvance(3), 500);
    return () => clearTimeout(timer);
  }, [scene, typingIndex, paused, onAdvance, fullText.length]);

  useEffect(() => {
    if (paused || (scene !== 3 && scene !== 4)) return;
    const timer = setTimeout(() => onAdvance(scene + 1), scene === 3 ? 1800 : 2200);
    return () => clearTimeout(timer);
  }, [scene, paused, onAdvance]);

  // 场景 1: 三只猫先出现
  if (scene === 1) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>看懂一次协作，再得到自己的伙伴</h1>
          <p>先演示，后配置，最后自由交流</p>
          <span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
        </div>

        <div className={styles.scene}>
          <h2>1. 三只猫先出现</h2>
          <p className={styles.lead}>这是脚本演示的开场，你可以按自己的节奏点击开始。</p>

          <div className={styles.stage}>
            <span className={styles.mockLabel}>mock：三只猫的 idle 动作</span>
            <div className={styles.cats}>
              <div className={styles.cat}>
                <div className={`${styles.face} ${styles.ragdoll}`}>布</div>
                <b>布偶猫</b>
              </div>
              <div className={styles.cat}>
                <div className={`${styles.face} ${styles.maine}`}>缅</div>
                <b>缅因猫</b>
              </div>
              <div className={styles.cat}>
                <div className={`${styles.face} ${styles.siamese}`}>暹</div>
                <b>暹罗猫</b>
              </div>
            </div>
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => {
                onUpdateDemo({ demoScene: 2 });
                onAdvance(2);
              }}
            >
              开始看演示
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 场景 2: 输入框自动打字
  if (scene === 2) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>看懂一次协作，再得到自己的伙伴</h1>
          <p>先演示，后配置，最后自由交流</p>
          <span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
        </div>

        <div className={styles.controls}>
          <button type="button" onClick={() => onUpdateDemo({ demoPaused: !paused })} className={styles.controlButton}>
            {paused ? '继续' : '暂停'}
          </button>
        </div>

        <div className={styles.scene}>
          <h2>2. 输入框自动打字</h2>
          <p className={styles.lead}>自动打字是演示脚本，不伪装成用户已经发送。</p>

          <div className={styles.stage}>
            <div className={styles.compose}>
              <textarea readOnly rows={2} value={typingText} className={styles.typingArea} />
              {typingIndex >= fullText.length && (
                <div className={styles.systemMsg}>脚本发送完成，接下来展示 @ 协作。</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 场景 3: 一只猫接住消息并 @ 同伴
  if (scene === 3) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>看懂一次协作，再得到自己的伙伴</h1>
          <span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
        </div>

        <div className={styles.scene}>
          <h2>3. 一只猫接住消息并 @ 同伴</h2>
          <p className={styles.lead}>猫跑向消息气泡，缩成同一只猫的头像，然后给出初稿并邀请审查。</p>

          <div className={styles.stage}>
            <div className={styles.chat}>
              <div className={styles.msgUser}>{fullText}</div>
              <div className={styles.msgCat}>
                布偶猫：我先写一个初稿。
                <br />
                <br />
                欢迎来到我们的猫咖，支持 <strong>@缅因猫</strong> 进行 A2A 协作。
              </div>
              <div className={styles.msgAgent}>
                缅因猫正在加入协作…… <span className={styles.typing} />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 场景 4: 因为协作，结果变好了
  if (scene === 4) {
    return (
      <div className={styles.container}>
        <div className={styles.header}>
          <h1>看懂一次协作，再得到自己的伙伴</h1>
          <span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
        </div>

        <div className={styles.scene}>
          <h2>4. 因为协作，结果变好了</h2>
          <p className={styles.lead}>重点不是多了几条消息，而是同一个结果被审查后变得更容易理解。</p>

          <div className={styles.stage}>
            <div className={styles.diff}>
              <div>
                <b>初稿</b>
                <p>
                  欢迎来到我们的猫咖，支持 <span className={styles.strike}>A2A 协作</span>。
                </p>
              </div>
              <div className={styles.diffAfter}>
                <b>布偶猫改稿</b>
                <p>
                  欢迎来到我们的猫咖，
                  <span className={styles.highlight}>几只猫会互相搭把手，把事情一起做好</span>。
                </p>
              </div>
            </div>

            <div className={styles.chat}>
              <div className={styles.msgAgent}>缅因猫：A2A 协作对新用户太难理解，建议换成日常说法。</div>
              <div className={styles.msgCat}>布偶猫：收到，我已经把术语改成“几只猫会互相搭把手”。</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // 场景 5: 解说收束
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1>看懂一次协作，再得到自己的伙伴</h1>
        <span className={styles.mockBadge}>演示数据 · 不调用真实模型</span>
      </div>

      <div className={styles.scene}>
        <h2>5. 解说收束</h2>
        <p className={styles.lead}>解说猫说明演示与真实使用的边界，点击下一步才进入配置。</p>

        <div className={styles.stage}>
          <div className={styles.handoff}>
            <div className={`${styles.face} ${styles.siamese}`}>暹</div>
            <div>
              <b>暹罗猫 · 解说</b>
              <p>你告诉我们目标，我们会自己分工。需要你决定时，再带着结果回来。刚才是演示，接下来配置你自己的伙伴。</p>
            </div>
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.primaryButton} onClick={() => onAdvance(6)}>
              下一步：配置我的伙伴
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
