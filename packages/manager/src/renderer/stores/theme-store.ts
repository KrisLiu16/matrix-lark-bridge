import { create } from 'zustand';

export type Theme = 'light' | 'dark' | 'system';

function getEffectiveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
}

function applyTheme(effective: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', effective === 'dark');
}

interface ThemeStore {
  theme: Theme;
  effective: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  // Restore from localStorage
  const stored = localStorage.getItem('mlb-theme') as Theme | null;
  const theme: Theme = stored && ['light', 'dark', 'system'].includes(stored) ? stored : 'system';
  const effective = getEffectiveTheme(theme);
  applyTheme(effective);

  // Listen to system preference changes
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', () => {
    const state = get();
    if (state.theme === 'system') {
      const eff = getEffectiveTheme('system');
      applyTheme(eff);
      set({ effective: eff });
    }
  });

  return {
    theme,
    effective,
    setTheme: (newTheme: Theme) => {
      localStorage.setItem('mlb-theme', newTheme);
      const eff = getEffectiveTheme(newTheme);
      applyTheme(eff);
      set({ theme: newTheme, effective: eff });
    },
  };
});
