/**
 * 首启旅程状态管理
 * 基于 v2 原型的状态机设计
 */

const STORAGE_KEY = 'clowder-onboarding-v2';

export interface OnboardingState {
	scene: number; // 当前场景 (1-8)
	furthest: number; // 用户到达的最远场景
	demoScene: number; // 演示脚本进度 (1-5)
	demoPaused: boolean; // 演示是否暂停
	selectedClients: Array<{
		name: string;
		cliTool: string;
		provider: string;
		accountRef?: string;
		authType?: string;
	}>;
	members: Array<{
		client: string;
		cat: string;
		catId: string;
	}>;
	completedAt?: number;
}

export function createInitialState(): OnboardingState {
  return {
    scene: 1,
    furthest: 1,
    demoScene: 1,
    demoPaused: false,
    selectedClients: [],
    members: [],
  };
}

export function saveState(state: OnboardingState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save onboarding state:', error);
  }
}

export function loadState(): OnboardingState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // 验证状态结构
    if (
      typeof parsed.scene === 'number' &&
      typeof parsed.furthest === 'number' &&
      Array.isArray(parsed.selectedClients) &&
      Array.isArray(parsed.members)
    ) {
      return parsed as OnboardingState;
    }
    return null;
  } catch (error) {
    console.warn('Failed to load onboarding state:', error);
    return null;
  }
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to clear onboarding state:', error);
  }
}
