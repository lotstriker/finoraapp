// ==========================================================================
// Finora — app.js
// Entry point. Wires up theme, sidebar/topbar chrome, and a tiny hash
// router between the pages that exist so far (Dashboard, Accounts).
// Modules not yet built are listed in the nav (so the app's shape is
// honest about what's coming) but are inert with a "Soon" badge.
// ==========================================================================

import { openDB } from './core/db.js';
import { seedDefaultCategories } from './modules/categories.js';
import { initTheme, getTheme, setTheme } from './utils/theme.js';
import { initCurrency } from './utils/currency.js';
import { icons } from './utils/icons.js';
import { toast } from './core/toast.js';
import { qs, qsa } from './utils/dom.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderAccountsPage } from './pages/accounts-page.js';
import { renderIncomePage } from './pages/income-page.js';
import { renderExpensesPage } from './pages/expenses-page.js';
import { renderTransfersPage } from './pages/transfers-page.js';
import { renderTransactionsPage } from './pages/transactions-page.js';
import { renderPeoplePage } from './pages/people-page.js';
import { renderLoansPage } from './pages/loans-page.js';
import { renderCommitteesPage } from './pages/committees-page.js';
import { renderBudgetsPage } from './pages/budgets-page.js';
import { renderScheduledPage } from './pages/scheduled-page.js';
import { renderBillSplitsPage } from './pages/bill-splits-page.js';
import { renderInvestmentsPage } from './pages/investments-page.js';
import { renderSavingsPage } from './pages/savings-page.js';
import { renderRecurringPage } from './pages/recurring-page.js';
import { renderReportsPage } from './pages/reports-page.js';
import { renderSettingsPage } from './pages/settings-page.js';
import { runOnboarding } from './pages/onboarding.js';
import { renderSearchPage } from './pages/search-page.js';
import { isOnboardingComplete, getEnabledModules } from './modules/preferences.js';
import { checkAndNotify } from './modules/notifications.js';

const NAV = [
  { group: 'Overview', items: [
    { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', ready: true },
  ] },
  { group: 'Money', items: [
    { key: 'accounts', label: 'Accounts', icon: 'accounts', ready: true },
    { key: 'income', label: 'Income', icon: 'income', ready: true, optional: true },
    { key: 'expenses', label: 'Expenses', icon: 'expense', ready: true, optional: true },
    { key: 'transfers', label: 'Transfers', icon: 'transfer', ready: true },
    { key: 'transactions', label: 'Transactions', icon: 'history', ready: true },
  ] },
  { group: 'People', items: [
    { key: 'people', label: 'People', icon: 'people', ready: true, optional: true },
    { key: 'billsplits', label: 'Bill Splits', icon: 'billsplits', ready: true, optional: true },
  ] },
  { group: 'Plans', items: [
    { key: 'budgets', label: 'Budgets', icon: 'budgets', ready: true, optional: true },
    { key: 'scheduled', label: 'Scheduled', icon: 'scheduled', ready: true, optional: true },
    { key: 'bidsave', label: 'Bid & Save', icon: 'bidsave', ready: true, optional: true },
    { key: 'loans', label: 'Loans & EMI', icon: 'loans', ready: true, optional: true },
    { key: 'savings', label: 'Savings', icon: 'savings', ready: true, optional: true },
    { key: 'investments', label: 'Investments', icon: 'investments', ready: true, optional: true },
    { key: 'recurring', label: 'Recurring', icon: 'recurring', ready: true, optional: true },
  ] },
  { group: 'Insights', items: [
    { key: 'search', label: 'Search', icon: 'search', ready: true },
    { key: 'reports', label: 'Reports', icon: 'reports', ready: true },
  ] },
  { group: 'System', items: [
    { key: 'settings', label: 'Settings', icon: 'settings', ready: true },
  ] },
];

const PAGES = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  search: { title: 'Search', render: renderSearchPage },
  accounts: { title: 'Accounts', render: renderAccountsPage },
  income: { title: 'Income', render: renderIncomePage },
  expenses: { title: 'Expenses', render: renderExpensesPage },
  transfers: { title: 'Transfers', render: renderTransfersPage },
  transactions: { title: 'Transactions', render: renderTransactionsPage },
  people: { title: 'People', render: renderPeoplePage },
  billsplits: { title: 'Bill Splits', render: renderBillSplitsPage },
  investments: { title: 'Investments', render: renderInvestmentsPage },
  loans: { title: 'Loans & EMI', render: renderLoansPage },
  bidsave: { title: 'Bid & Save', render: renderCommitteesPage },
  budgets: { title: 'Budgets', render: renderBudgetsPage },
  scheduled: { title: 'Scheduled', render: renderScheduledPage },
  savings: { title: 'Savings', render: renderSavingsPage },
  recurring: { title: 'Recurring', render: renderRecurringPage },
  reports: { title: 'Reports', render: renderReportsPage },
  settings: { title: 'Settings', render: renderSettingsPage },
};

function buildShell() {
  document.body.innerHTML = `
    <div class="app-shell">
      <div class="sidebar-scrim" id="sidebar-scrim"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-top">
          <div class="brand"><span class="brand-mark">F</span><span class="brand-text">Finora</span></div>
          <button class="sidebar-expand-btn" id="sidebar-expand-btn" aria-label="Expand sidebar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <nav id="sidebar-nav"></nav>
      </aside>
      <div class="main">
        <header class="topbar">
          <div style="display:flex; align-items:center; gap: var(--sp-3);">
            <button class="hamburger" id="hamburger" aria-label="Open menu">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
            <span class="topbar-title" id="topbar-title">Dashboard</span>
          </div>
          <div class="theme-toggle" id="theme-toggle">
            <button data-theme="light" aria-label="Light">${icons.sun}</button>
            <button data-theme="dark" aria-label="Dark">${icons.moon}</button>
            <button data-theme="system" aria-label="System">${icons.monitor}</button>
          </div>
        </header>
        <main class="page-mount" id="page-mount"></main>
      </div>
    </div>
  `;
}

let cachedEnabledModules = {};

function renderNav(activeKey) {
  const nav = qs('#sidebar-nav');
  nav.innerHTML = NAV.map((group) => {
    const visibleItems = group.items.filter((item) => !item.optional || cachedEnabledModules[item.key] !== false);
    if (visibleItems.length === 0) return '';
    return `
    <div class="nav-group">
      <div class="nav-group-label">${group.group}</div>
      ${visibleItems.map((item) => `
        <a href="#/${item.key}" class="nav-item ${item.key === activeKey ? 'active' : ''}" data-key="${item.key}" data-ready="${item.ready}">
          ${icons[item.icon] || ''}
          <span class="nav-item-label">${item.label}</span>
          ${item.ready ? '' : '<span class="badge badge-neutral nav-item-badge">Soon</span>'}
        </a>
      `).join('')}
    </div>
  `;
  }).join('');

  qsa('.nav-item', nav).forEach((el) => {
    el.addEventListener('click', (e) => {
      if (el.dataset.ready === 'false') {
        e.preventDefault();
        toast.info(`${el.textContent.trim()} arrives in a later phase.`);
      }
      closeMobileSidebar();
    });
  });
}

function wireTopbar() {
  const toggle = qs('#theme-toggle');
  const syncActive = () => {
    const current = getTheme();
    qsa('button', toggle).forEach((b) => b.classList.toggle('active', b.dataset.theme === current));
  };
  qsa('button', toggle).forEach((btn) => {
    btn.addEventListener('click', () => { setTheme(btn.dataset.theme); syncActive(); });
  });
  syncActive();

  qs('#hamburger').addEventListener('click', () => {
    qs('#sidebar').classList.add('open');
    qs('#sidebar-scrim').classList.add('open');
  });
  qs('#sidebar-scrim').addEventListener('click', closeMobileSidebar);

  const sidebar = qs('#sidebar');
  const appShell = document.querySelector('.app-shell');
  const expandBtn = qs('#sidebar-expand-btn');
  const applyExpanded = (expanded) => {
    sidebar.classList.toggle('expanded', expanded);
    appShell.classList.toggle('sidebar-expanded', expanded);
    expandBtn.classList.toggle('is-expanded', expanded);
    expandBtn.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
  };
  applyExpanded(localStorage.getItem('sidebarExpanded') === 'true');
  expandBtn.addEventListener('click', () => {
    const next = !sidebar.classList.contains('expanded');
    applyExpanded(next);
    localStorage.setItem('sidebarExpanded', String(next));
  });
}

function closeMobileSidebar() {
  qs('#sidebar')?.classList.remove('open');
  qs('#sidebar-scrim')?.classList.remove('open');
}

async function route() {
  const raw = location.hash.replace('#/', '');
  const [rawKey, queryString] = raw.split('?');
  const key = rawKey || 'dashboard';
  const params = new URLSearchParams(queryString || '');
  const navItem = NAV.flatMap((g) => g.items).find((i) => i.key === key);
  const disabled = navItem?.optional && cachedEnabledModules[key] === false;
  const page = (PAGES[key] && !disabled) ? PAGES[key] : PAGES.dashboard;
  const resolvedKey = (PAGES[key] && !disabled) ? key : 'dashboard';
  if (disabled) location.hash = '#/dashboard';

  renderNav(resolvedKey);
  qs('#topbar-title').textContent = page.title;

  const mount = qs('#page-mount');
  mount.innerHTML = '';
  try {
    await page.render(mount, params);
  } catch (err) {
    console.error(err);
    toast.error('Something went wrong loading this page.');
  }
}

async function main() {
  initTheme();
  initCurrency();
  buildShell();
  wireTopbar();

  try {
    await openDB();
    await seedDefaultCategories();
  } catch (err) {
    console.error(err);
    toast.error('Could not open local storage. Try a different browser or check storage permissions.');
    return;
  }

  if (!(await isOnboardingComplete())) {
    await runOnboarding();
  }
  cachedEnabledModules = await getEnabledModules();

  window.addEventListener('finora:modules-changed', async () => {
    cachedEnabledModules = await getEnabledModules();
    renderNav((location.hash.replace('#/', '') || 'dashboard'));
  });

  window.addEventListener('hashchange', route);
  route();

  checkAndNotify().catch(() => {});
  setInterval(() => { checkAndNotify().catch(() => {}); }, 15 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', main);
