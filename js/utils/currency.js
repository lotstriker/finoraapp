// ==========================================================================
// Finora — utils/currency.js
// Currency preference persists like theme (small UI preference —
// localStorage, cached synchronously so formatCurrency() can stay a plain
// sync function everywhere it's already called). Display formatting only —
// no conversion/exchange rates.
// ==========================================================================

const CURRENCY_KEY = 'finora.currency';

export const CURRENCIES = [
  { code: 'INR', label: 'Indian Rupee', symbol: '₹', locale: 'en-IN' },
  { code: 'USD', label: 'US Dollar', symbol: '$', locale: 'en-US' },
  { code: 'EUR', label: 'Euro', symbol: '€', locale: 'en-IE' },
  { code: 'GBP', label: 'British Pound', symbol: '£', locale: 'en-GB' },
];

function buildFormatter(code) {
  const meta = CURRENCIES.find((c) => c.code === code) || CURRENCIES[0];
  return new Intl.NumberFormat(meta.locale, {
    style: 'currency',
    currency: meta.code,
    maximumFractionDigits: 0,
  });
}

export function getCurrencyPreference() {
  return localStorage.getItem(CURRENCY_KEY) || 'INR';
}

let cachedFormatter = buildFormatter(getCurrencyPreference());

export function setCurrencyPreference(code) {
  localStorage.setItem(CURRENCY_KEY, code);
  cachedFormatter = buildFormatter(code);
}

/** Call once at app boot, mirroring initTheme(). */
export function initCurrency() {
  cachedFormatter = buildFormatter(getCurrencyPreference());
}

/** Rounds to 2 decimal places, correcting for JS floating-point drift
 * (e.g. from repeated division in EMI/Bid & Save calculations). Every
 * money value that comes out of a calculation should pass through this
 * before being stored or displayed. */
export function roundMoney(amount) {
  return Math.round((Number(amount) + Number.EPSILON) * 100) / 100;
}

/** e.g. ₹12,34,500 (Indian grouping) or $1,234,500, depending on preference. */
export function formatCurrency(amount) {
  const n = Number(amount) || 0;
  return cachedFormatter.format(n);
}

/** Formats with an explicit +/- sign, for account-history rows. */
export function formatSignedCurrency(amount, direction) {
  const formatted = formatCurrency(Math.abs(amount));
  if (direction === 'in') return `+${formatted}`;
  if (direction === 'out') return `-${formatted}`;
  return formatted;
}
