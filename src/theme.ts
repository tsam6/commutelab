import { createContext, useContext } from 'react';

// ============================================================================
// CommuteLab semantic colour tokens (cool slate family + one accent, #FF5500).
// Shape lock: pills 9999px | cards & sheets 16px | inner 8px. Tabular numerals everywhere.
// Phase colours are shared by the maps, the diagram, strips and charts.
// ============================================================================
export type ThemeName = 'dark' | 'light';

export const getSemanticTokens = (theme: ThemeName) => {
  const isDark = theme === 'dark';
  return {
    isDark,
    accent: '#FF5500',
    accentSubtle: isDark ? 'rgba(255, 85, 0, 0.15)' : 'rgba(255, 85, 0, 0.10)',
    accentBorder: isDark ? 'rgba(255, 85, 0, 0.40)' : 'rgba(255, 85, 0, 0.30)',
    systemBackground: isDark ? '#090A0F' : '#F2F4F7',
    secondarySystemBackground: isDark ? '#12141C' : '#FFFFFF',
    tertiarySystemBackground: isDark ? '#1B1E2B' : '#E8ECF2',
    elevatedSheet: isDark ? '#141722' : '#FFFFFF',
    mapCanvas: isDark ? '#0C0E16' : '#EBF0F5',
    label: isDark ? '#F8FAFC' : '#0F172A',
    secondaryLabel: isDark ? '#94A3B8' : '#475569',
    tertiaryLabel: isDark ? '#64748B' : '#94A3B8',
    separator: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(15, 23, 42, 0.08)',
    statusPositive: isDark ? '#30D158' : '#16A34A',
    statusPositiveBg: isDark ? 'rgba(48, 209, 88, 0.14)' : 'rgba(22, 163, 74, 0.12)',
    statusWarning: isDark ? '#FFD60A' : '#D97706',
    statusWarningBg: isDark ? 'rgba(255, 214, 10, 0.14)' : 'rgba(217, 119, 6, 0.12)',
    statusDelayed: isDark ? '#FF453A' : '#DC2626',
    statusDelayedBg: isDark ? 'rgba(255, 69, 58, 0.14)' : 'rgba(220, 38, 38, 0.12)',
    phase: {
      buffer: isDark ? '#6C7488' : '#94A3B8',
      bike: isDark ? '#2EE59D' : '#0E9F6E',
      wait: isDark ? '#FFB020' : '#C77D00',
      transfer: isDark ? '#FF7F50' : '#E0603A',
      train: isDark ? '#5B8CFF' : '#2F62E0',
    },
    mapStyle: isDark ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/positron',
  };
};

export type Tokens = ReturnType<typeof getSemanticTokens>;
export const ThemeCtx = createContext<Tokens>(getSemanticTokens('dark'));
export const useT = () => useContext(ThemeCtx);

export const PHASE_LABELS: Record<string, string> = {
  buffer: 'Walk buffer',
  bike: 'Bike',
  wait: 'Platform wait',
  transfer: 'Transfer',
  train: 'Train',
};
