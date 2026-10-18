/**
 * blobatar -> SVG -> resvg -> RGBA -> half-block rows, cached per
 * (seed, pose, pixel size). `font: { loadSystemFonts: false }` is mandatory:
 * with system font loading each render costs ~900 ms, without it ~0.03 ms
 * (blobatar draws paths only, so no font is ever needed).
 *
 * Both native/pure dependencies are loaded lazily and defensively: if either is
 * missing (extension copied without node_modules), `createAvatarEngine` returns
 * undefined and the view falls back to text-only.
 */
import {
  allocateImageId,
  getCapabilities,
  renderImage,
} from "@earendil-works/pi-tui";
import {
  halfBlockRows,
  type HalfBlockStyle,
  type Raster,
} from "./halfblock.ts";

export type PoseName =
  "idle" | "sleepy" | "thinking" | "happy" | "mad" | "smug";

export const POSES: PoseName[] = [
  "idle",
  "sleepy",
  "thinking",
  "happy",
  "mad",
  "smug",
];

const DEFAULT_CACHE_LIMIT = 400;

export interface AvatarEngine {
  /** High-resolution terminal graphics, rather than half-block glyphs. */
  readonly graphics?: boolean;
  /** Styled rows, already cached; empty when the raster fails. */
  rows(seed: string, pose: PoseName, px: number): string[];
  readonly rasterCount: number;
  readonly rowCacheSize: number;
  readonly failed: boolean;
}

interface CacheEntry<T> {
  value: T;
}

function boundedSet<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T,
  limit: number,
): void {
  cache.set(key, { value });
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export interface AvatarEngineOptions {
  style: HalfBlockStyle;
  cacheLimit?: number;
  /** Default: native graphics in a Kitty-capable real terminal. Tests may opt out. */
  graphics?: boolean;
  /** Injectable for tests: avoids loading the native rasteriser. */
  rasterize?: (seed: string, pose: PoseName, px: number) => Raster | undefined;
}

export async function createAvatarEngine(
  options: AvatarEngineOptions,
): Promise<AvatarEngine | undefined> {
  const rasterCache = new Map<string, CacheEntry<Raster>>();
  const rowCache = new Map<string, CacheEntry<string[]>>();
  const limit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;

  let rasterize = options.rasterize;
  let pngRasterize:
    | ((
        seed: string,
        pose: PoseName,
        px: number,
      ) => { png: string; width: number; height: number })
    | undefined;
  const graphics =
    (options.graphics ?? process.stdout.isTTY === true) &&
    getCapabilities().images === "kitty" &&
    !options.rasterize;
  if (!rasterize) {
    try {
      const [blobatarModule, expressions, resvgModule] = await Promise.all([
        import("blobatar"),
        import("blobatar/expression"),
        import("@resvg/resvg-js"),
      ]);
      if (graphics) {
        pngRasterize = (seed, pose, px) => {
          const svg = blobatarModule.blobatar(seed, {
            expression: expressions[pose],
          });
          const rendered = new resvgModule.Resvg(svg, {
            fitTo: { mode: "width", value: Math.max(128, px * 16) },
            font: { loadSystemFonts: false },
          }).render();
          return {
            png: rendered.asPng().toString("base64"),
            width: rendered.width,
            height: rendered.height,
          };
        };
      }
      rasterize = (seed, pose, px) => {
        const svg = blobatarModule.blobatar(seed, {
          expression: expressions[pose],
        });
        const rendered = new resvgModule.Resvg(svg, {
          fitTo: { mode: "width", value: px },
          font: { loadSystemFonts: false },
        }).render();
        const width = rendered.width;
        const height = rendered.height;
        const pixels = rendered.pixels;
        // Copy out of the native buffer so the raster survives the render object.
        return { width, height, pixels: new Uint8Array(pixels) };
      };
    } catch {
      return undefined;
    }
  }

  let failed = false;
  let rasterCount = 0;
  const engine: AvatarEngine = {
    graphics,
    rows(seed, pose, px) {
      const key = `${seed}|${pose}|${px}`;
      const cachedRows = rowCache.get(key);
      if (cachedRows) return cachedRows.value;
      if (pngRasterize) {
        try {
          const png = pngRasterize(seed, pose, px);
          const image = renderImage(
            png.png,
            { widthPx: png.width, heightPx: png.height },
            {
              maxWidthCells: px,
              maxHeightCells: Math.ceil(px / 2),
              imageId: allocateImageId(),
              moveCursor: false,
            },
          );
          if (image) {
            rasterCount += 1;
            const rows = Array.from(
              { length: Math.ceil(px / 2) },
              (_, row) => `${row === 0 ? image.sequence : ""}${" ".repeat(px)}`,
            );
            boundedSet(rowCache, key, rows, limit);
            return rows;
          }
        } catch {
          // Decoration fails soft: preserve the half-block fallback below.
          failed = true;
        }
      }
      let raster: Raster | undefined;
      const cachedRaster = rasterCache.get(key);
      if (cachedRaster) {
        raster = cachedRaster.value;
      } else {
        try {
          raster = rasterize(seed, pose, px);
          rasterCount += 1;
        } catch {
          failed = true;
          raster = undefined;
        }
        if (raster) boundedSet(rasterCache, key, raster, limit);
      }
      if (!raster) return [];
      const rows = halfBlockRows(raster, options.style);
      boundedSet(rowCache, key, rows, limit);
      return rows;
    },
    get rasterCount() {
      return rasterCount;
    },
    get rowCacheSize() {
      return rowCache.size;
    },
    get failed() {
      return failed;
    },
  };
  return engine;
}
