import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInitialState, saveState, loadState, clearState, type OnboardingState } from '../onboarding-state';

// Mock localStorage for Vitest
const localStorageMock = (() => {
	let store: Record<string, string> = {};
	return {
		getItem: (key: string) => store[key] || null,
		setItem: (key: string, value: string) => {
			store[key] = value;
		},
		removeItem: (key: string) => {
			delete store[key];
		},
		clear: () => {
			store = {};
		},
	};
})();

vi.stubGlobal('localStorage', localStorageMock);

describe('onboarding-state', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('should create initial state', () => {
		const state = createInitialState();
		expect(state.scene).toBe(1);
		expect(state.furthest).toBe(1);
		expect(state.demoScene).toBe(1);
		expect(state.demoPaused).toBe(false);
		expect(state.selectedClients).toEqual([]);
		expect(state.members).toEqual([]);
	});

	it('should save and load state', () => {
		const state: OnboardingState = {
			scene: 3,
			furthest: 5,
			demoScene: 3,
			demoPaused: false,
			selectedClients: [{ name: 'Claude Code', cliTool: 'claude', provider: 'anthropic' }],
			members: [{ client: 'Claude Code', cat: 'siamese', catId: 'siamese-claude' }],
		};

		saveState(state);
		const loaded = loadState();

		expect(loaded).toEqual(state);
	});

	it('should return null for invalid state', () => {
		localStorage.setItem('clowder-onboarding-v2', 'invalid json');
		const loaded = loadState();
		expect(loaded).toBeNull();
	});

	it('should return null for missing state', () => {
		const loaded = loadState();
		expect(loaded).toBeNull();
	});

	it('should clear state', () => {
		const state = createInitialState();
		saveState(state);
		expect(loadState()).not.toBeNull();

		clearState();
		expect(loadState()).toBeNull();
	});

	it('should validate state structure on load', () => {
		localStorage.setItem(
			'clowder-onboarding-v2',
			JSON.stringify({
				scene: 'invalid', // 应该是 number
				furthest: 1,
				selectedClients: [],
				members: [],
			}),
		);

		const loaded = loadState();
		expect(loaded).toBeNull();
	});
});
