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
 * Validates every parsed row against existing accounts/categories and
 * returns each with either a resolved, ready-to-import shape or a
 * human-readable error. Nothing is written to the database here.
 */
export async function validateImportRows(rows) {
  const [accounts, incomeCats, expenseCats] = await Promise.all([
    getAccounts(), getCategories('income'), getCategories('expense'),
  ]);
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
    const date = new Date(dateStr);
    if (!dateStr || isNaN(date.getTime())) return { rowNum, raw: row, error: `Invalid date "${dateStr}"` };

    const account = accountByName.get((row.account || '').toLowerCase());
    if (!account) return { rowNum, raw: row, error: `Account "${row.account || ''}" not found` };

    const catMap = type === 'income' ? incomeCatByName : expenseCatByName;
    const category = catMap.get((row.category || '').toLowerCase());
    if (!category) return { rowNum, raw: row, error: `Category "${row.category || ''}" not found for ${type}` };

    return {
      rowNum,
      raw: row,
      valid: true,
      type,
      amount,
      date: date.toISOString(),
      accountId: account.id,
      category: category.name,
      description: row.description || '',
    };
  });
}

/** Imports only the rows already marked `valid` by validateImportRows. Returns how many succeeded/failed. */
export async function importValidRows(validatedRows) {
  let imported = 0;
  let failed = 0;
  for (const row of validatedRows.filter((r) => r.valid)) {
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
  return { imported, failed };
}
