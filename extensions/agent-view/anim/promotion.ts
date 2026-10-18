import { FLOURISH_SECONDS } from "./scripts.ts";
import type { Styles } from "../ui/style.ts";
import { clip, visibleWidth } from "../ui/text.ts";

const RANK_COLORS = [250, 45, 141, 220];

/** Two reserved rows: one rank ceremony, never a second reasoning bubble. */
export function promotionRows(
  t: number,
  startedAt: number,
  name: string,
  rank: string,
  rankIndex: number,
  width: number,
  styles: Styles,
  fullBurst = true,
) {
  const elapsed = t - startedAt;
  if (!styles.motion || elapsed < 0 || elapsed >= FLOURISH_SECONDS || width < 8)
    return [];
  const color = RANK_COLORS[Math.max(0, Math.min(3, rankIndex))];
  const full = clip(`★ PROMOTED · ${name} the ${rank} ★`, width);
  if (!fullBurst) return [styles.bright(color, full)];
  const chars = Array.from(full);
  // Anticipation, impact/sweep, centre-out reveal, burst, hold, then settle.
  const reveal = Math.max(0, Math.min(1, (elapsed - 0.7) / 1.2));
  const shown = Math.round(chars.length * reveal);
  const left = Math.floor((chars.length - shown) / 2);
  const banner =
    elapsed < 0.45
      ? "Rank rising…"
      : chars
          .map((char, index) =>
            index >= left && index < left + shown ? char : " ",
          )
          .join("");
  const padding = Math.max(0, Math.floor((width - visibleWidth(banner)) / 2));
  const position = Math.floor(
    Math.min(1, Math.max(0, (elapsed - 0.45) / 0.25)) * (width - 1),
  );
  const burstFrame = Math.floor(elapsed * 10);
  let sparkleCount = 0;
  const energy = Array.from({ length: width }, (_, index) => {
    if (elapsed < 0.7) return index === position ? "◆" : "─";
    if (
      elapsed < 4.1 &&
      (index * 7 + burstFrame) % 11 < 2 &&
      sparkleCount < 24
    ) {
      sparkleCount += 1;
      return "✦";
    }
    if (elapsed < 4.1) return " ";
    return index === 0 || index === width - 1 ? "✧" : "─";
  }).join("");
  return [
    clip(
      styles.bold(styles.bright(color, `${" ".repeat(padding)}${banner}`)),
      width,
    ),
    styles.bright(color, energy),
  ];
}
