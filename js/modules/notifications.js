// ==========================================================================
// Finora — modules/notifications.js
// Local (in-browser) notifications only — Finora has no backend, so there
// is no push server and no way to notify when the app/tab is fully
// closed. While a tab is open, this checks the same "due soon" sources
// as Dashboard's Needs Attention section and fires a native browser
// notification once per item per day (never re-spams the same item).
// ==========================================================================

import { getSetting, setSetting, getEnabledModules } from './preferences.js';
import { getUpcomingRules } from './recurring.js';
import { getLoans, getInstallments } from './loans.js';
import { getPeople, getOutstandingLendings, dueDateStatus } from './people.js';
import { getBudgetProgress } from './budgets.js';
import { getScheduledTransactions, daysUntil } from './scheduled.js';
import { formatCurrency } from '../utils/currency.js';

const NOTIFS_ENABLED_KEY = 'notificationsEnabled';
const NOTIFIED_LOG_KEY = 'notifiedLog'; // { [dedupeKey]: 'YYYY-MM-DD' }

export function isNotificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function getPermission() {
  return isNotificationSupported() ? Notification.permission : 'unsupported';
}

export async function requestPermission() {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.requestPermission();
}

export async function getNotificationsEnabled() {
  return getSetting(NOTIFS_ENABLED_KEY, false);
}

export async function setNotificationsEnabled(enabled) {
  return setSetting(NOTIFS_ENABLED_KEY, enabled);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

/** Collects every item worth notifying about right now, each with a stable id for dedupe. */
export async function getDueItems() {
  const enabledModules = await getEnabledModules();
  const items = [];

  if (enabledModules.recurring) {
    const rules = await getUpcomingRules(3);
    rules.forEach((r) => items.push({
      key: `recurring:${r.id}`,
      title: 'Bill due soon',
      body: `${r.name} — ${formatCurrency(r.amount)} due ${new Date(r.nextDueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
    }));
  }

  if (enabledModules.loans) {
    const loans = await getLoans({ includeClosed: false });
    for (const loan of loans) {
      const installments = await getInstallments(loan.id);
      const pending = installments.find((i) => i.status !== 'paid');
      if (!pending) continue;
      const days = Math.round((new Date(pending.dueDate) - new Date()) / 86400000);
      if (days <= 3) {
        items.push({
          key: `emi:${pending.id}`,
          title: 'EMI due soon',
          body: `${loan.name} — ${formatCurrency(pending.amount)} due ${new Date(pending.dueDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`,
        });
      }
    }
  }

  if (enabledModules.people) {
    const people = await getPeople();
    for (const p of people) {
      const owed = await getOutstandingLendings(p.id, 'out');
      owed.filter((l) => l.remaining > 0 && ['overdue', 'due_today'].includes(dueDateStatus(l.dueDate))).forEach((l) => {
        items.push({ key: `people:${l.id}`, title: `${p.name} owes you`, body: `${formatCurrency(l.remaining)} — ${dueDateStatus(l.dueDate) === 'overdue' ? 'overdue' : 'due today'}` });
      });
    }
  }

  if (enabledModules.budgets) {
    const budgets = await getBudgetProgress();
    budgets.filter((b) => b.overLimit).forEach((b) => {
      items.push({ key: `budget:${b.id}:${todayKey().slice(0, 7)}`, title: `${b.category} budget exceeded`, body: `${formatCurrency(b.spent)} of ${formatCurrency(b.monthlyLimit)} spent this month` });
    });
  }

  if (enabledModules.scheduled) {
    const scheduled = await getScheduledTransactions();
    scheduled.filter((s) => daysUntil(s.scheduledDate) <= 1).forEach((s) => {
      items.push({ key: `scheduled:${s.id}`, title: 'Scheduled transaction', body: `${s.description || s.category} — ${formatCurrency(s.amount)}` });
    });
  }

  return items;
}

/**
 * Fires a browser notification for each due item not already notified
 * today. Safe to call repeatedly (e.g. every time the app loads, or on
 * an interval) — already-notified items are skipped until the next day.
 */
export async function checkAndNotify() {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return 0;
  if (!(await getNotificationsEnabled())) return 0;

  const log = await getSetting(NOTIFIED_LOG_KEY, {});
  const today = todayKey();
  const items = await getDueItems();
  let firedCount = 0;

  for (const item of items) {
    if (log[item.key] === today) continue; // already notified today
    new Notification(item.title, { body: item.body, tag: item.key });
    log[item.key] = today;
    firedCount += 1;
  }

  if (firedCount > 0) await setSetting(NOTIFIED_LOG_KEY, log);
  return firedCount;
}
