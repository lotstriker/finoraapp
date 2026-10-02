// ==========================================================================
// Finora — utils/theme.js
// A SINGLE theme selection stored as one attribute (data-theme) — Light,
// Dark, System, or one of 5 named creative themes. Because only one
// value can ever be set at a time, selecting any option is automatically
// mutually exclusive with every other; there's no way for two themes to
// be "on" at once (the old two-attribute theme+color-theme design could
// do that, which was the bug this replaces).
// ==========================================================================

const THEME_KEY = 'finora.theme';

/** Structural options — no visual identity of their own, just light/dark. */
export const STRUCTURAL_THEMES = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Named creative themes — each a complete, standalone palette. */
export const NAMED_THEMES = [
  { value: 'cyber-teal', label: 'Cyber Teal', swatch: '#00E599' },
  { value: 'neon-amber', label: 'Neon Amber', swatch: '#FF661A' },
  { value: 'midnight-gold', label: 'Midnight Gold', swatch: '#FCA311' },
  { value: 'deep-pine', label: 'Deep Pine', swatch: '#45D49E' },
  { value: 'ocean-twilight', label: 'Ocean Twilight', swatch: '#00D2FF' },
];

export const ALL_THEMES = [...STRUCTURAL_THEMES, ...NAMED_THEMES];

export function getTheme() {
  return localStorage.getItem(THEME_KEY) || 'system';
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function applyTheme(theme = getTheme()) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function initTheme() {
  applyTheme(getTheme());
}
