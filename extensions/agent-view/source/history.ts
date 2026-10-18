/**
 * Small local history for the estimate engine and for persona stability:
 *   durations.json — median duration per role, used as the expected duration
 *     behind `~NN%` progress and the ETA.
 *   personas.json  — `<runId> -> { rank -> {name, noun} }`, so reopening the
 *     view shows the same names; entries expire after 24 h and their names
 *     return to the pool.
 * Both files are written atomically (tmp + rename) and are size-capped.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_SAMPLES_PER_ROLE = 40;
const MAX_RECORDED_RUNS = 400;
const MAX_PERSONA_ENTRIES = 400;
export const PERSONA_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Fewer samples than this and the median is noise: one short run would make the
 * next run of the same role look almost finished.
 */
export const MIN_MEDIAN_SAMPLES = 3;

export interface PersonaName {
  name: string;
  noun: string;
}

interface DurationsFile {
  version: 1;
  roles: Record<string, number[]>;
  recorded: Record<string, number>;
  updatedAt: number;
}

interface PersonasFile {
  version: 1;
  entries: Record<
    string,
    { ranks: Record<string, PersonaName>; updatedAt: number }
  >;
}

export function defaultHistoryDir(): string {
  return path.join(
    process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"),
    "agent-view",
  );
}

function readJson<T>(file: string): T | undefined {
  try {
    const text = fs.readFileSync(file, "utf8");
    if (text.length > 4 * 1024 * 1024) return undefined;
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Median duration per role, fed by children that finish while the view is open. */
export class DurationBook {
  private readonly file: string;
  private readonly now: () => number;
  private roles = new Map<string, number[]>();
  private recorded = new Map<string, number>();
  private dirty = false;

  constructor(file: string, now: () => number = () => Date.now()) {
    this.file = file;
    this.now = now;
    this.load();
  }

  load(): void {
    const data = readJson<DurationsFile>(this.file);
    this.roles = new Map();
    this.recorded = new Map();
    if (!data || data.version !== 1) return;
    for (const [role, samples] of Object.entries(data.roles ?? {})) {
      if (!Array.isArray(samples)) continue;
      const clean = samples
        .filter((sample) => typeof sample === "number" && sample > 0)
        .slice(-MAX_SAMPLES_PER_ROLE);
      if (clean.length > 0) this.roles.set(role, clean);
    }
    const cutoff = this.now() - PERSONA_TTL_MS * 2;
    for (const [runId, at] of Object.entries(data.recorded ?? {})) {
      if (typeof at === "number" && at >= cutoff) this.recorded.set(runId, at);
    }
  }

  /**
   * Median duration for a role, or undefined while the history is too thin to
   * trust (see `MIN_MEDIAN_SAMPLES`).
   */
  medianMs(role: string): number | undefined {
    const samples = this.roles.get(role) ?? [];
    if (samples.length < MIN_MEDIAN_SAMPLES) return undefined;
    return median(samples);
  }

  samples(role: string): number {
    return this.roles.get(role)?.length ?? 0;
  }

  /** Record a finished child once; repeated calls for the same run are no-ops. */
  record(role: string, runId: string, durationMs: number): boolean {
    if (!role || !runId) return false;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return false;
    if (this.recorded.has(runId)) return false;
    const samples = this.roles.get(role) ?? [];
    samples.push(durationMs);
    this.roles.set(role, samples.slice(-MAX_SAMPLES_PER_ROLE));
    this.recorded.set(runId, this.now());
    while (this.recorded.size > MAX_RECORDED_RUNS) {
      const oldest = [...this.recorded.entries()].sort(
        (left, right) => left[1] - right[1],
      )[0];
      if (!oldest) break;
      this.recorded.delete(oldest[0]);
    }
    this.dirty = true;
    return true;
  }

  save(): boolean {
    if (!this.dirty) return true;
    const roles: Record<string, number[]> = {};
    for (const [role, samples] of [...this.roles.entries()].sort(
      (left, right) => left[0].localeCompare(right[0]),
    )) {
      roles[role] = samples;
    }
    const value: DurationsFile = {
      version: 1,
      roles,
      recorded: Object.fromEntries(this.recorded),
      updatedAt: this.now(),
    };
    const ok = writeJsonAtomic(this.file, value);
    if (ok) this.dirty = false;
    return ok;
  }
}

export interface StoredPersona {
  ranks: Record<string, PersonaName>;
  updatedAt: number;
}

/** Persisted persona names per run id and rank, with a 24 h TTL. */
export class PersonaStore {
  private readonly file: string;
  private readonly now: () => number;
  private entries = new Map<string, StoredPersona>();
  private dirty = false;

  constructor(file: string, now: () => number = () => Date.now()) {
    this.file = file;
    this.now = now;
    this.load();
  }

  load(): void {
    const data = readJson<PersonasFile>(this.file);
    this.entries = new Map();
    if (!data || data.version !== 1) return;
    const cutoff = this.now() - PERSONA_TTL_MS;
    for (const [runId, entry] of Object.entries(data.entries ?? {})) {
      if (
        !entry ||
        typeof entry.updatedAt !== "number" ||
        entry.updatedAt < cutoff
      )
        continue;
      if (!entry.ranks || typeof entry.ranks !== "object") continue;
      this.entries.set(runId, {
        ranks: entry.ranks,
        updatedAt: entry.updatedAt,
      });
    }
  }

  get(runId: string, rank: number): PersonaName | undefined {
    return this.entries.get(runId)?.ranks[String(rank)];
  }

  all(runId: string): PersonaName[] {
    const entry = this.entries.get(runId);
    return entry ? Object.values(entry.ranks) : [];
  }

  set(runId: string, rank: number, persona: PersonaName): void {
    const entry = this.entries.get(runId) ?? {
      ranks: {},
      updatedAt: this.now(),
    };
    entry.ranks[String(rank)] = persona;
    entry.updatedAt = this.now();
    this.entries.set(runId, entry);
    this.dirty = true;
    if (this.entries.size > MAX_PERSONA_ENTRIES) {
      const oldest = [...this.entries.entries()].sort(
        (left, right) => left[1].updatedAt - right[1].updatedAt,
      )[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
  }

  save(): boolean {
    if (!this.dirty) return true;
    const entries: PersonasFile["entries"] = {};
    for (const [runId, entry] of this.entries) {
      if (entry.updatedAt < this.now() - PERSONA_TTL_MS) continue;
      entries[runId] = entry;
    }
    const ok = writeJsonAtomic(this.file, {
      version: 1,
      entries,
    } satisfies PersonasFile);
    if (ok) this.dirty = false;
    return ok;
  }
}
