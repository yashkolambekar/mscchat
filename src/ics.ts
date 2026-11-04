import type { CalEvent } from "./db.js";
import { TZ } from "./time.js";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Fold to 75 octets per line (RFC 5545), continuation lines start with a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const dateOnly = (s: string) => s.slice(0, 10).replace(/-/g, "");
const dateTime = (s: string) => `${dateOnly(s)}T${s.slice(11, 16).replace(":", "")}00`;
const utcStamp = (sqlite: string) => `${dateOnly(sqlite)}T${sqlite.slice(11, 19).replace(/:/g, "")}Z`;
const nextDay = (ymd: string) => {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
};
const plusHour = (s: string) => {
  const d = new Date(`${s.slice(0, 16)}:00Z`);
  d.setUTCHours(d.getUTCHours() + 1);
  return d.toISOString().slice(0, 16);
};

/** Event times are IST wall-clock times; the feed tags them with TZID so every calendar converts correctly. */
export function buildIcs(list: CalEvent[], postUrl: (docId: number) => string): string {
  const L: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//mscbot//class events//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:MSc Class Events", `X-WR-TIMEZONE:${TZ}`,
    // IST is a fixed +05:30 offset with no DST, so one static rule is enough.
    "BEGIN:VTIMEZONE", `TZID:${TZ}`, "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0530", "TZOFFSETTO:+0530", "TZNAME:IST", "END:STANDARD", "END:VTIMEZONE"];
  for (const e of list) {
    L.push("BEGIN:VEVENT", `UID:${e.uid}@mscbot`, `SEQUENCE:${e.sequence}`, `DTSTAMP:${utcStamp(e.updated_at)}`, `LAST-MODIFIED:${utcStamp(e.updated_at)}`);
    if (e.all_day) {
      L.push(`DTSTART;VALUE=DATE:${dateOnly(e.starts_at)}`);
      L.push(`DTEND;VALUE=DATE:${nextDay(e.ends_at ?? e.starts_at)}`);
    } else {
      L.push(`DTSTART;TZID=${TZ}:${dateTime(e.starts_at)}`);
      L.push(`DTEND;TZID=${TZ}:${dateTime(e.ends_at ?? plusHour(e.starts_at))}`);
    }
    if (e.repeat === "weekly") {
      const day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][new Date(`${e.starts_at.slice(0, 10)}T00:00:00Z`).getUTCDay()];
      L.push(`RRULE:FREQ=WEEKLY;BYDAY=${day}`);
    }
    L.push(`SUMMARY:${esc(e.title)}`);
    if (e.location) L.push(`LOCATION:${esc(e.location)}`);
    const notes = [e.notes, e.doc_id ? postUrl(e.doc_id) : null].filter(Boolean).join("\n\n");
    if (notes) L.push(`DESCRIPTION:${esc(notes)}`);
    L.push(`STATUS:${e.cancelled ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}
