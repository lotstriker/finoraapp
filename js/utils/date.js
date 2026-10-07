// ==========================================================================
// Finora — utils/date.js
// ==========================================================================

/**
 * Adds N months to a date, clamping the day to the target month's last
 * valid day instead of letting it overflow (JS default: 31 Jan + 1 month
 * = 3 Mar, since Feb has no 31st). Used anywhere a monthly schedule is
 * generated — loan installments, committee cycles, recurring rules.
 */
export function addMonthsClamped(dateIso, months, anchorDay) {
  const d = new Date(dateIso);
  // anchorDay lets a schedule REMEMBER its intended day: Jan 31 -> Feb 28 -> Mar 31
  // (without it, the clamp to 28 stuck forever: Jan 31 -> Feb 28 -> Mar 28 -> ...).
  const day = anchorDay || d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTargetMonth));
  return d;
}

/**
 * Today's date as YYYY-MM-DD in the user's LOCAL timezone.
 * (new Date().toISOString().slice(0,10) is UTC, so between 00:00 and
 * 05:30 IST it returned yesterday's date.)
 */
export function todayLocal() {
  return new Date().toLocaleDateString('en-CA');
}

/**
 * Converts an <input type="date"> value (YYYY-MM-DD) to an ISO timestamp.
 * - today's date  -> "now" (keeps real time-of-day ordering)
 * - any other day -> local noon (so timezone shifts can never move it to
 *   the previous/next calendar day)
 * Returns undefined for empty input.
 */
export function dateInputToIso(value) {
  if (!value) return undefined;
  if (value === todayLocal()) return new Date().toISOString();
  return new Date(`${value}T12:00:00`).toISOString();
}
