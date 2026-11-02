import * as chrono from 'chrono-node';

// Snooze times are wall-clock times in the browser's time zone (decided presets, plan Task 10a).

const HOUR = 3_600_000;

/** A copy of `d` at `hour`:00 local time, `days` days later. */
function dayAt(d: Date, days: number, hour: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, 0, 0, 0);
}

/** Later today (now + 3 h rounded up to the hour; past 18:00 it becomes tomorrow 08:00), tomorrow morning, this weekend, next week. */
export function presets(now: Date): { label: string; at: Date }[] {
  const tomorrowMorning = dayAt(now, 1, 8);

  const plus3 = new Date(now.getTime() + 3 * HOUR);
  const later = new Date(plus3);
  later.setMinutes(0, 0, 0);
  if (later < plus3) later.setHours(later.getHours() + 1);
  const laterToday = later > dayAt(now, 0, 18) ? tomorrowMorning : later;

  const day = now.getDay(); // 0 Sunday … 6 Saturday
  const weekend = day === 6 || day === 0;
  const toSaturday = weekend ? (day === 6 ? 7 : 6) : 6 - day;
  const toMonday = day === 0 ? 1 : 8 - day;

  return [
    { label: 'Later today', at: laterToday },
    { label: 'Tomorrow morning', at: tomorrowMorning },
    { label: 'This weekend', at: dayAt(now, toSaturday, 9) },
    { label: 'Next week', at: dayAt(now, toMonday, 8) },
  ];
}

/** A typed time ("fri 9am", "in 2 hours"), read forward from `now`. Null when unparseable or not in the future. */
export function parseSnooze(text: string, now: Date): Date | null {
  if (!text.trim()) return null;
  const at = chrono.parseDate(text, now, { forwardDate: true });
  if (!at || at.getTime() <= now.getTime()) return null;
  return at;
}

const WHEN = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "Fri 30 Oct, 09:00" (locale-dependent), for pickers and toasts. */
export function formatWhen(at: Date): string {
  return WHEN.format(at);
}
