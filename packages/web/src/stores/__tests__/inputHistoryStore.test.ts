// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInputHistoryStore } from '../inputHistoryStore';

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
  useInputHistoryStore.setState({ entries: [] });
});

describe('inputHistoryStore', () => {
  it('starts with empty entries', () => {
    expect(useInputHistoryStore.getState().entries).toEqual([]);
  });

  it('adds an entry and persists to localStorage', () => {
    useInputHistoryStore.getState().addEntry('hello world');
    expect(useInputHistoryStore.getState().entries).toEqual(['hello world']);
    expect(mockLocalStorage.setItem).toHaveBeenCalled();
    const stored = JSON.parse(mockStorage['cat-cafe-input-history']);
    expect(stored).toEqual(['hello world']);
  });

  it('prepends new entries (most recent first)', () => {
    const store = useInputHistoryStore.getState();
    store.addEntry('first');
    store.addEntry('second');
    store.addEntry('third');
    expect(useInputHistoryStore.getState().entries).toEqual(['third', 'second', 'first']);
  });

  it('deduplicates — moves existing entry to front', () => {
    const store = useInputHistoryStore.getState();
    store.addEntry('alpha');
    store.addEntry('beta');
    store.addEntry('alpha'); // duplicate
    expect(useInputHistoryStore.getState().entries).toEqual(['alpha', 'beta']);
  });

  it('ignores empty/whitespace-only entries', () => {
    const store = useInputHistoryStore.getState();
    store.addEntry('');
    store.addEntry('   ');
    store.addEntry('\n');
    expect(useInputHistoryStore.getState().entries).toEqual([]);
  });

  it('caps at MAX_ENTRIES (500), dropping oldest', () => {
    const store = useInputHistoryStore.getState();
    for (let i = 0; i < 510; i++) {
      store.addEntry(`entry-${i}`);
    }
    const entries = useInputHistoryStore.getState().entries;
    expect(entries.length).toBe(500);
    expect(entries[0]).toBe('entry-509'); // most recent
    expect(entries[499]).toBe('entry-10'); // oldest kept
  });

  it('findMatch returns suffix for prefix match', () => {
    const store = useInputHistoryStore.getState();
    store.addEntry('hello world');
    store.addEntry('hello there');
    store.addEntry('hey');
    // Most recent match for "hello" should be "hello there" (index 0 among "hello*")
    const match = useInputHistoryStore.getState().findMatch('hello');
    expect(match).toBe('hello there');
  });

  it('findMatch returns null for no match', () => {
    useInputHistoryStore.getState().addEntry('hello world');
    expect(useInputHistoryStore.getState().findMatch('xyz')).toBeNull();
  });

  it('findMatch returns null for empty prefix', () => {
    useInputHistoryStore.getState().addEntry('hello');
    expect(useInputHistoryStore.getState().findMatch('')).toBeNull();
  });

  it('findMatch is case-insensitive', () => {
    useInputHistoryStore.getState().addEntry('Hello World');
    expect(useInputHistoryStore.getState().findMatch('hello')).toBe('Hello World');
  });

  it('findMatch skips exact matches (no ghost text for complete input)', () => {
    useInputHistoryStore.getState().addEntry('hello');
    expect(useInputHistoryStore.getState().findMatch('hello')).toBeNull();
  });

  it('search returns entries matching query (fuzzy substring)', () => {
    const store = useInputHistoryStore.getState();
    store.addEntry('fix the bug');
    store.addEntry('add new feature');
    store.addEntry('bugfix for login');
    const results = useInputHistoryStore.getState().search('bug');
    expect(results).toEqual(['bugfix for login', 'fix the bug']);
  });

  it('search is case-insensitive', () => {
    useInputHistoryStore.getState().addEntry('Hello World');
    expect(useInputHistoryStore.getState().search('hello')).toEqual(['Hello World']);
  });

  it('search returns empty array for empty query', () => {
    useInputHistoryStore.getState().addEntry('hello');
    expect(useInputHistoryStore.getState().search('')).toEqual([]);
  });

  it('loads from localStorage on init', () => {
    mockStorage['cat-cafe-input-history'] = JSON.stringify(['saved-1', 'saved-2']);
    useInputHistoryStore.getState().loadFromStorage();
    expect(useInputHistoryStore.getState().entries).toEqual(['saved-1', 'saved-2']);
  });

  it('recovers from corrupted localStorage', () => {
    mockStorage['cat-cafe-input-history'] = 'not-json!!!';
    useInputHistoryStore.getState().loadFromStorage();
    expect(useInputHistoryStore.getState().entries).toEqual([]);
  });

  it('filters non-string entries from localStorage', () => {
    mockStorage['cat-cafe-input-history'] = JSON.stringify(['valid', 42, null, 'also-valid']);
    useInputHistoryStore.getState().loadFromStorage();
    expect(useInputHistoryStore.getState().entries).toEqual(['valid', 'also-valid']);
  });

  it('clearHistory removes all entries and clears storage', () => {
    const store = useInputHistoryStore.getState();
    store.addEntry('will be cleared');
    store.clearHistory();
    expect(useInputHistoryStore.getState().entries).toEqual([]);
    expect(mockStorage['cat-cafe-input-history']).toBeUndefined();
  });
});
