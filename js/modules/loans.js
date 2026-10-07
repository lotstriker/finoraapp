// ==========================================================================
// Finora — modules/loans.js
// Simplification note: installments are flat EMI amounts (no
// principal/interest breakdown per installment) — disclosed in README.
//
// Second-opinion-review fixes applied here:
//   - Due-date generation uses addMonthsClamped (Jan-31 overflow bug).
//   - EMI formula result passes through roundMoney.
//   - reverseEmiPayment() properly resets the linked installment (and
//     reopens the loan if it had auto-closed) — generic ledger reversal
//     alone left the installment stuck showing "paid".
// ==========================================================================

import { withTransaction, reqToPromise, getAll, getById } from '../core/db.js';
import { createTransaction, reverseTransaction, ValidationError } from '../core/ledger.js';
import { newId } from '../core/ids.js';
import { addMonthsClamped } from '../utils/date.js';
import { roundMoney } from '../utils/currency.js';

/** Standard reducing-balance EMI formula. */
export function calculateEmi(principal, annualRatePercent, tenureMonths) {
  const r = annualRatePercent / 12 / 100;
  if (r === 0) return roundMoney(principal / tenureMonths);
  const factor = Math.pow(1 + r, tenureMonths);
  return roundMoney((principal * r * factor) / (factor - 1));
}

export async function getLoans({ includeClosed = true } = {}) {
  const all = await getAll('loans');
  const filtered = includeClosed ? all : all.filter((l) => l.status !== 'closed');
  return filtered.sort((a, b) => (a.status === b.status ? 0 : a.status === 'closed' ? 1 : -1));
}

export async function getLoanById(id) {
  return getById('loans', id);
}

export async function getInstallments(loanId) {
  return withTransaction(['loan_installments'], 'readonly', async (tx) => {
    const all = await reqToPromise(tx.objectStore('loan_installments').index('loanId').getAll(loanId));
    return all.sort((a, b) => a.installmentNumber - b.installmentNumber);
  });
}

export function loanProgress(installments) {
  const paid = installments.filter((i) => i.status === 'paid');
  const paidAmount = paid.reduce((s, i) => s + i.amount, 0);
  const totalAmount = installments.reduce((s, i) => s + i.amount, 0);
  // remainingAmount = everything still to PAY (future interest included).
  // remainingPrincipal = what you actually OWE today — the right number for net worth,
  // because interest that hasn't accrued yet is not a liability yet.
  const remainingPrincipal = roundMoney(
    installments.filter((i) => i.status !== 'paid').reduce((s, i) => s + (i.principalComponent ?? i.amount), 0)
  );
  return { paidCount: paid.length, totalCount: installments.length, paidAmount, totalAmount, remainingAmount: totalAmount - paidAmount, remainingPrincipal };
}

/**
 * @param {object} input
 * @param {string} input.name e.g. "Home Loan - HDFC"
 * @param {string} [input.lender]
 * @param {number} input.principal
 * @param {number} input.interestRate annual %, may be 0
 * @param {number} input.tenureMonths
 * @param {number} input.emiAmount
 * @param {string} input.startDate ISO date
 * @param {string} [input.disburseToAccountId] if the loan amount should be added to an account
 */
export async function createLoan(input) {
  if (!input.name?.trim()) throw new ValidationError('Loan name is required.');
  if (!(Number(input.principal) > 0)) throw new ValidationError('Principal must be greater than ₹0.');
  if (!(Number(input.tenureMonths) > 0)) throw new ValidationError('Tenure must be at least 1 month.');
  if (!(Number(input.emiAmount) > 0)) throw new ValidationError('EMI amount must be greater than ₹0.');

  const loan = {
    id: newId('loan'),
    name: input.name.trim(),
    lender: input.lender || '',
    principal: Number(input.principal),
    interestRate: Number(input.interestRate) || 0,
    tenureMonths: Number(input.tenureMonths),
    emiAmount: roundMoney(input.emiAmount),
    startDate: input.startDate || new Date().toISOString(),
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  const monthlyRate = loan.interestRate / 12 / 100;
  let remainingPrincipal = loan.principal;
  const installments = [];

  for (let i = 0; i < loan.tenureMonths; i++) {
    const isLast = i === loan.tenureMonths - 1;
    const interestComponent = roundMoney(remainingPrincipal * monthlyRate);
    let amount = loan.emiAmount;
    let principalComponent = roundMoney(amount - interestComponent);

    // Clear the exact remaining balance on the last scheduled month, or
    // earlier if the EMI is large enough to overshoot it sooner — this is
    // what fixes the "final EMI should be ₹7,400, not the full ₹10,000"
    // case, and avoids negative principal on an overshoot.
    if (isLast || principalComponent >= remainingPrincipal) {
      principalComponent = remainingPrincipal;
      amount = roundMoney(principalComponent + interestComponent);
    }

    remainingPrincipal = roundMoney(remainingPrincipal - principalComponent);

    installments.push({
      id: newId('inst'),
      loanId: loan.id,
      installmentNumber: i + 1,
      dueDate: addMonthsClamped(loan.startDate, i + 1).toISOString(),
      amount,
      interestComponent,
      principalComponent,
      status: 'pending',
      paidDate: null,
      paidTransactionId: null,
    });

    if (remainingPrincipal <= 0) break; // paid off early — fewer installments than tenureMonths
  }

  await withTransaction(['loans', 'loan_installments'], 'readwrite', (tx) => {
    tx.objectStore('loans').put(loan);
    const instStore = tx.objectStore('loan_installments');
    installments.forEach((i) => instStore.put(i));
  });

  if (input.disburseToAccountId) {
    await createTransaction({
      type: 'loan_disbursement',
      direction: 'in',
      accountId: input.disburseToAccountId,
      amount: loan.principal,
      module: 'loans',
      moduleRef: loan.id,
      description: `${loan.name} — disbursement`,
      date: loan.startDate,
    });
  }

  return loan;
}

/**
 * Pays the next pending installment (or a specified one). Posts the ledger
 * entry and marks the installment paid atomically — and auto-closes the
 * loan when every installment is paid.
 */
export async function payInstallment(loanId, installmentId, { accountId, date } = {}) {
  const installment = await getById('loan_installments', installmentId);
  if (!installment) throw new ValidationError('Installment not found.');
  if (installment.status === 'paid') throw new ValidationError('This installment is already paid.');

  const loan = await getById('loans', loanId);
  if (!loan) throw new ValidationError('Loan not found.');

  return createTransaction({
    type: 'loan_emi',
    direction: 'out',
    accountId,
    amount: installment.amount,
    module: 'loans',
    moduleRef: loanId,
    description: `EMI #${installment.installmentNumber} — ${loan.name}`,
    date,
  }, {
    extraStores: ['loan_installments', 'loans'],
    sideEffect: async (tx, record) => {
      const instStore = tx.objectStore('loan_installments');
      const inst = await reqToPromise(instStore.get(installmentId));
      // Re-checked inside the atomic transaction: the check above ran outside
      // it, so two quick clicks could both pass it.
      if (!inst || inst.status === 'paid') throw new ValidationError('This installment is already paid.');
      inst.status = 'paid';
      inst.paidDate = record.date;
      inst.paidTransactionId = record.id;
      instStore.put(inst);

      const allForLoan = await reqToPromise(instStore.index('loanId').getAll(loanId));
      const allPaid = allForLoan.every((i) => (i.id === installmentId ? true : i.status === 'paid'));
      if (allPaid) {
        const loansStore = tx.objectStore('loans');
        const loanRecord = await reqToPromise(loansStore.get(loanId));
        loanRecord.status = 'closed';
        loansStore.put(loanRecord);
      }
    },
  });
}

/**
 * Reverses a paid EMI: reverses the ledger effect AND resets the linked
 * installment back to pending (reopening the loan if it had auto-closed).
 */
export async function reverseEmiPayment(transactionId, reason = '') {
  const original = await getById('ledger', transactionId);
  if (!original) throw new ValidationError('Transaction not found.');
  if (original.type !== 'loan_emi') throw new ValidationError('This is not an EMI payment.');

  const loanId = original.moduleRef;
  const installments = await getInstallments(loanId);
  const installment = installments.find((i) => i.paidTransactionId === transactionId);
  if (!installment) throw new ValidationError('Could not find the linked installment.');

  await reverseTransaction(transactionId, reason, {
    extraStores: ['loan_installments', 'loans'],
    sideEffect: async (tx) => {
      const instStore = tx.objectStore('loan_installments');
      const inst = await reqToPromise(instStore.get(installment.id));
      inst.status = 'pending';
      inst.paidDate = null;
      inst.paidTransactionId = null;
      instStore.put(inst);

      const loansStore = tx.objectStore('loans');
      const loan = await reqToPromise(loansStore.get(loanId));
      if (loan.status === 'closed') {
        loan.status = 'active';
        loansStore.put(loan);
      }
    },
  });
}

/** Manually marks a loan closed (e.g. foreclosed outside the app). */
export async function closeLoan(id) {
  return withTransaction(['loans'], 'readwrite', async (tx) => {
    const store = tx.objectStore('loans');
    const loan = await reqToPromise(store.get(id));
    if (!loan) throw new ValidationError('Loan not found.');
    loan.status = 'closed';
    store.put(loan);
    return loan;
  });
}
