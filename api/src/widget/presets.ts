/**
 * Built-in widget theme presets. Selecting one via
 * `POST .../widget/theme/apply-preset` replaces the project's DRAFT theme
 * wholesale with the preset's theme object (still subject to the same
 * `validateTheme` schema check as any other draft write).
 */

export type PresetName = 'bonsai-default' | 'minimal' | 'dark';

export interface ThemePreset {
  name: PresetName;
  label: string;
  theme: Record<string, unknown>;
}

export const BUILT_IN_PRESETS: Record<PresetName, ThemePreset> = {
  'bonsai-default': {
    name: 'bonsai-default',
    label: 'Bonsai default',
    theme: {
      version: 1,
      colors: {
        primary: '#7C3AED',
        background: '#FFFFFF',
        text: '#0F172A',
        secondaryText: '#475569',
        border: '#E2E8F0',
        accent: '#7C3AED',
        userBubble: '#7C3AED',
        botBubble: '#F1F5F9',
      },
      gradient: { from: '#7C3AED', to: '#2563EB', centerColor: '#FFFFFF' },
      radius: 16,
      spacing: 8,
      shadow: 'medium',
      typography: {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 14,
        fontWeight: 400,
      },
      launcher: { iconMode: 'gradient', size: 60, corner: 'br' },
      openingAnimation: { type: 'slide', delayMs: 0 },
      welcome: {
        message: 'Hoi! Stel gerust je vraag.',
        suggestions: ['Wat zijn de openingstijden?', 'Ik wil iets retourneren'],
      },
    },
  },
  minimal: {
    name: 'minimal',
    label: 'Minimal',
    theme: {
      version: 1,
      colors: {
        primary: '#111827',
        background: '#FFFFFF',
        text: '#111827',
        secondaryText: '#6B7280',
        border: '#E5E7EB',
        accent: '#111827',
        userBubble: '#111827',
        botBubble: '#F3F4F6',
      },
      radius: 8,
      spacing: 6,
      shadow: 'small',
      typography: {
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        fontWeight: 400,
      },
      launcher: { iconMode: 'gradient', size: 56, corner: 'br' },
      openingAnimation: { type: 'fade', delayMs: 0 },
      welcome: {
        message: 'Hi, how can I help?',
        suggestions: [],
      },
    },
  },
  dark: {
    name: 'dark',
    label: 'Dark',
    theme: {
      version: 1,
      colors: {
        primary: '#8B5CF6',
        background: '#0F172A',
        text: '#F8FAFC',
        secondaryText: '#94A3B8',
        border: '#1E293B',
        accent: '#8B5CF6',
        userBubble: '#8B5CF6',
        botBubble: '#1E293B',
      },
      gradient: { from: '#4C1D95', to: '#1E3A8A', centerColor: '#0F172A' },
      radius: 16,
      spacing: 8,
      shadow: 'large',
      typography: {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 14,
        fontWeight: 400,
      },
      launcher: { iconMode: 'gradient', size: 60, corner: 'br' },
      openingAnimation: { type: 'bounce', delayMs: 0 },
      welcome: {
        message: 'Hey! Ask me anything.',
        suggestions: ['What are your hours?', 'I need help with an order'],
      },
    },
  },
};

export function listPresets(): Array<{
  name: PresetName;
  label: string;
  theme: Record<string, unknown>;
}> {
  return Object.values(BUILT_IN_PRESETS);
}

export function getPreset(name: string): ThemePreset | undefined {
  return (BUILT_IN_PRESETS as Record<string, ThemePreset | undefined>)[name];
}
