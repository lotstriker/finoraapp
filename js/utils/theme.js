// ==========================================================================
// Finora — utils/theme.js
// Two independent preferences, both allowed in localStorage (small UI
// preferences only — see 02 - Technology & Architecture):
//   1. Structural theme: 'light' | 'dark' | 'system'
//   2. Color theme: which accent-color palette to use (works with any of
//      the three structural themes above).
// ==========================================================================

const THEME_KEY = 'finora.theme';
const COLOR_THEME_KEY = 'finora.colorTheme';

export const COLOR_THEMES = [
  { value: 'indigo', label: 'Indigo', swatch: '#4A47E0' },
  { value: 'emerald', label: 'Emerald', swatch: '#0F9D6B' },
  { value: 'rose', label: 'Rose', swatch: '#D6336C' },
  { value: 'amber', label: 'Amber', swatch: '#B45309' },
  { value: 'ocean', label: 'Ocean', swatch: '#0369A1' },
  { value: 'graphite', label: 'Graphite', swatch: '#3F3F46' },
];

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

export function getColorTheme() {
  return localStorage.getItem(COLOR_THEME_KEY) || 'indigo';
}

export function setColorTheme(colorTheme) {
  localStorage.setItem(COLOR_THEME_KEY, colorTheme);
  applyColorTheme(colorTheme);
}

export function applyColorTheme(colorTheme = getColorTheme()) {
  document.documentElement.setAttribute('data-color-theme', colorTheme);
}

export function initTheme() {
  applyTheme(getTheme());
  applyColorTheme(getColorTheme());
}
