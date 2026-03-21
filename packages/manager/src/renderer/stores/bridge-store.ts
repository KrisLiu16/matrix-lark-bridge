import { create } from 'zustand';
import type { BridgeStatus, BridgeConfig, SessionState } from '@mlb/shared';
import { toast } from './toast-store';
import { t } from '../i18n';

interface BridgeStore {
  bridges: BridgeStatus[];
  loading: boolean;
  error: string | null;

  // Current page state
  currentPage: 'list' | 'config' | 'new' | 'logs' | 'session' | 'files' | 'forge';
  selectedBridge: string | null;

  // Actions
  fetchBridges: () => Promise<void>;
  startBridge: (name: string) => Promise<void>;
  stopBridge: (name: string) => Promise<void>;
  restartBridge: (name: string) => Promise<void>;
  deleteBridge: (name: string) => Promise<void>;
  createBridge: (config: BridgeConfig) => Promise<void>;
  updateConfig: (name: string, config: Partial<BridgeConfig>) => Promise<void>;

  // Navigation
  navigate: (page: 'list' | 'config' | 'new' | 'logs' | 'session' | 'files' | 'forge', bridgeName?: string) => void;
}

export const useBridgeStore = create<BridgeStore>((set, get) => ({
  bridges: [],
  loading: false,
  error: null,
  currentPage: 'list',
  selectedBridge: null,

  fetchBridges: async () => {
    try {
      const bridges = await window.mlb.bridge.list();
      set({ bridges, error: null });
    } catch (err) {
      set({ error: (err as Error).message });
    }
  },

  startBridge: async (name: string) => {
    try {
      set({ loading: true, error: null });
      await window.mlb.bridge.start(name);
      await new Promise((r) => setTimeout(r, 500));
      await get().fetchBridges();
      toast.success(t('bridge.toast.started', { name }));
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      toast.error(t('bridge.toast.error', { error: msg }));
    } finally {
      set({ loading: false });
    }
  },

  stopBridge: async (name: string) => {
    try {
      set({ loading: true, error: null });
      await window.mlb.bridge.stop(name);
      await new Promise((r) => setTimeout(r, 300));
      await get().fetchBridges();
      toast.success(t('bridge.toast.stopped', { name }));
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      toast.error(t('bridge.toast.error', { error: msg }));
    } finally {
      set({ loading: false });
    }
  },

  restartBridge: async (name: string) => {
    try {
      set({ loading: true, error: null });
      await window.mlb.bridge.restart(name);
      await new Promise((r) => setTimeout(r, 800));
      await get().fetchBridges();
      toast.success(t('bridge.toast.restarted', { name }));
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      toast.error(t('bridge.toast.error', { error: msg }));
    } finally {
      set({ loading: false });
    }
  },

  deleteBridge: async (name: string) => {
    try {
      set({ loading: true, error: null });
      await window.mlb.bridge.delete(name);
      await get().fetchBridges();
      // If the deleted bridge was selected, clear selection
      if (get().selectedBridge === name) {
        set({ selectedBridge: null, currentPage: 'list' });
      }
      toast.success(t('bridge.toast.deleted', { name }));
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      toast.error(t('bridge.toast.error', { error: msg }));
    } finally {
      set({ loading: false });
    }
  },

  createBridge: async (config: BridgeConfig) => {
    try {
      set({ loading: true, error: null });
      await window.mlb.bridge.create(config);
      await get().fetchBridges();
      set({ currentPage: 'list', selectedBridge: config.name });
      toast.success(t('bridge.toast.created', { name: config.name }));
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      toast.error(t('bridge.toast.error', { error: msg }));
    } finally {
      set({ loading: false });
    }
  },

  updateConfig: async (name: string, config: Partial<BridgeConfig>) => {
    try {
      set({ loading: true, error: null });
      await window.mlb.bridge.updateConfig(name, config);
      toast.success(t('config.saved'));
    } catch (err) {
      const msg = (err as Error).message;
      set({ error: msg });
      toast.error(t('bridge.toast.error', { error: msg }));
    } finally {
      set({ loading: false });
    }
  },

  navigate: (page, bridgeName) => {
    set({ currentPage: page, selectedBridge: bridgeName ?? null });
  },
}));
