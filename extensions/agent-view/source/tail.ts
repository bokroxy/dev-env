/**
 * Incremental line tailing for pi-subagents' events.jsonl. The files grow
 * without bound (multi-megabyte), so we keep a byte offset and a bounded window
 * of parsed lines, never the file. A partial last line is buffered across
 * polls; a shrink, or a replacement of the file (inode change), resets the
 * offset.
 */
import * as fs from "node:fs";

export const DEFAULT_MAX_LINE = 32 * 1024;
export const DEFAULT_WINDOW = 400;
const MAX_CHUNK_BYTES = 256 * 1024;
/**
 * How much of an over-long line is kept. Every event puts `type` and
 * `toolName` in its first few hundred bytes, so a bounded prefix is enough to
 * recover them (see `recoverTruncatedEvent`) instead of dropping the event.
 */
export const LONG_LINE_PREFIX = 4096;

export interface TailerOptions {
  maxLine?: number;
  windowSize?: number;
  maxChunkBytes?: number;
}

export class LineTailer {
  readonly file: string;
  private readonly maxLine: number;
  private readonly windowSize: number;
  private readonly maxChunkBytes: number;
  private decoder = new TextDecoder("utf-8");
  private offset = 0;
  private partial = "";
  private window: string[] = [];
  private skipping = false;
  private device = -1;
  private inode = -1;

  bytesRead = 0;
  linesRead = 0;
  /** Over-long lines kept as a bounded prefix rather than dropped. */
  truncatedLongLines = 0;

  constructor(file: string, options: TailerOptions = {}) {
    this.file = file;
    this.maxLine = options.maxLine ?? DEFAULT_MAX_LINE;
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW;
    this.maxChunkBytes = options.maxChunkBytes ?? MAX_CHUNK_BYTES;
  }

  get position(): number {
    return this.offset;
  }

  reset(): void {
    this.offset = 0;
    this.partial = "";
    this.window = [];
    this.decoder = new TextDecoder("utf-8");
    this.skipping = false;
  }

  /** Newly appended complete lines since the last call. */
  poll(): string[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
      if (!stat.isFile()) return [];
    } catch {
      return [];
    }
    const size = stat.size;
    // Rotation: the path now names a different file, even when its size is at
    // least the old offset, so a shrink check alone would read from its middle.
    if (stat.dev !== this.device || stat.ino !== this.inode) {
      this.reset();
      this.device = stat.dev;
      this.inode = stat.ino;
    } else if (size < this.offset) {
      // Truncated: start over.
      this.reset();
    }
    if (size === this.offset) return [];

    let start = this.offset;
    if (size - start > this.maxChunkBytes) {
      start = size - this.maxChunkBytes;
      this.partial = "";
      this.skipping = true;
    }

    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    let fd: number | undefined;
    try {
      fd = fs.openSync(this.file, "r");
      read = fs.readSync(fd, buffer, 0, length, start);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore a close failure: the offset simply does not advance */
        }
      }
    }

    // The offset advances by what was actually read, and only that part of the
    // buffer is decoded: a file that shrank between the stat and the read must
    // not leak uninitialised bytes into a line.
    this.offset = start + read;
    this.bytesRead += read;

    const text = this.decoder.decode(buffer.subarray(0, read), {
      stream: true,
    });
    const chunks = `${this.partial}${text}`.split("\n");
    this.partial = chunks.pop() ?? "";
    if (this.partial.length > this.maxLine) {
      // Keep the head of an unfinished over-long line: the fields that can be
      // recovered from a truncated event sit at its start.
      this.partial = this.partial.slice(0, this.maxLine);
    }

    const fresh: string[] = [];
    for (let index = 0; index < chunks.length; index += 1) {
      if (this.skipping && index === 0) continue;
      const line = chunks[index].endsWith("\r")
        ? chunks[index].slice(0, -1)
        : chunks[index];
      if (line.length === 0) continue;
      if (line.length > this.maxLine) {
        this.truncatedLongLines += 1;
        fresh.push(line.slice(0, LONG_LINE_PREFIX));
        this.linesRead += 1;
        continue;
      }
      fresh.push(line);
      this.linesRead += 1;
    }
    this.skipping = false;

    if (fresh.length > 0) {
      this.window.push(...fresh);
      const overflow = this.window.length - this.windowSize;
      if (overflow > 0) this.window.splice(0, overflow);
    }
    return fresh;
  }

  /** The bounded window of recently parsed lines. */
  recent(count = this.windowSize): string[] {
    return this.window.slice(Math.max(0, this.window.length - count));
  }
}

/**
 * Last `lines` lines of a file, read from a bounded tail (default 64 KiB).
 * Used by the inline detail pane; never loads the whole file.
 */
export function readTailLines(
  file: string,
  lines = 120,
  maxBytes = 64 * 1024,
): string[] {
  let size: number;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return [];
    size = stat.size;
  } catch {
    return [];
  }
  const length = Math.min(size, maxBytes);
  const start = size - length;
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    read = fs.readSync(fd, buffer, 0, length, start);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  const text = new TextDecoder("utf-8").decode(buffer.subarray(0, read));
  const all = text.split("\n");
  // After a partial start the final line is the complete one; keep the tail.
  const usable = start > 0 ? all.slice(1) : all;
  const trimmed = usable.at(-1) === "" ? usable.slice(0, -1) : usable;
  return trimmed
    .slice(Math.max(0, trimmed.length - lines))
    .map((line) => line.replace(/\r$/, ""));
}
