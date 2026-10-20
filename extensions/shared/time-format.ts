const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Whole-second duration that keeps a steady width as it ticks:
 * `42s`, `4m 05s`, `1h 05m 12s`. Negative or non-finite input reads as `0s`.
 */
export function formatDuration(ms: number) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1_000) : 0;
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * Local 24-hour wall-clock time (`22:14:07`). A time from another day also
 * carries its date (`Oct 19 22:14:07`, plus the year when it is not this year),
 * so rows restored from an older session stay unambiguous.
 */
export function formatClock(timestamp: number, now = Date.now()) {
  const at = new Date(timestamp);
  const today = new Date(now);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;

  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate();
  if (sameDay) return time;

  const date = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === today.getFullYear()
    ? `${date} ${time}`
    : `${date} ${at.getFullYear()} ${time}`;
}
