// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoiceSettingsStore } from '../voiceSettingsStore';

const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    mockStorage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete mockStorage[key];
  }),
  clear: vi.fn(() => {
    for (const k of Object.keys(mockStorage)) delete mockStorage[k];
  }),
  get length() {
    return Object.keys(mockStorage).length;
  },
  key: vi.fn(() => null),
};

vi.stubGlobal('localStorage', mockLocalStorage);

beforeEach(() => {
  mockLocalStorage.clear();
  vi.clearAllMocks();
  useVoiceSettingsStore.setState({
    settings: { customTerms: [], customPrompt: null, language: 'zh' },
  });
});

describe('voiceSettingsStore', () => {
  it('starts with default settings', () => {
    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([]);
    expect(settings.customPrompt).toBeNull();
    expect(settings.language).toBe('zh');
  });

  it('adds a custom term and persists to localStorage', () => {
    useVoiceSettingsStore.getState().addTerm('测试词', '正确词');
    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([{ from: '测试词', to: '正确词' }]);
    expect(mockLocalStorage.setItem).toHaveBeenCalled();

    const stored = JSON.parse(mockStorage['cat-cafe-voice-settings']);
    expect(stored.customTerms).toEqual([{ from: '测试词', to: '正确词' }]);
  });

  it('removes a custom term by index', () => {
    const store = useVoiceSettingsStore.getState();
    store.addTerm('a', 'A');
    store.addTerm('b', 'B');
    store.addTerm('c', 'C');
    useVoiceSettingsStore.getState().removeTerm(1);
    expect(useVoiceSettingsStore.getState().settings.customTerms).toEqual([
      { from: 'a', to: 'A' },
      { from: 'c', to: 'C' },
    ]);
  });

  it('updates a term at specific index', () => {
    useVoiceSettingsStore.getState().addTerm('old', 'OLD');
    useVoiceSettingsStore.getState().updateTerm(0, 'new', 'NEW');
    expect(useVoiceSettingsStore.getState().settings.customTerms[0]).toEqual({
      from: 'new',
      to: 'NEW',
    });
  });

  it('sets custom prompt', () => {
    useVoiceSettingsStore.getState().setCustomPrompt('my custom prompt');
    expect(useVoiceSettingsStore.getState().settings.customPrompt).toBe('my custom prompt');
  });

  it('clears custom prompt with null', () => {
    useVoiceSettingsStore.getState().setCustomPrompt('temp');
    useVoiceSettingsStore.getState().setCustomPrompt(null);
    expect(useVoiceSettingsStore.getState().settings.customPrompt).toBeNull();
  });

  it('sets language', () => {
    useVoiceSettingsStore.getState().setLanguage('en');
    expect(useVoiceSettingsStore.getState().settings.language).toBe('en');
  });

  it('sets auto-detect language with empty string', () => {
    useVoiceSettingsStore.getState().setLanguage('');
    expect(useVoiceSettingsStore.getState().settings.language).toBe('');
  });

  it('recovers gracefully from corrupted localStorage (customTerms not array)', () => {
    // Simulate corrupted data: customTerms is a string instead of array
    mockStorage['cat-cafe-voice-settings'] = JSON.stringify({
      customTerms: 'not-an-array',
      customPrompt: 42,
      language: 'invalid',
    });

    // loadSettings re-reads from localStorage and normalizes
    useVoiceSettingsStore.getState().loadSettings();
    const { settings } = useVoiceSettingsStore.getState();

    expect(Array.isArray(settings.customTerms)).toBe(true);
    expect(settings.customTerms).toEqual([]);
    expect(settings.customPrompt).toBeNull();
    expect(settings.language).toBe('zh');
  });

  it('filters out malformed term entries from localStorage', () => {
    mockStorage['cat-cafe-voice-settings'] = JSON.stringify({
      customTerms: [
        { from: 'valid', to: 'ok' },
        { from: 123, to: 'bad-from' }, // from is not string
        'not-an-object', // not an object at all
        { from: 'also-valid', to: 'fine' },
      ],
    });

    useVoiceSettingsStore.getState().loadSettings();
    const { settings } = useVoiceSettingsStore.getState();

    expect(settings.customTerms).toEqual([
      { from: 'valid', to: 'ok' },
      { from: 'also-valid', to: 'fine' },
    ]);
  });

  it('ignores updateTerm with out-of-range index', () => {
    // Empty store: updateTerm(3) would create sparse array → crash mergeTermEntries
    useVoiceSettingsStore.getState().updateTerm(3, 'x', 'X');
    expect(useVoiceSettingsStore.getState().settings.customTerms).toEqual([]);

    // Also test negative index
    useVoiceSettingsStore.getState().addTerm('a', 'A');
    useVoiceSettingsStore.getState().updateTerm(-1, 'b', 'B');
    expect(useVoiceSettingsStore.getState().settings.customTerms).toEqual([{ from: 'a', to: 'A' }]);
  });

  it('resets all settings to defaults', () => {
    const store = useVoiceSettingsStore.getState();
    store.addTerm('x', 'X');
    store.setCustomPrompt('custom');
    store.setLanguage('en');
    useVoiceSettingsStore.getState().resetAll();

    const { settings } = useVoiceSettingsStore.getState();
    expect(settings.customTerms).toEqual([]);
    expect(settings.customPrompt).toBeNull();
    expect(settings.language).toBe('zh');
  });
});
