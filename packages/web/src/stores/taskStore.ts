import { create } from 'zustand';

export interface TaskItem {
  id: string;
  kind: 'work' | 'pr_tracking';
  threadId: string;
  title: string;
  ownerCatId: string | null;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  why: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface TaskState {
  tasks: TaskItem[];
  setTasks: (tasks: TaskItem[]) => void;
  addTask: (task: TaskItem) => void;
  updateTask: (task: TaskItem) => void;
  removeTask: (taskId: string) => void;
  clearTasks: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],

  setTasks: (tasks) => set({ tasks }),

  addTask: (task) =>
    set((state) => {
      if (state.tasks.some((t) => t.id === task.id)) return state;
      return { tasks: [...state.tasks, task] };
    }),

  updateTask: (task) =>
    set((state) => {
      const exists = state.tasks.some((t) => t.id === task.id);
      if (exists) {
        return { tasks: state.tasks.map((t) => (t.id === task.id ? task : t)) };
      }
      // Upsert: task_updated for unknown task → insert it
      return { tasks: [...state.tasks, task] };
    }),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  clearTasks: () => set({ tasks: [] }),
}));
