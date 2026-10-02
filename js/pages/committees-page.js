// ==========================================================================
// Finora — pages/committees-page.js
// Second-opinion-review fixes: summary cards at the top of the list,
// "profit" language instead of ambiguous "saved", wide (lg) detail modal,
// richer per-cycle history, and a Reverse action on recorded cycles.
// ==========================================================================

import {
  getCommittees, getCommitteeById, getCycles, committeeProgress,
  createCommittee, recordCycle, reverseCycle, getMemberships,
} from '../modules/committees.js';
import { getAccounts } from '../modules/accounts.js';
import { ValidationError } from '../core/ledger.js';
import { formatCurrency, roundMoney } from '../utils/currency.js';
import { formatDate, escapeHtml, qs, bindRowActivation, renderPagination as renderPaginationUI } from '../utils/dom.js';
import { icons } from '../utils/icons.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { toast } from '../core/toast.js';

let container = null;

export async function renderCommitteesPage(root, params) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h1>Bid &amp; Save</h1>
        <button class="btn btn-primary" id="btn-add-committee">${icons.plus} Add Committee</button>
      </div>
      <div class="grid grid-cards mb-5" id="committees-summary"></div>
      <div class="list" id="committees-list"></div>
    </div>
  `;
  qs('#btn-add-committee', root).addEventListener('click', openCreateModal);
  await refresh();

  const openId = params?.get?.('open');
  if (openId) openDetail(openId);
}

async function refresh() {
  const committees = await getCommittees();
  const listEl = qs('#committees-list', container);
  const summaryEl = qs('#committees-summary', container);

  if (committees.length === 0) {
    summaryEl.innerHTML = '';
    listEl.innerHTML = `
      <div class="empty-state">
        <h3>No committees yet</h3>
        <p>Add a committee/chit fund to track your bids and profit.</p>
        <button class="btn btn-primary" id="btn-add-committee-empty">${icons.plus} Add Committee</button>
      </div>`;
    qs('#btn-add-committee-empty', listEl).addEventListener('click', openCreateModal);
    return;
  }

  const active = committees.filter((c) => c.status === 'active');
  let currentContribution = 0;
  let netProfit = 0;
  const progressByCommittee = {};
  const now = new Date();

  for (const c of committees) {
    const cycles = await getCycles(c.id);
    const progress = committeeProgress(cycles);
    progressByCommittee[c.id] = progress;
    netProfit += progress.totalSaving;
    if (c.status === 'active') {
      const currentMonthCycle = cycles.find((cy) => {
        const m = new Date(cy.month);
        return m.getMonth() === now.getMonth() && m.getFullYear() === now.getFullYear();
      });
      if (currentMonthCycle) {
        currentContribution += currentMonthCycle.status === 'recorded'
          ? currentMonthCycle.totalPayable
          : c.baseContribution * c.userMemberships;
      }
    }
  }

  summaryEl.innerHTML = `
    <div class="card stat-card">
      <span class="stat-label">Active Committees</span>
      <span class="amount amount--lg num">${active.length}</span>
    </div>
    <div class="card stat-card">
      <span class="stat-label">Current Contribution</span>
      <span class="amount amount--lg num">${formatCurrency(currentContribution)}</span>
      <span class="text-xs text-faint">This cycle, across active committees</span>
    </div>
    <div class="card stat-card">
      <span class="stat-label">Net Profit</span>
      <span class="amount amount--lg num amount--in">${formatCurrency(netProfit)}</span>
      <span class="text-xs text-faint">All recorded cycles, all time</span>
    </div>
  `;

  listEl.innerHTML = committees.map((c) => {
    const progress = progressByCommittee[c.id];
    return `
      <div class="list-row is-clickable" data-id="${c.id}">
        <div class="row-icon">${icons.bidsave}</div>
        <div class="row-main">
          <div class="row-title">${escapeHtml(c.name)} ${c.status === 'completed' ? '<span class="badge badge-success">Completed</span>' : ''}</div>
          <div class="row-sub">${c.userMemberships} membership${c.userMemberships > 1 ? 's' : ''} · ${progress.recordedCount}/${progress.totalCycles} cycles</div>
        </div>
        <span class="amount num amount--in">${formatCurrency(progress.totalSaving)} profit</span>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.list-row').forEach((row) => bindRowActivation(row, () => openDetail(row.dataset.id)));
}

function openCreateModal() {
  openModal({
    title: 'Add Committee',
    bodyHtml: `
      <form id="form-committee">
        <div class="field">
          <label for="cm-name">Committee name</label>
          <input class="input" id="cm-name" type="text" placeholder="e.g. Office Committee 2026" required />
        </div>
        <div class="field-row">
          <div class="field">
            <label for="cm-total">Total amount</label>
            <input class="input" id="cm-total" type="number" min="1" step="0.01" required />
          </div>
          <div class="field">
            <label for="cm-members">Number of members</label>
            <input class="input" id="cm-members" type="number" min="1" step="1" required />
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="cm-mine">Your memberships</label>
            <input class="input" id="cm-mine" type="number" min="1" step="1" value="1" />
          </div>
          <div class="field">
            <label for="cm-start">Start date</label>
            <input class="input" id="cm-start" type="date" value="${new Date().toISOString().slice(0, 10)}" />
          </div>
        </div>
        <span class="field-hint" id="cm-base-hint"></span>
      </form>
    `,
    onMount: (root) => {
      const recalc = () => {
        const total = Number(qs('#cm-total', root).value);
        const members = Number(qs('#cm-members', root).value);
        const mine = Number(qs('#cm-mine', root).value) || 1;
        if (total > 0 && members > 0) {
          const base = total / members;
          qs('#cm-base-hint', root).textContent = `Base contribution: ${formatCurrency(base)}/membership · Your total: ${formatCurrency(base * mine)} · Duration: ${members} cycles`;
        }
      };
      ['cm-total', 'cm-members', 'cm-mine'].forEach((id) => qs(`#${id}`, root).addEventListener('input', recalc));
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Add Committee',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const name = qs('#cm-name', root).value;
          const totalAmount = qs('#cm-total', root).value;
          const numberOfMembers = qs('#cm-members', root).value;
          const userMemberships = qs('#cm-mine', root).value;
          const startDateVal = qs('#cm-start', root).value;
          const startDate = startDateVal ? new Date(startDateVal).toISOString() : undefined;
          try {
            await createCommittee({ name, totalAmount, numberOfMembers, userMemberships, startDate });
            close();
            toast.success('Committee added.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong.');
          }
        },
      },
    ],
  });
}

async function openDetail(id) {
  const committee = await getCommitteeById(id);
  if (!committee) return;
  const cycles = await getCycles(id);
  const progress = committeeProgress(cycles);
  const nextPending = cycles.find((c) => c.status !== 'recorded');
  const CYCLE_PAGE_SIZE = 10;
  let cyclePage = 1;

  function cycleRow(c) {
    if (c.status !== 'recorded') {
      return `
        <div class="list-row">
          <div class="row-main">
            <div class="row-title">Cycle #${c.cycleNo} · ${formatDate(c.month)}</div>
            <div class="row-sub">Not recorded yet</div>
          </div>
        </div>`;
    }
    return `
      <div class="list-row is-clickable" data-cycle="${c.id}">
        <div class="row-main">
          <div class="row-title">Cycle #${c.cycleNo} · ${formatDate(c.month)} ${c.userWon ? '<span class="badge badge-success">You won</span>' : ''}</div>
          <div class="row-sub">
            Bid ${formatCurrency(c.winningBid)} · Profit/membership ${formatCurrency(c.discountPerMembership)} · Your profit ${formatCurrency(c.userSaving)}
            ${c.winnerName ? ` · Winner: ${escapeHtml(c.winnerName)}` : ''}
            ${c.userWon ? ` · Payout ${formatCurrency(c.payout)}` : ''}
          </div>
        </div>
        <span class="amount num">${formatCurrency(c.totalPayable)}</span>
      </div>`;
  }

  function renderHistoryPage(root) {
    const totalPages = Math.max(1, Math.ceil(cycles.length / CYCLE_PAGE_SIZE));
    cyclePage = Math.min(cyclePage, totalPages);
    const pageItems = cycles.slice((cyclePage - 1) * CYCLE_PAGE_SIZE, cyclePage * CYCLE_PAGE_SIZE);

    qs('#cmt-history-list', root).innerHTML = pageItems.map(cycleRow).join('');
    qs('#cmt-history-list', root).querySelectorAll('[data-cycle]').forEach((row) => {
      bindRowActivation(row, () => {
        const cycle = cycles.find((c) => c.id === row.dataset.cycle);
        openCycleReverseConfirm(committee, cycle);
      });
    });

    const pagEl = qs('#cmt-history-pagination', root);
    renderPaginationUI(pagEl, cyclePage, totalPages, (newPage) => { cyclePage = newPage; renderHistoryPage(root); });
  }

  openModal({
    title: committee.name,
    size: 'lg',
    bodyHtml: `
      <p class="text-sm text-muted mb-4">
        ${committee.userMemberships} membership${committee.userMemberships > 1 ? 's' : ''} of ${committee.numberOfMembers} · Base ${formatCurrency(committee.baseContribution * committee.userMemberships)}/cycle
        ${committee.endDate ? ` · ${formatDate(committee.startDate)} → ${formatDate(committee.endDate)}` : ''}
      </p>
      <div class="grid grid-cards mb-4">
        <div class="card stat-card">
          <span class="stat-label">Net Profit</span>
          <span class="amount amount--lg num amount--in">${formatCurrency(progress.totalSaving)}</span>
        </div>
        <div class="card stat-card">
          <span class="stat-label">Total Paid</span>
          <span class="amount amount--lg num">${formatCurrency(progress.totalPaid)}</span>
        </div>
        ${progress.totalReceived > 0 ? `
        <div class="card stat-card">
          <span class="stat-label">Total Received</span>
          <span class="amount amount--lg num amount--in">${formatCurrency(progress.totalReceived)}</span>
        </div>` : ''}
        <div class="card stat-card">
          <span class="stat-label">Progress</span>
          <span class="amount amount--lg num">${progress.recordedCount}/${progress.totalCycles}</span>
        </div>
      </div>
      <h3 style="font-size: var(--fs-sm); font-weight: 650; margin-bottom: var(--sp-2);">Cycle History</h3>
      <div class="list" id="cmt-history-list"></div>
      <div id="cmt-history-pagination" style="display:flex; justify-content:center; gap: var(--sp-2); margin-top: var(--sp-3);"></div>
    `,
    actions: [
      ...(nextPending ? [{ label: `Record Cycle #${nextPending.cycleNo}`, variant: 'btn-primary', onClick: (close) => { close(); openRecordCycleModal(committee, nextPending); } }] : []),
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
    onMount: (root) => {
      renderHistoryPage(root);
    },
  });
}

function openCycleReverseConfirm(committee, cycle) {
  openModal({
    title: `Cycle #${cycle.cycleNo}`,
    bodyHtml: `
      <p class="text-sm">Bid ${formatCurrency(cycle.winningBid)} · Your profit ${formatCurrency(cycle.userSaving)} · Contribution ${formatCurrency(cycle.totalPayable)}${cycle.userWon ? ` · Payout ${formatCurrency(cycle.payout)}` : ''}</p>
    `,
    actions: [
      { label: 'Reverse This Cycle', variant: 'btn-danger', onClick: async (close) => {
          close();
          const ok = await confirmDialog({
            title: 'Reverse cycle', danger: true, confirmLabel: 'Reverse',
            message: 'This undoes the contribution (and payout, if any) and resets the cycle so it can be re-recorded.',
          });
          if (ok) {
            try {
              await reverseCycle(cycle.id);
              toast.success('Cycle reversed.');
              refresh();
            } catch (err) {
              toast.error(err instanceof ValidationError ? err.message : 'Could not reverse this cycle.');
            }
          }
        } },
      { label: 'Close', variant: 'btn-ghost', onClick: (close) => close() },
    ],
  });
}

async function openRecordCycleModal(committee, cycle) {
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    toast.warning('Add an account first.');
    return;
  }
  const accountOptions = accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  const memberships = committee.userMemberships > 1 ? await getMemberships(committee.id) : [];

  openModal({
    title: `Record Cycle #${cycle.cycleNo}`,
    bodyHtml: `
      <div class="field">
        <label style="display:flex; align-items:center; gap: var(--sp-2); font-weight:500;">
          <input type="checkbox" id="rc-skip" /> Skip this cycle (no bid)
        </label>
      </div>
      <div id="rc-bid-fields">
        <div class="field">
          <label for="rc-bid">Winning bid</label>
          <input class="input" id="rc-bid" type="number" min="0" step="0.01" value="0" />
        </div>
        <div class="field">
          <label style="display:flex; align-items:center; gap: var(--sp-2); font-weight:500;">
            <input type="checkbox" id="rc-won" /> Did I win this cycle?
          </label>
        </div>
        <div class="field">
          <label for="rc-winner">Winner name (optional)</label>
          <input class="input" id="rc-winner" type="text" placeholder="e.g. Suresh" />
        </div>
      </div>
      <span class="field-hint" id="rc-calc-hint"></span>
      <div class="field mt-3">
        <label for="rc-pay-account">Pay contribution from</label>
        <select class="select" id="rc-pay-account">${accountOptions}</select>
      </div>
      <div class="field hidden" id="rc-payout-field">
        <label for="rc-payout-account">Add payout to account?</label>
        <select class="select" id="rc-payout-account">
          <option value="">Don't add to any account</option>
          ${accountOptions}
        </select>
        <span class="field-hint">If you don't add it, the payout is still recorded in this cycle's history — it just won't change any account balance.</span>
      </div>
      <div class="field hidden" id="rc-membership-field">
        <label for="rc-membership">Which of your memberships won?</label>
        <select class="select" id="rc-membership"></select>
      </div>
    `,
    onMount: (root) => {
      if (memberships.length > 0) {
        qs('#rc-membership', root).innerHTML = memberships.map((m) => `<option value="${m.id}">Membership #${m.slotNumber}</option>`).join('');
      }
      const recalc = () => {
        const skip = qs('#rc-skip', root).checked;
        qs('#rc-bid-fields', root).classList.toggle('hidden', skip);
        const bid = skip ? 0 : Number(qs('#rc-bid', root).value) || 0;
        const won = !skip && qs('#rc-won', root).checked;

        const discount = roundMoney(bid / committee.numberOfMembers);
        const payablePer = roundMoney(committee.baseContribution - discount);
        const totalPayable = roundMoney(payablePer * committee.userMemberships);
        const saving = roundMoney(discount * committee.userMemberships);
        const payout = won ? roundMoney(committee.totalAmount - bid) : 0;

        qs('#rc-calc-hint', root).textContent =
          `Payable: ${formatCurrency(totalPayable)} · Your profit: ${formatCurrency(saving)}` +
          (won ? ` · Payout: ${formatCurrency(payout)}` : '');

        qs('#rc-payout-field', root).classList.toggle('hidden', !(won && payout > 0));
        qs('#rc-membership-field', root).classList.toggle('hidden', !(won && memberships.length > 0));
      };
      qs('#rc-skip', root).addEventListener('change', recalc);
      qs('#rc-bid', root).addEventListener('input', recalc);
      qs('#rc-won', root).addEventListener('change', recalc);
      recalc();
    },
    actions: [
      { label: 'Cancel', variant: 'btn-secondary', onClick: (close) => close() },
      {
        label: 'Save Cycle',
        variant: 'btn-primary',
        onClick: async (close, root) => {
          const skip = qs('#rc-skip', root).checked;
          const winningBid = skip ? 0 : Number(qs('#rc-bid', root).value) || 0;
          const userWon = !skip && qs('#rc-won', root).checked;
          const winnerName = qs('#rc-winner', root).value;
          const paymentAccountId = qs('#rc-pay-account', root).value;
          const payoutAccountId = qs('#rc-payout-account', root).value || undefined;
          const winnerMembershipId = (userWon && memberships.length > 0) ? qs('#rc-membership', root).value : undefined;

          try {
            await recordCycle(committee.id, cycle.id, { winningBid, userWon, winnerName, paymentAccountId, payoutAccountId, winnerMembershipId });
            close();
            toast.success('Cycle recorded.');
            refresh();
          } catch (err) {
            toast.error(err instanceof ValidationError ? err.message : 'Something went wrong recording the cycle.');
          }
        },
      },
    ],
  });
}
