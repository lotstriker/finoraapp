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
 * Simulates payoff of one loan given a fixed monthly payment (minimum +
 * any extra applied to it that month). Returns months-to-payoff and
 * total interest paid.
 */
function simulateSingleLoan(remainingPrincipal, monthlyRate, monthlyPayment) {
  let principal = remainingPrincipal;
  let months = 0;
  let totalInterest = 0;
  while (principal > 0.5 && months < 1200) { // 100-year safety cap
    const interest = roundMoney(principal * monthlyRate);
    let payment = monthlyPayment;
    if (payment - interest <= 0) break; // payment doesn't even cover interest — would never finish
    if (payment > principal + interest) payment = principal + interest;
    principal = roundMoney(principal - (payment - interest));
    totalInterest = roundMoney(totalInterest + interest);
    months += 1;
  }
  return { months, totalInterest };
}

/**
 * Simulates paying off ALL loans together, in priority order, applying
 * `extraMonthly` on top of everyone's minimum — but only to whichever
 * loan is highest-priority and still outstanding that month.
 */
function simulateAll(loanSnapshots, orderedIds, extraMonthly) {
  const state = loanSnapshots.map((l) => ({ ...l }));
  const byId = Object.fromEntries(state.map((l) => [l.id, l]));
  let month = 0;
  let totalInterest = 0;
  const payoffMonth = {};

  while (state.some((l) => l.remainingPrincipal > 0.5) && month < 1200) {
    month += 1;
    const priorityLoan = orderedIds.map((id) => byId[id]).find((l) => l && l.remainingPrincipal > 0.5);

    for (const loan of state) {
      if (loan.remainingPrincipal <= 0.5) continue;
      const interest = roundMoney(loan.remainingPrincipal * loan.monthlyRate);
      let payment = loan.minPayment + (loan.id === priorityLoan?.id ? extraMonthly : 0);
      if (payment > loan.remainingPrincipal + interest) payment = loan.remainingPrincipal + interest;
      loan.remainingPrincipal = roundMoney(loan.remainingPrincipal - (payment - interest));
      totalInterest = roundMoney(totalInterest + interest);
      if (loan.remainingPrincipal <= 0.5 && !payoffMonth[loan.id]) payoffMonth[loan.id] = month;
    }
  }

  return { totalMonths: month, totalInterest, payoffMonth };
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
    planMonths: withPlan.totalMonths,
    planInterest: withPlan.totalInterest,
    monthsSaved: Math.max(0, baselineMonths - withPlan.totalMonths),
    interestSaved: roundMoney(Math.max(0, baselineInterest - withPlan.totalInterest)),
  };
}
