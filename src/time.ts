/** The class runs on India Standard Time (UTC+5:30, no DST). All "today" logic uses it. */
export const TZ = "Asia/Kolkata";
/** Today's date in IST as YYYY-MM-DD. */
export const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

import type { CalEvent } from "./db.js";

/** Weekly events: shift to the next occurrence on/after today so students see an upcoming date. */
const shiftDate = (s: string, days: number) => {
  const d = new Date(`${s.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) + s.slice(10);
};
export const nextOccurrence = (e: CalEvent) => {
  if (e.repeat !== "weekly") return { starts_at: e.starts_at, ends_at: e.ends_at };
  const today = istToday();
  const gap = Math.max(0, Math.ceil((Date.parse(today) - Date.parse(e.starts_at.slice(0, 10))) / 86_400_000));
  const shift = Math.ceil(gap / 7) * 7;
  return { starts_at: shiftDate(e.starts_at, shift), ends_at: e.ends_at ? shiftDate(e.ends_at, shift) : null };
};
