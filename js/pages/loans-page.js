// ==========================================================================
// Finora — pages/loans-page.js
// ==========================================================================

import {
  getLoans, getLoanById, getInstallments, loanProgress,
  createLoan, payInstallment, closeLoan, calculateEmi, reverseEmiPayment,
} from '../modules/loans.js';
import { getAccounts } from '../modules/accounts.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;

export async function renderLoansPage(root, params) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Loans &amp; EMI</h1>
        <button class="btn btn-primary" id="btn-add-loan">${icons.plus} Add Loan</button>
      </div>
      <div class="list" id="loans-list"></div>
    </div>
  `;
  qs('#btn-add-loan', root).addEventListener('click', openCreateLoanModal);
  await refresh();

  const openId = params?.get?.('open');
  if (openId) openLoanDetail(openId);
}

async function refresh() {
  const loans = await getLoans();
  const listEl = qs('#loans-list', container);

  if (loans.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No loans yet</h3>
        <p>Track a home, car, or personal loan and its EMI schedule.</p>
        <button class="btn btn-primary" id="btn-add-loan-empty">${icons.plus} Add Loan</button>
      </div>`;
    qs('#btn-add-loan-empty', listEl).addEventListener('click', openCreateLoanModal);
    return;
  }

  const rows = await Promise.all(loans.map(async (loan) => {
    const installments = await getInstallments(loan.id);
    const progress = loanProgress(installments);
    return `
      <div class="list-row is-clickable" data-id="${loan.id}">
        <div class="row-icon">${icons.loans}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(loan.name)} ${loan.status === 'closed' ? '<span class="badge badge-success">Closed</span>' : ''}</div>
          <div class="row-sub">${escapeHtml(loan.lender || '')} · ${progress.paidCount}/${progress.totalCount} EMIs paid</div>
        </div>
        <span class="amount num amount--out">${formatCurrency(progress.remainingAmount)}</span>
      </div>
    `;
  }));

  listEl.innerHTML = rows.join('');
  listEl.querySelectorAll('.list-row').forEach((row) => {
    bindRowActivation(row, () => openLoanDetail(row.dataset.id));
  });
}

function openCreateLoanModal() {
  openModal({
    title: 'Add Loan',
    bodyHtml: `
      <form id="form-loan">
        <div class="field">
          <label for="ln-name">Loan name</label>
          <input class="input" id="ln-name" type="text" placeholder="e.g. Home Loan - HDFC" required />
        </div>
        <div class="field">
          <label for="ln-lender">Lender (optional)</label>
          <input class="input" id="ln-lender" type="text" placeholder="e.g. HDFC Bank" />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="ln-principal">Principal</label>
            <input class="input" id="ln-principal" type="number" min="1" step="0.01" required />
          </div>
          <div class="field">
            <label for="ln-rate">Interest rate (% p.a.)</label>
            <input class="input" id="ln-rate" type="number" min="0" step="0.01" value="0" />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="ln-tenure">Tenure (months)</label>
            <input class="input" id="ln-tenure" type="number" min="1" step="1" required />
          </div>
          <div class="field">
            <label for="ln-emi">EMI amount</label>
            <input class="input" id="ln-emi" type="number" min="1" step="0.01" required />
          </div>
        </div>
        <span class="field-hint" id="ln-emi-hint"></span>
        <div class="field" style="margin-top: var(--sp-3);">
          <label for="ln-start">Start date</label>
          <input class="input" id="ln-start" type="date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <div class="field" id="ln-disburse-field">
          <label for="ln-disburse">Add principal to an account? (optional)</label>
          <select class="select" id="ln-disburse"><option value="">Don't add to any account</option></select>
        </div>
      </form>
    `,
    onMount: async (root) => {
      const accounts = await getAccounts();
      const sel = qs('#ln-disburse', root);
      accounts.forEach((a) => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        sel.appendChild(opt);
      });

      const recalc = () => {
        const principal = Number(qs('#ln-principal', root).value);
        const rate = Number(qs('#ln-rate', root).value);
        const tenure = Number(qs('#ln-tenure', root).value);
        if (principal > 0 && tenure > 0) {
          const suggested = calculateEmi(principal, rate, tenure);
          qs('#ln-emi-hint', root).textContent = `Suggested EMI: ${formatCurrency(suggested)}`;
          if (!qs('#ln-emi', root).dataset.touched) {
            qs('#ln-emi', root).value = suggested.toFixed(2);
          }
        }
      };
      ['ln-principal', 'ln-rate', 'ln-tenure'].forEach((id) => qs(`#${id}`, root).addEventListener('input', recalc));
      qs('#ln-emi', root).addEventListener('input', (e) => { e.target.dataset.touched = 'true'; });
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Loan',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#ln-name', root).value;
          const lender = qs('#ln-lender', root).value;
          const principal = qs('#ln-principal', root).value;
          const interestRate = qs('#ln-rate', root).value;
          const tenureMonths = qs('#ln-tenure', root).value;
          const emiAmount = qs('#ln-emi', root).value;
          const startDateVal = qs('#ln-start', root).value;
          const startDate = startDateVal ? new Date(startDateVal).toISOString() : undefined;
          const disburseToAccountId = qs('#ln-disburse', root).value || undefined;

          try {
            await createLoan({ name, lender, principal, interestRate, tenureMonths, emiAmount, startDate, disburseToAccountId });
            close();
            toast.success('Loan added.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong adding the loan.');
          }
        },
      },
    ],
  });
}

async function openLoanDetail(id) {
  const loan = await getLoanById(id);
  if (!loan) return;
  const installments = await getInstallments(id);
  const progress = loanProgress(installments);
  const nextPending = installments.find((i) => i.status !== 'paid');

  const scheduleHtml = installments.slice(0, 12).map((i) => `
    <div class="list-row ${i.status === 'paid' ? 'is-clickable' : ''}" ${i.status === 'paid' ? `data-inst="${i.id}"` : ''}>
      <div class="row-main">
        <div class="row-title">EMI #${i.installmentNumber}${i.installmentNumber === installments.length ? ' <span class="badge badge-neutral">Final</span>' : ''}</div>
        <div class="row-sub">Due ${formatDate(i.dueDate)}${i.paidDate ? ` · Paid ${formatDate(i.paidDate)}` : ''}${i.interestComponent != null ? ` · Interest ${formatCurrency(i.interestComponent)} + Principal ${formatCurrency(i.principalComponent)}` : ''}</div>
      </div>
      <div class="row-trail">
        ${i.status === 'paid' ? '<span class="badge badge-success">Paid</span>' : '<span class="badge badge-neutral">Pending</span>'}
        <span class="amount num">${formatCurrency(i.amount)}</span>
      </div>
    </div>
  `).join('');

  openModal({
    title: loan.name,
    size: 'lg',
    bodyHtml: `
      <p class="text-sm text-muted" style="margin-bottom: var(--sp-4);">${escapeHtml(loan.lender || '')} · ${loan.interestRate}% p.a. · ${loan.status === 'closed' ? 'Closed' : 'Active'}</p>
      <div style="margin-bottom: var(--sp-4);">
        <span class="stat-label">Remaining</span><br/>
        <span class="amount amount--lg num amount--out">${formatCurrency(progress.remainingAmount)}</span>
      </div>
      <div class="summary-list">
        <div class="summary-row"><span class="summary-label">Progress</span><span class="summary-value num">${progress.paidCount}/${progress.totalCount} installments</span></div>
      </div>
      <div class="list">${scheduleHtml}</div>
      ${installments.length > 12 ? `<p class="text-xs text-faint" style="margin-top:var(--sp-2);">Showing first 12 of ${installments.length} installments.</p>` : ''}
    `,
    actions: [
      ...(loan.status !== 'closed' ? [
        { label: 'Close Loan', variant: 'btn-secondary', onClick: async (close) => {
            const ok = await confirmDialog({ title: 'Close loan', message: 'Mark this loan as closed (e.g. foreclosed outside the app)?' });
            if (ok) { await closeLoan(id); close(); toast.success('Loan closed.'); refresh(); }
          } },
        { label: nextPending ? `Pay EMI #${nextPending.installmentNumber}` : 'Pay', variant: 'btn-primary', onClick: (close) => { close(); if (nextPending) openPayModal(loan, nextPending); } },
      ] : []),
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
    onMount: (root) => {
      root.querySelectorAll('[data-inst]').forEach((row) => {
        bindRowActivation(row, async () => {
          const inst = installments.find((i) => i.id === row.dataset.inst);
          const ok = await confirmDialog({
            title: `Reverse EMI #${inst.installmentNumber}`, danger: true, confirmLabel: 'Reverse',
            message: 'This undoes the payment and marks the installment pending again.',
          });
          if (ok) {
            try {
              await reverseEmiPayment(inst.paidTransactionId);
              toast.success('EMI payment reversed.');
              refresh();
            } catch (err) {
              toast.error(err instanceof ValidationError ? err.message : 'Could not reverse this EMI.');
            }
          }
        });
      });
    },
  });
}

async function openPayModal(loan, installment) {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    toast.warning('Add an account first.');
    return;
  }
  const options = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');

  openModal({
    title: `Pay EMI #${installment.installmentNumber}`,
    bodyHtml: `
      <p class="text-sm" style="margin-bottom: var(--sp-3);">Amount: <strong>${formatCurrency(installment.amount)}</strong></p>
      <div class="field">
        <label for="pay-account">Pay from</label>
        <select class="select" id="pay-account">${options}</select>
      </div>
      <div class="field">
        <label for="pay-date">Payment date</label>
        <input class="input" id="pay-date" type="date" value="${new Date().toISOString().slice(0, 10)}" />
      </div>
    `,
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Pay EMI',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const accountId = qs('#pay-account', root).value;
          const dateVal = qs('#pay-date', root).value;
          const date = dateVal ? new Date(dateVal).toISOString() : undefined;
          try {
            await payInstallment(loan.id, installment.id, { accountId, date });
            close();
            toast.success('EMI paid.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong paying the EMI.');
          }
        },
      },
    ],
  });
}
