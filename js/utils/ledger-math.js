// ==========================================================================
// Finora — utils/ledger-math.js
// Reversal- and refund-aware totals. A reversal copies the ORIGINAL's
// `type` with the opposite direction, and a refund is type 'refund' with
// direction 'in'. Summing `t.amount` by type alone therefore ADDS them to
// expenses/income instead of cancelling them. Use these helpers anywhere a
// report, budget, dashboard card or insight totals income/expense.
// ==========================================================================

/** Signed contribution of a ledger row to EXPENSE totals (0 if not expense-related). */
export function signedExpense(t) {
  if (t.type !== 'expense' && t.type !== 'refund') return 0;
  return t.direction === 'out' ? t.amount : -t.amount;
}

/** Signed contribution of a ledger row to INCOME totals (0 if not income-related). */
export function signedIncome(t) {
  if (t.type !== 'income') return 0;
  return t.direction === 'in' ? t.amount : -t.amount;
}

/** True for rows that should appear in expense totals/breakdowns. */
export const isExpenseRelated = (t) => signedExpense(t) !== 0;
/** True for rows that should appear in income totals/breakdowns. */
export const isIncomeRelated = (t) => signedIncome(t) !== 0;

/**
 * Original (not reversed, not a reversal/refund) expenses — for "Top
 * Expenses" style lists where cancelled entries must not show up.
 */
export function liveExpenses(rows) {
  const reversed = new Set(rows.filter((t) => t.parentTransactionId).map((t) => t.parentTransactionId));
  return rows.filter((t) => t.type === 'expense' && t.direction === 'out' && !t.parentTransactionId && !reversed.has(t.id));
}
