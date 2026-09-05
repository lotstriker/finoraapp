// ==========================================================================
// Finora — utils/date.js
// ==========================================================================

/**
 * Adds N months to a date, clamping the day to the target month's last
 * valid day instead of letting it overflow (JS default: 31 Jan + 1 month
 * = 3 Mar, since Feb has no 31st). Used anywhere a monthly schedule is
 * generated — loan installments, committee cycles, recurring rules.
 */
export function addMonthsClamped(dateIso, months) {
  const d = new Date(dateIso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTargetMonth));
  return d;
}
