import assert from "node:assert/strict";
import { test } from "node:test";
import { promotionRows } from "./promotion.ts";
import { createStyles } from "../ui/style.ts";
import { fakeTheme, stripAnsi } from "../harness.ts";
import { visibleWidth } from "../ui/text.ts";

const styles = createStyles(fakeTheme(), {
  noColor: false,
  reducedMotion: false,
});
test("the promotion sequence is deterministic, bounded, and settles after 5.6 seconds", () => {
  for (const width of [12, 40, 120, 1000]) {
    for (const t of [0, 0.5, 1, 2, 3, 4.5, 5.5]) {
      const rows = promotionRows(t, 0, "Cecily", "Squire", 1, width, styles);
      assert.deepEqual(
        rows,
        promotionRows(t, 0, "Cecily", "Squire", 1, width, styles),
      );
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.ok((rows[1]?.match(/✦/g) ?? []).length <= 24);
    }
  }
  assert.match(
    promotionRows(3, 0, "Cecily", "Squire", 1, 80, styles)
      .map(stripAnsi)
      .join("\n"),
    /PROMOTED.*Cecily/,
  );
  assert.deepEqual(
    promotionRows(5.6, 0, "Cecily", "Squire", 1, 80, styles),
    [],
  );
  assert.deepEqual(promotionRows(0, 1, "Cecily", "Squire", 1, 80, styles), []);
});
test("reduced motion and NO_COLOR never run the flourish", () => {
  for (const environment of [
    { noColor: false, reducedMotion: true },
    { noColor: true, reducedMotion: true },
  ]) {
    assert.deepEqual(
      promotionRows(
        3,
        0,
        "Cecily",
        "Squire",
        1,
        80,
        createStyles(fakeTheme(), environment),
      ),
      [],
    );
  }
});
