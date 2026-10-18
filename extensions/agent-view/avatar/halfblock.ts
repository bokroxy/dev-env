/**
 * RGBA -> half-block text rows. One character cell carries two vertical pixels
 * (`▀` with the top pixel as foreground and the bottom as background), which is
 * what makes a 14x14 raster read as a square face in a terminal. No escape
 * sequence is emitted outside the returned lines; NO_COLOR turns every cell into
 * a blank space (the caller skips avatars entirely in that case).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA bytes, row-major. */
  pixels: Uint8Array;
}

export interface HalfBlockStyle {
  /** SGR prefix for a foreground colour. */
  fg(color: Rgb): string;
  /** SGR prefix for a background colour. */
  bg(color: Rgb): string;
  /** SGR reset to the terminal default background. */
  bgDefault: string;
  reset: string;
}

const ALPHA_CUTOFF = 70;

export function halfBlockRows(image: Raster, style: HalfBlockStyle): string[] {
  const { width, height, pixels } = image;
  const at = (x: number, y: number): Rgb | undefined => {
    if (y >= height || x >= width) return undefined;
    const index = (y * width + x) * 4;
    if (pixels[index + 3] < ALPHA_CUTOFF) return undefined;
    return { r: pixels[index], g: pixels[index + 1], b: pixels[index + 2] };
  };

  const rows: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      if (top && bottom) line += `${style.fg(top)}${style.bg(bottom)}▀`;
      else if (top) line += `${style.fg(top)}${style.bgDefault}▀`;
      else if (bottom) line += `${style.fg(bottom)}${style.bgDefault}▄`;
      else line += " ";
    }
    rows.push(`${line}${style.reset}`);
  }
  return rows;
}
