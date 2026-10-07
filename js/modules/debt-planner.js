// ==========================================================================
// Finora — modules/debt-planner.js
// Debt Payoff Planner — a "what if" calculator, not a stored feature. It
// reads current loan balances/rates and simulates month-by-month payoff
// under Avalanche (highest interest first) or Snowball (smallest balance
// first) ordering, with an optional extra monthly payment applied to
// whichever loan is highest-priority. Nothing here writes anything.
// ==========================================================================

import { getLoans, getInstallments } from './loans.js';
import { roundMoney } from '../utils/currency.js';

/** Builds a simulation-ready snapshot of each active loan's current state. */
async function getLoanSnapshots() {
  const loans = await getLoans({ includeClosed: false });
  const snapshots = [];
  for (const loan of loans) {
    const installments = await getInstallments(loan.id);
    const pending = installments.filter((i) => i.status !== 'paid');
    if (pending.length === 0) continue;
    const remainingPrincipal = roundMoney(pending.reduce((s, i) => s + (i.principalComponent ?? i.amount), 0));
    const minPayment = pending[0].amount;
    snapshots.push({
      id: loan.id,
      name: loan.name,
      remainingPrincipal,
      monthlyRate: (loan.interestRate || 0) / 100 / 12,
      minPayment,
    });
  }
  return snapshots;
}

/**
 * Simulates payoff of one loan on its own at a fixed monthly payment.
 * `stuck` = the payment never covers the interest, so the loan would never
 * finish (the old code just returned 0 months, which looked like "paid off").
 */
function simulateSingleLoan(remainingPrincipal, monthlyRate, monthlyPayment) {
  let principal = remainingPrincipal;
  let months = 0;
  let totalInterest = 0;
  while (principal > 0.5 && months < 1200) { // 100-year safety cap
    const interest = roundMoney(principal * monthlyRate);
    let payment = monthlyPayment;
    if (payment - interest <= 0) return { months, totalInterest, stuck: true };
    if (payment > principal + interest) payment = principal + interest;
    principal = roundMoney(principal - (payment - interest));
    totalInterest = roundMoney(totalInterest + interest);
    months += 1;
  }
  return { months, totalInterest, stuck: principal > 0.5 };
}

/**
 * Simulates the REAL snowball/avalanche method:
 *   - Your total monthly budget = every loan's minimum payment + `extraMonthly`.
 *   - Each month every outstanding loan gets its minimum.
 *   - Everything left in the budget goes to the highest-priority loan.
 *   - When a loan is cleared, its freed-up minimum is NOT spent elsewhere — it
 *     "rolls" into the pool and attacks the next loan (that roll-over is the
 *     whole point of the method; the old version dropped it and understated savings).
 *   - If the priority loan is finished mid-month, the leftover cascades to the next.
 */
function simulateAll(loanSnapshots, orderedIds, extraMonthly) {
  const state = loanSnapshots.map((l) => ({ ...l }));
  const byId = Object.fromEntries(state.map((l) => [l.id, l]));
  const ordered = orderedIds.map((id) => byId[id]).filter(Boolean);
  const budget = roundMoney(state.reduce((sum, l) => sum + l.minPayment, 0) + (Number(extraMonthly) || 0));

  let month = 0;
  let totalInterest = 0;
  const payoffMonth = {};

  while (state.some((l) => l.remainingPrincipal > 0.5) && month < 1200) {
    month += 1;
    let pool = budget;

    // 1) interest accrues, then every outstanding loan gets its minimum
    for (const loan of state) {
      if (loan.remainingPrincipal <= 0.5) continue;
      const interest = roundMoney(loan.remainingPrincipal * loan.monthlyRate);
      totalInterest = roundMoney(totalInterest + interest);
      loan.owed = roundMoney(loan.remainingPrincipal + interest); // balance incl. this month's interest
      const minPaid = Math.min(loan.minPayment, loan.owed, pool);
      loan.owed = roundMoney(loan.owed - minPaid);
      pool = roundMoney(pool - minPaid);
    }

    // 2) whatever is left (extra + freed-up minimums) goes to the priority order
    for (const loan of ordered) {
      if (pool <= 0) break;
      if (loan.owed === undefined || loan.remainingPrincipal <= 0.5) continue;
      const extraPaid = Math.min(pool, loan.owed);
      loan.owed = roundMoney(loan.owed - extraPaid);
      pool = roundMoney(pool - extraPaid);
    }

    // 3) commit the month
    for (const loan of state) {
      if (loan.remainingPrincipal <= 0.5) continue;
      loan.remainingPrincipal = loan.owed;
      loan.owed = undefined;
      if (loan.remainingPrincipal <= 0.5 && !payoffMonth[loan.id]) payoffMonth[loan.id] = month;
    }
  }

  return { totalMonths: month, totalInterest, payoffMonth, completed: !state.some((l) => l.remainingPrincipal > 0.5) };
}

/**
 * @param {'avalanche'|'snowball'} strategy avalanche = highest interest rate first; snowball = smallest balance first
 * @param {number} extraMonthly extra amount available each month beyond everyone's minimum
 */
export async function getDebtPayoffPlan(strategy = 'avalanche', extraMonthly = 0) {
  const snapshots = await getLoanSnapshots();
  if (snapshots.length === 0) return null;

  const ordered = [...snapshots].sort((a, b) =>
    strategy === 'avalanche' ? b.monthlyRate - a.monthlyRate : a.remainingPrincipal - b.remainingPrincipal
  );
  const orderedIds = ordered.map((l) => l.id);

  // Baseline: minimum payments only, no extra, no strategic ordering needed
  const baselinePerLoan = snapshots.map((l) => ({ id: l.id, name: l.name, ...simulateSingleLoan(l.remainingPrincipal, l.monthlyRate, l.minPayment) }));
  const baselineStuck = baselinePerLoan.some((l) => l.stuck);
  const baselineMonths = Math.max(...baselinePerLoan.map((l) => l.months));
  const baselineInterest = roundMoney(baselinePerLoan.reduce((s, l) => s + l.totalInterest, 0));

  // With strategy + extra payment
  const withPlan = simulateAll(snapshots, orderedIds, extraMonthly);

  return {
    strategy,
    extraMonthly,
    order: ordered.map((l) => ({ id: l.id, name: l.name, remainingPrincipal: l.remainingPrincipal, interestRate: roundMoney(l.monthlyRate * 12 * 100), payoffMonth: withPlan.payoffMonth[l.id] || null })),
    baselineMonths,
    baselineInterest,
    baselineStuck,                     // true if some loan's minimum never covers its interest
    planCompletes: withPlan.completed,
    planMonths: withPlan.totalMonths,
    planInterest: withPlan.totalInterest,
    monthsSaved: Math.max(0, baselineMonths - withPlan.totalMonths),
    interestSaved: roundMoney(Math.max(0, baselineInterest - withPlan.totalInterest)),
  };
}
