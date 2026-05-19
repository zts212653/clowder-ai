import { create } from 'zustand';

export interface ThreadLabel {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdBy: string;
  createdAt: number;
}

interface LabelState {
  labels: ThreadLabel[];
  isLoading: boolean;
  fetchLabels: () => Promise<void>;
  createLabel: (name: string, color: string) => Promise<ThreadLabel | null>;
  updateLabel: (id: string, fields: Partial<Pick<ThreadLabel, 'name' | 'color' | 'sortOrder'>>) => Promise<void>;
  deleteLabel: (id: string) => Promise<void>;
}

export const useLabelStore = create<LabelState>((set, get) => ({
  labels: [],
  isLoading: false,

  fetchLabels: async () => {
    set({ isLoading: true });
    try {
      const { apiFetch } = await import('@/utils/api-client');
      const res = await apiFetch('/api/labels');
      if (!res.ok) return;
      const data = await res.json();
      set({ labels: Array.isArray(data) ? data : [] });
    } catch {
      /* ignore — labels are non-critical */
    } finally {
      set({ isLoading: false });
    }
  },

  createLabel: async (name, color) => {
    try {
      const { apiFetch } = await import('@/utils/api-client');
      const res = await apiFetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color, sortOrder: get().labels.length }),
      });
      if (!res.ok) return null;
      const label: ThreadLabel = await res.json();
      set((state) => ({ labels: [...state.labels, label] }));
      return label;
    } catch {
      return null;
    }
  },

  updateLabel: async (id, fields) => {
    try {
      const { apiFetch } = await import('@/utils/api-client');
      const res = await apiFetch(`/api/labels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) return;
      const updated: ThreadLabel = await res.json();
      set((state) => ({
        labels: state.labels.map((l) => (l.id === id ? updated : l)),
      }));
    } catch {
      /* ignore */
    }
  },

  deleteLabel: async (id) => {
    try {
      const { apiFetch } = await import('@/utils/api-client');
      const res = await apiFetch(`/api/labels/${id}`, { method: 'DELETE' });
      if (!res.ok) return;
      set((state) => ({
        labels: state.labels.filter((l) => l.id !== id),
      }));
      const { useChatStore } = await import('./chatStore');
      const store = useChatStore.getState();
      if (store.threads.some((t) => t.labels?.includes(id))) {
        store.setThreads(
          store.threads.map((t) => {
            if (!t.labels?.includes(id)) return t;
            const filtered = t.labels.filter((l) => l !== id);
            return { ...t, labels: filtered.length > 0 ? filtered : undefined };
          }),
        );
      }
    } catch {
      /* ignore */
    }
  },
}));
