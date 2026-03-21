import { create } from 'zustand';

export interface DeepForgeProject {
  id: string;
  title: string;
  phase: string;
  currentIteration: number;
  totalIterations: number;
  totalCostUsd: number;
  totalTokens: number;
  isRunning: boolean;
  source: string;
  tasks: { role: string; status: string; description?: string; error?: string; output?: string; startedAt?: string }[];
}

interface DeepForgeStore {
  projects: DeepForgeProject[];
  loading: boolean;
  error: string | null;

  // Detail view
  selectedProject: string | null;
  detailState: any | null;
  detailLogs: string[];
  detailLoading: boolean;

  // Actions
  fetchProjects: () => Promise<void>;
  selectProject: (id: string | null) => void;
  fetchDetail: (id: string) => Promise<void>;
  fetchLogs: (id: string) => Promise<void>;
}

export const useDeepForgeStore = create<DeepForgeStore>((set, get) => ({
  projects: [],
  loading: false,
  error: null,
  selectedProject: null,
  detailState: null,
  detailLogs: [],
  detailLoading: false,

  fetchProjects: async () => {
    try {
      set({ loading: true });
      const projects = await window.mlb.deepforge.list();
      set({ projects, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ loading: false });
    }
  },

  selectProject: (id) => {
    set({ selectedProject: id, detailState: null, detailLogs: [] });
    if (id) {
      get().fetchDetail(id);
      get().fetchLogs(id);
    }
  },

  fetchDetail: async (id) => {
    try {
      set({ detailLoading: true });
      const state = await window.mlb.deepforge.status(id);
      set({ detailState: state });
    } catch {
      set({ detailState: null });
    } finally {
      set({ detailLoading: false });
    }
  },

  fetchLogs: async (id) => {
    try {
      const logs = await window.mlb.deepforge.logs(id, 50);
      set({ detailLogs: logs });
    } catch {
      set({ detailLogs: [] });
    }
  },
}));
