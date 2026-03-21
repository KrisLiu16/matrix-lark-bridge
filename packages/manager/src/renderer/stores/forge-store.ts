import { create } from 'zustand';

export interface ForgeProject {
  id: string;
  title: string;
  phase: string;
  currentIteration: number;
  totalIterations: number;
  totalCostUsd: number;
  isRunning: boolean;
  source: string;
  tasks: { role: string; status: string; description?: string; error?: string; output?: string; startedAt?: number }[];
}

interface ForgeStore {
  projects: ForgeProject[];
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

export const useForgeStore = create<ForgeStore>((set, get) => ({
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
      const projects = await window.mlb.forge.list();
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
      const state = await window.mlb.forge.status(id);
      set({ detailState: state });
    } catch {
      set({ detailState: null });
    } finally {
      set({ detailLoading: false });
    }
  },

  fetchLogs: async (id) => {
    try {
      const logs = await window.mlb.forge.logs(id, 50);
      set({ detailLogs: logs });
    } catch {
      set({ detailLogs: [] });
    }
  },
}));
