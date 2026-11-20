'use client';

import { create } from 'zustand';

const STORAGE_KEY = 'cat-cafe-voice-settings';

export interface CustomTerm {
  from: string;
  to: string;
}

export interface VoiceSettings {
  customTerms: CustomTerm[];
  customPrompt: string | null; // null = use default
  language: 'zh' | 'en' | ''; // '' = auto-detect
  microphoneDeviceId: string | null; // null = browser default
}

const DEFAULT_SETTINGS: VoiceSettings = {
  customTerms: [],
  customPrompt: null,
  language: 'zh',
  microphoneDeviceId: null,
};

const VALID_LANGUAGES = new Set<VoiceSettings['language']>(['zh', 'en', '']);

function isValidTerm(item: unknown): item is CustomTerm {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as CustomTerm).from === 'string' &&
    typeof (item as CustomTerm).to === 'string'
  );
}

function normalizeSettings(parsed: unknown): VoiceSettings {
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_SETTINGS;
  const obj = parsed as Record<string, unknown>;

  const customTerms = Array.isArray(obj.customTerms) ? obj.customTerms.filter(isValidTerm) : [];

  const customPrompt = typeof obj.customPrompt === 'string' ? obj.customPrompt : null;

  const language = VALID_LANGUAGES.has(obj.language as VoiceSettings['language'])
    ? (obj.language as VoiceSettings['language'])
    : 'zh';

  const microphoneDeviceId =
    typeof obj.microphoneDeviceId === 'string' && obj.microphoneDeviceId ? obj.microphoneDeviceId : null;
  return { customTerms, customPrompt, language, microphoneDeviceId };
}

function loadFromStorage(): VoiceSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveToStorage(settings: VoiceSettings): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

interface VoiceSettingsState {
  settings: VoiceSettings;

  addTerm: (from: string, to: string) => void;
  removeTerm: (index: number) => void;
  updateTerm: (index: number, from: string, to: string) => void;
  setCustomPrompt: (prompt: string | null) => void;
  setLanguage: (language: VoiceSettings['language']) => void;
  setMicrophoneDeviceId: (id: string | null) => void;
  loadSettings: () => void;
  resetAll: () => void;
}

export const useVoiceSettingsStore = create<VoiceSettingsState>((set) => ({
  settings: loadFromStorage(),

  addTerm: (from, to) =>
    set((state) => {
      const next = {
        ...state.settings,
        customTerms: [...state.settings.customTerms, { from, to }],
      };
      saveToStorage(next);
      return { settings: next };
    }),

  removeTerm: (index) =>
    set((state) => {
      const next = {
        ...state.settings,
        customTerms: state.settings.customTerms.filter((_, i) => i !== index),
      };
      saveToStorage(next);
      return { settings: next };
    }),

  updateTerm: (index, from, to) =>
    set((state) => {
      if (index < 0 || index >= state.settings.customTerms.length) return state;
      const terms = [...state.settings.customTerms];
      terms[index] = { from, to };
      const next = { ...state.settings, customTerms: terms };
      saveToStorage(next);
      return { settings: next };
    }),

  setCustomPrompt: (prompt) =>
    set((state) => {
      const next = { ...state.settings, customPrompt: prompt };
      saveToStorage(next);
      return { settings: next };
    }),

  setLanguage: (language) =>
    set((state) => {
      const next = { ...state.settings, language };
      saveToStorage(next);
      return { settings: next };
    }),

  setMicrophoneDeviceId: (microphoneDeviceId) =>
    set((state) => {
      const next = { ...state.settings, microphoneDeviceId };
      saveToStorage(next);
      return { settings: next };
    }),

  loadSettings: () => {
    set({ settings: loadFromStorage() });
  },

  resetAll: () => {
    saveToStorage(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
  },
}));
