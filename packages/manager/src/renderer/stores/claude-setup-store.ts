import { create } from 'zustand';

export interface ConfigItem {
  key: string;
  value: string;
  masked?: boolean;
}

export interface StepProgress {
  step: number;
  totalSteps: number;
  status: 'running' | 'done' | 'error' | 'pending';
  id: string;
  label: string;
  detail?: string;
  config?: ConfigItem[];
  error?: string;
}

interface ClaudeSetupStore {
  installed: boolean | null;
  version?: string;
  path?: string;
  checking: boolean;
  installing: boolean;
  steps: StepProgress[];
  installError: string | null;

  checkClaude: () => Promise<void>;
  installClaude: () => Promise<void>;
  updateStep: (progress: StepProgress) => void;
}

export const useClaudeSetupStore = create<ClaudeSetupStore>((set) => ({
  installed: null,
  version: undefined,
  path: undefined,
  checking: false,
  installing: false,
  steps: [],
  installError: null,

  checkClaude: async () => {
    set({ checking: true });
    try {
      const status = await window.mlb.claude.check();
      set({ installed: status.installed, version: status.version, path: status.path, checking: false });
    } catch {
      set({ installed: false, checking: false });
    }
  },

  installClaude: async () => {
    set({ installing: true, steps: [], installError: null });
    try {
      const status = await window.mlb.claude.install();
      set({ installed: status.installed, version: status.version, path: status.path, installing: false });
    } catch (err) {
      set({ installing: false, installError: (err as Error).message });
    }
  },

  updateStep: (progress) => {
    set((state) => {
      const steps = [...state.steps];
      const idx = steps.findIndex((s) => s.step === progress.step);
      if (idx >= 0) steps[idx] = progress;
      else steps.push(progress);
      return { steps, installError: progress.error || state.installError };
    });
  },
}));
