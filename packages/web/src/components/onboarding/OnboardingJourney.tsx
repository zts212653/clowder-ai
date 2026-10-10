'use client';

import { useCallback, useEffect, useState } from 'react';
import { DemoScenes } from './DemoScenes';
import { ClientSetup } from './ClientSetup';
import { MemberHandoff } from './MemberHandoff';
import { RealChatEntry } from './RealChatEntry';
import { type OnboardingState, createInitialState, saveState, loadState } from './onboarding-state';

interface OnboardingJourneyProps {
  onComplete: (message: string, members: Array<{ client: string; cat: string; catId: string }>) => void;
}

/**
 * 首次启动用户旅程主容器
 * 实现 issue#1466 的 8 幕分镜
 *
 * 场景流程：
 * 1-5: 脚本演示（三猫协作改进结果）
 * 6: 探测本机 client
 * 7: 从示范团队交接到真实伙伴
 * 8: 进入真实聊天
 */
export function OnboardingJourney({ onComplete }: OnboardingJourneyProps) {
  const [state, setState] = useState<OnboardingState>(createInitialState);

  // 从 localStorage 恢复状态
  useEffect(() => {
    const restored = loadState();
    if (restored) {
      setState(restored);
    }
  }, []);

  // 状态变化时保存
  useEffect(() => {
    saveState(state);
  }, [state]);

  const advanceScene = useCallback((nextScene: number) => {
    setState((prev) => ({
      ...prev,
      scene: nextScene,
      furthest: Math.max(prev.furthest, nextScene),
    }));
  }, []);

  const updateDemoState = useCallback((updates: Partial<Pick<OnboardingState, 'demoPaused' | 'demoScene'>>) => {
    setState((prev) => ({ ...prev, ...updates }));
  }, []);

  const handleClientsSelected = useCallback(
    (clients: Array<{ name: string; cliTool: string; provider: string }>) => {
      setState((prev) => ({
        ...prev,
        selectedClients: clients,
      }));
      advanceScene(7);
    },
    [advanceScene],
  );

  const handleMembersCreated = useCallback(
    (members: Array<{ client: string; cat: string; catId: string }>) => {
      setState((prev) => ({
        ...prev,
        members,
      }));
      advanceScene(8);
    },
    [advanceScene],
  );

  const handleChatStarted = useCallback(
    (message: string) => {
      onComplete(message, state.members);
    },
    [onComplete, state.members],
  );

  // 场景 1-5: 脚本演示
  if (state.scene <= 5) {
    return (
      <DemoScenes
        scene={state.scene}
        demoScene={state.demoScene}
        paused={state.demoPaused}
        onAdvance={advanceScene}
        onUpdateDemo={updateDemoState}
      />
    );
  }

  // 场景 6: client 探测与选择
  if (state.scene === 6) {
    return <ClientSetup onComplete={handleClientsSelected} />;
  }

  // 场景 7: 伙伴交接
  if (state.scene === 7) {
    return <MemberHandoff selectedClients={state.selectedClients} onComplete={handleMembersCreated} />;
  }

  // 场景 8: 进入真实聊天
  return <RealChatEntry members={state.members} onComplete={handleChatStarted} />;
}
