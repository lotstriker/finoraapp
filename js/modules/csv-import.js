// ==========================================================================
// Finora — modules/csv-import.js
// Bulk CSV Import: bring in transactions from an existing spreadsheet.
// Expected columns (case-insensitive, order doesn't matter): Date, Type
// (income/expense), Amount, Category, Account, Description (optional).
// Every row is validated against existing accounts/categories BEFORE
// anything is imported — nothing gets created until the user confirms.
// ==========================================================================

import { getAccounts } from './accounts.js';
import { getCategories } from './categories.js';
import { createIncome } from './income.js';
import { createExpense } from './expenses.js';
import { getAll } from '../core/db.js';

/**
 * Parses CSV text into an array of row objects keyed by header name
 * (lowercased). Handles quoted fields — including commas and escaped
 * quotes ("") inside them — since real-world exports from Excel/Sheets
 * commonly quote fields that contain commas.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  // Normalize line endings so \r\n and \r don't create phantom blank rows.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (inQuotes) {
      if (char === '"') {
        if (normalized[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRow();
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmptyRows = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (nonEmptyRows.length === 0) return [];

  const headers = nonEmptyRows[0].map((h) => h.trim().toLowerCase());
  return nonEmptyRows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

/**
 * Parses the date formats real bank/Excel exports use. Returns a Date at LOCAL
 * noon (so no timezone can shift it to another day) or null.
 *   2026-10-05 · 2026/10/05 · 05/10/2026 · 05-10-2026 · 05.10.2026 · 5/10/26
 * Day-first (DD/MM/YYYY, the Indian convention) is assumed — unless the first
 * number is >12 (obviously a day) or the second is >12 (then it must be MM/DD).
 * Anything else (e.g. "5 Oct 2026", full ISO timestamps) falls back to Date().
 */
export function parseImportDate(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  const make = (y, m, d) => {
    const dt = new Date(y, m - 1, d, 12, 0, 0);
    // Reject impossible dates like 31/02 (JS would silently roll them to March).
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
  };

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(str);
  if (m) return make(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(str);
  if (m) {
    let a = Number(m[1]); let b = Number(m[2]); let y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
    // a/b = day/month by default; swap only when it can't be day-first.
    return b > 12 && a <= 12 ? make(y, a, b) : make(y, b, a);
  }

  const fallback = new Date(str);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

const dupKey = (accountId, type, amount, date, description) =>
  [accountId, type, Math.round(amount * 100), new Date(date).toLocaleDateString('en-CA'), (description || '').trim().toLowerCase()].join('|');

/**
 * Validates every parsed row against existing accounts/categories and
 * returns each with either a resolved, ready-to-import shape or a
 * human-readable error. Nothing is written to the database here.
 */
export async function validateImportRows(rows) {
  const [accounts, incomeCats, expenseCats, ledger] = await Promise.all([
    getAccounts(), getCategories('income'), getCategories('expense'), getAll('ledger'),
  ]);
  // Rows already in the books (same account/type/amount/day/description) are
  // flagged so importing the same statement twice doesn't double everything.
  const existing = new Set(
    ledger.filter((t) => (t.type === 'income' || t.type === 'expense') && !t.parentTransactionId)
      .map((t) => dupKey(t.accountId, t.type, t.amount, t.date, t.description))
  );
  const accountByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a]));
  const incomeCatByName = new Map(incomeCats.map((c) => [c.name.toLowerCase(), c]));
  const expenseCatByName = new Map(expenseCats.map((c) => [c.name.toLowerCase(), c]));

  return rows.map((row, index) => {
    const rowNum = index + 2; // +2: 1-indexed, plus the header row
    const typeRaw = (row.type || '').toLowerCase();
    const type = typeRaw.startsWith('in') ? 'income' : typeRaw.startsWith('ex') ? 'expense' : null;
    if (!type) return { rowNum, raw: row, error: `Type must be "income" or "expense" (got "${row.type || ''}")` };

    const amount = Number(String(row.amount || '').replace(/[₹$,]/g, ''));
    if (!(amount > 0)) return { rowNum, raw: row, error: `Invalid amount "${row.amount || ''}"` };

    const dateStr = row.date || '';
    const date = parseImportDate(dateStr);
    if (!date) return { rowNum, raw: row, error: `Invalid date "${dateStr}" (use DD/MM/YYYY or YYYY-MM-DD)` };

    const account = accountByName.get((row.account || '').toLowerCase());
    if (!account) return { rowNum, raw: row, error: `Account "${row.account || ''}" not found` };

    const catMap = type === 'income' ? incomeCatByName : expenseCatByName;
    const category = catMap.get((row.category || '').toLowerCase());
    if (!category) return { rowNum, raw: row, error: `Category "${row.category || ''}" not found for ${type}` };

    const description = row.description || '';
    return {
      rowNum,
      raw: row,
      valid: true,
      duplicate: existing.has(dupKey(account.id, type, amount, date, description)),
      type,
      amount,
      date: date.toISOString(),
      accountId: account.id,
      category: category.name,
      description,
    };
  });
}

/**
 * Imports only the rows marked `valid`, skipping possible duplicates unless
 * `includeDuplicates` is set. Returns how many succeeded/failed/skipped.
 */
export async function importValidRows(validatedRows, { includeDuplicates = false } = {}) {
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of validatedRows.filter((r) => r.valid)) {
    if (row.duplicate && !includeDuplicates) { skipped += 1; continue; }
    try {
      if (row.type === 'income') {
        await createIncome({ accountId: row.accountId, amount: row.amount, category: row.category, description: row.description, date: row.date });
      } else {
        await createExpense({ accountId: row.accountId, amount: row.amount, category: row.category, description: row.description, date: row.date });
      }
      imported += 1;
    } catch {
      failed += 1;
    }
  }
  return { imported, failed, skipped };
}
