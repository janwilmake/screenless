/**
 * Wall-clock arithmetic for a service whose entire product is "at 07:00, your
 * time".
 *
 * Everything here works in IANA zones rather than fixed offsets, because the
 * one thing a morning call cannot do is arrive an hour late twice a year. A
 * stored "+02:00" is correct until the last Sunday in October; a stored
 * "Europe/Amsterdam" stays correct.
 */

/** Whether the runtime recognises this as an IANA zone. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "07:00" → {hour, minute}, or null. Rejects 24:00 and 7:5. */
export function parseClock(value: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

/** How far ahead of UTC `tz` is at a given instant, in milliseconds. */
function offsetMs(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(at)
    .filter((p) => p.type !== "literal");

  const f = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  // hour comes back as 24 at midnight under hour12:false in some ICU builds.
  const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second);
  return asUTC - at.getTime();
}

/** The calendar date it currently is in `tz`. */
function dateIn(tz: string, at: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  const [year, month, day] = parts.split("-").map(Number);
  return { year, month, day };
}

/**
 * The UTC instant of a given wall-clock time on a given date in `tz`.
 *
 * Solved by iteration because the offset depends on the answer: to know what
 * UTC time 07:00 Amsterdam is, you need to know whether 07:00 Amsterdam is in
 * summer time, which you only know once you have a date. Two passes settle it
 * for every case except the hour that DST deletes, where the second pass lands
 * just outside the gap — an acceptable answer for a call, and the reason this
 * is not a one-liner.
 */
function utcFor(
  tz: string,
  d: { year: number; month: number; day: number },
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(d.year, d.month - 1, d.day, hour, minute);
  let ts = naive;
  for (let i = 0; i < 2; i++) ts = naive - offsetMs(tz, new Date(ts));
  return ts;
}

/**
 * Next time it will be `HH:MM` in `tz`, as ms since epoch.
 *
 * `from` defaults to now. If today's occurrence has already passed, this
 * returns tomorrow's — the property that makes "set my call to 07:00" mean the
 * same thing whether it is typed at 06:00 or at 23:00.
 */
export function nextOccurrence(
  clock: { hour: number; minute: number },
  tz: string,
  from: number = Date.now(),
): number {
  const today = dateIn(tz, new Date(from));
  const todays = utcFor(tz, today, clock.hour, clock.minute);
  if (todays > from) return todays;

  // Step a day in UTC first, then re-read the local date, so this stays right
  // across month ends and the days DST makes 23 or 25 hours long.
  const tomorrow = dateIn(tz, new Date(todays + 24 * 60 * 60 * 1000));
  return utcFor(tz, tomorrow, clock.hour, clock.minute);
}
