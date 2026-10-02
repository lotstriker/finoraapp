// ==========================================================================
// Finora — utils/icons.js
// Minimal line-icon set. "Do not use emoji as primary UI icons" (21).
// ==========================================================================

const s = (inner) => `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

export const icons = {
  dashboard: s('<path d="M3 10.5L10 4l7 6.5M5 9v7a1 1 0 001 1h3v-4h2v4h3a1 1 0 001-1V9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  accounts: s('<rect x="2.5" y="5" width="15" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 8.5h15" stroke="currentColor" stroke-width="1.6"/><path d="M5.5 12.5h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  income: s('<path d="M10 15V5M5.5 9.5L10 5l4.5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  expense: s('<path d="M10 5v10M5.5 10.5L10 15l4.5-4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  transfer: s('<path d="M3 7h11M14 7l-2.5-2.5M14 7l-2.5 2.5M17 13H6M6 13l2.5-2.5M6 13l2.5 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  people: s('<circle cx="7" cy="7" r="2.5" stroke="currentColor" stroke-width="1.6"/><circle cx="14" cy="8.5" r="2" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M12 12.5c2 0 3.5 1.3 3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  bidsave: s('<path d="M3 10.5l3-3 3 2 5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M11 4.5h3.5V8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><rect x="3" y="12" width="14" height="4" rx="1" stroke="currentColor" stroke-width="1.6"/>'),
  loans: s('<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 12.5l5-5M8 7.5h.01M12 12.5h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  savings: s('<path d="M4 11c0-3 2.5-5.5 6-5.5s6 2 6 4.7c0 1-.4 1.7-1 2.3v2.5a1 1 0 01-1 1h-1.5a1 1 0 01-1-1v-.5H8v.5a1 1 0 01-1 1H5.5a1 1 0 01-1-1V13" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="13.5" cy="9" r=".8" fill="currentColor"/>'),
  budgets: s('<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 10L10 4.2A5.8 5.8 0 0115.5 10z" fill="currentColor"/>'),
  scheduled: s('<rect x="3.5" y="4.5" width="13" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 8h13M7 3v3M13 3v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="12.5" r="1.2" fill="currentColor"/>'),
  billsplits: s('<circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.6"/><circle cx="13" cy="7" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M3 16c0-2.5 1.8-4 4-4s4 1.5 4 4M9 16c0-2.5 1.8-4 4-4s4 1.5 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  investments: s('<path d="M3.5 15.5L7.5 10l3 3 5.5-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M13 6h3v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'),
  recurring: s('<path d="M15.5 6.5A6 6 0 105.7 13.7M4.5 13.5A6 6 0 0114.3 6.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M15.5 3v3.5H12M4.5 17v-3.5H8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  reports: s('<path d="M4 16V9M10 16V4M16 16v-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M2.5 16.5h15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  search: s('<circle cx="8.5" cy="8.5" r="5" stroke="currentColor" stroke-width="1.6"/><path d="M15 15l-2.5-2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  settings: s('<circle cx="10" cy="10" r="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M10 3v2M10 15v2M17 10h-2M5 10H3M14.7 5.3l-1.4 1.4M6.7 13.3l-1.4 1.4M14.7 14.7l-1.4-1.4M6.7 6.7L5.3 5.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  chevron: s('<path d="M7.5 4.5l5 5.5-5 5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  plus: s('<path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
  sun: s('<circle cx="10" cy="10" r="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  moon: s('<path d="M16 11.3A6.3 6.3 0 018.7 4a6.3 6.3 0 106.7 8.5.4.4 0 01.6-.2z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'),
  monitor: s('<rect x="3" y="4" width="14" height="9.5" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M7.5 17h5M10 13.5V17" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  bank: s('<path d="M3 8l7-4 7 4M4 8.5h12M4.5 8.5V15M8 8.5V15M12 8.5V15M15.5 8.5V15M3 15.5h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  wallet: s('<rect x="2.5" y="5.5" width="15" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M12.5 10.5h3v2.5h-3a1.25 1.25 0 010-2.5z" stroke="currentColor" stroke-width="1.6"/>'),
  cash: s('<rect x="2.5" y="6" width="15" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10.25" r="2" stroke="currentColor" stroke-width="1.6"/>'),
  card: s('<rect x="2.5" y="5" width="15" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 8.5h15" stroke="currentColor" stroke-width="1.6"/>'),
  other: s('<circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M10 6.5v4l2.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  archive: s('<rect x="3" y="4.5" width="14" height="3" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 7.5V14a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5V7.5M8 10.5h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
  trash: s('<path d="M4 6h12M8 6V4.5a1 1 0 011-1h2a1 1 0 011 1V6M6 6l.7 9a1 1 0 001 .9h4.6a1 1 0 001-.9L14 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  history: s('<circle cx="10" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.6"/><path d="M10 7v3.5l2.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4.5L4 7.5H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  undo: s('<path d="M5 8H12.5A3.5 3.5 0 0116 11.5v0A3.5 3.5 0 0112.5 15H8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M7.5 5L4.5 8L7.5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  edit: s('<path d="M13.5 3.5l3 3L7 16H4v-3l9.5-9.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'),
};

export const accountTypeIcon = {
  bank: icons.bank,
  upi_wallet: icons.wallet,
  cash: icons.cash,
  credit_card: icons.card,
  other: icons.other,
};
