// ==========================================================================
// Finora — pages/search-page.js
// Unified search across every module. Results deep-link to the EXACT
// record (via ?open=ID, same pattern as Dashboard's recent transactions)
// rather than just the list page.
// ==========================================================================

import { getAll } from '../core/db.js';
import { getAccounts } from '../modules/accounts.js';
import { getPeople } from '../modules/people.js';
import { getCommittees } from '../modules/committees.js';
import { getLoans } from '../modules/loans.js';
import { getGoals } from '../modules/savings.js';
import { getRules } from '../modules/recurring.js';
import { formatCurrency } from '../utils/currency.js';
import { formatDate, escapeHtml, qs } from '../utils/dom.js';
import { icons } from '../utils/icons.js';

let container = null;

export async function renderSearchPage(root) {
  container = root;
  root.innerHTML = `
    <div class="page">
      <div class="page-header"><h1>Search</h1></div>
      <div class="field" style="max-width:420px;">
        <input class="input" id="search-input" type="text" placeholder="Search accounts, people, committees, loans, transactions…" autofocus />
      </div>
      <div id="search-results" class="mt-5"></div>
    </div>
  `;

  const input = qs('#search-input', root);
  input.addEventListener('input', () => runSearch(input.value.trim().toLowerCase()));
  input.focus();
  qs('#search-results', root).innerHTML = `<p class="text-sm text-faint">Start typing to search everything in Finora.</p>`;
}

function section(title, rows) {
  if (rows.length === 0) return '';
  return `
    <h2 style="font-size: var(--fs-sm); font-weight: 650; margin-bottom: var(--sp-2); color: var(--color-text-muted);">${title}</h2>
    <div class="list mb-4">
      ${rows.map((r) => `
        <a href="${r.href}" class="list-row">
          <div class="row-icon">${r.icon}</div>
          <div class="row-main">
            <div class="row-title">${escapeHtml(r.title)}</div>
            <div class="row-sub">${escapeHtml(r.sub || '')}</div>
          </div>
          ${r.amount != null ? `<span class="amount num">${formatCurrency(r.amount)}</span>` : ''}
        </a>
      `).join('')}
    </div>
  `;
}

async function runSearch(query) {
  const resultsEl = qs('#search-results', container);
  if (!query) {
    resultsEl.innerHTML = `<p class="text-sm text-faint">Start typing to search everything in Finora.</p>`;
    return;
  }

  const [accounts, people, committees, loans, goals, rules, ledger] = await Promise.all([
    getAccounts({ includeArchived: true }),
    getPeople({ includeArchived: true }),
    getCommittees(),
    getLoans(),
    getGoals({ includeArchived: true }),
    getRules(),
    getAll('ledger'),
  ]);

  const matches = (s) => (s || '').toLowerCase().includes(query);
  const normalizedAmountQuery = query.replace(/[₹$€£,\s]/g, '');

  const accountResults = accounts
    .filter((a) => matches(a.name))
    .map((a) => ({ icon: icons.accounts, title: a.name, sub: a.type, amount: a.balance, href: `#/accounts?open=${a.id}` }));

  const peopleResults = people
    .filter((p) => matches(p.name) || matches(p.phone) || matches(p.email))
    .map((p) => ({ icon: icons.people, title: p.name, sub: p.balance > 0 ? 'Owes you' : p.balance < 0 ? 'You owe' : 'Settled', amount: Math.abs(p.balance), href: `#/people?open=${p.id}` }));

  const committeeResults = committees
    .filter((c) => matches(c.name))
    .map((c) => ({ icon: icons.bidsave, title: c.name, sub: `${c.userMemberships} membership(s)`, href: `#/bidsave?open=${c.id}` }));

  const loanResults = loans
    .filter((l) => matches(l.name) || matches(l.lender))
    .map((l) => ({ icon: icons.loans, title: l.name, sub: l.lender || l.status, href: `#/loans?open=${l.id}` }));

  const goalResults = goals
    .filter((g) => matches(g.name))
    .map((g) => ({ icon: icons.savings, title: g.name, sub: `${formatCurrency(g.currentAmount)} of ${formatCurrency(g.targetAmount)}`, href: `#/savings?open=${g.id}` }));

  const ruleResults = rules
    .filter((r) => matches(r.name))
    .map((r) => ({ icon: icons.recurring, title: r.name, sub: `${formatCurrency(r.amount)} · next ${formatDate(r.nextDueDate)}`, href: '#/recurring' }));

  const txnResults = ledger
    .filter((t) =>
      matches(t.description) || matches(t.category) || matches(t.type) || matches(t.source) ||
      matches(t.id) || (t.tags || []).some((tag) => matches(tag)) ||
      (normalizedAmountQuery && String(t.amount).includes(normalizedAmountQuery))
    )
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 20)
    .map((t) => ({ icon: icons[t.type] || icons.other, title: t.description || t.type, sub: `${formatDate(t.date)} · ${t.category || t.type}`, amount: t.amount, href: `#/transactions?open=${t.id}` }));

  const totalCount = accountResults.length + peopleResults.length + committeeResults.length + loanResults.length + goalResults.length + ruleResults.length + txnResults.length;

  if (totalCount === 0) {
    resultsEl.innerHTML = `<div class="empty-state"><h3>No results</h3><p>Try a different search term.</p></div>`;
    return;
  }

  resultsEl.innerHTML = [
    section('Accounts', accountResults),
    section('People', peopleResults),
    section('Bid & Save', committeeResults),
    section('Loans & EMI', loanResults),
    section('Savings', goalResults),
    section('Recurring', ruleResults),
    section('Transactions', txnResults),
  ].join('');
}
