/**
 * Personas: a medieval name pool, a role thesaurus and four ranks, lifted from
 * `research/agent-view/spike/{names,roles}.mjs`. A promotion draws a fresh name
 * (which is also the blobatar seed) and advances the role noun. Names are unique
 * among the agents shown at the same time; past the end of the pool a numeral is
 * appended (`Aldric II`).
 */
import type { PersonaName, PersonaStore } from "./source/history.ts";

export const NAME_POOL: string[] = [
  ...new Set(
    `Aldric Aelfric Aldous Ambrose Anselm Aveline Baldric Bertram Beatrix Berengar Blanche Brannoc Cadoc Cecily Cedric Clemence Colette Cuthbert Dagobert Dunstan Drogo Dougal Eadric Eadgyth Edda Edmund Egbert Eleanor Elfrida Emeric Enid Eustace Fenella Fergus Fulk Gawain Geoffrey Gervase Gilbert Giselle Godric Godiva Gunnhild Hadwin Hawise Hengist Hereward Hilda Hugh Humphrey Idony Ingram Isolde Isembard Ivo Jocelin Kenelm Lambert Lancelot Leofric Lorcan Mabel Maelgwn Magnus Margery Mathilda Merewyn Mildred Morcar Nigel Nest Odo Offa Osbert Oswin Ottilie Pernel Petronel Piers Quenby Radulf Ranulf Reynold Rhiannon Rohese Rowena Roland Sabina Saewulf Sibyl Siward Stigand Swithin Tancred Theobald Thurstan Tristan Ulric Ursula Uther Vivian Walter Wilfrid Winifred Wulfstan Wystan Yolande Yvain Zenobia`.split(
      /\s+/,
    ),
  ),
];

export interface Role {
  label: string;
  nouns: string[];
}

export const ROLES: Record<string, Role> = {
  impl: {
    label: "builder",
    nouns: [
      "Builder",
      "Wright",
      "Mason",
      "Artificer",
      "Joiner",
      "Smith",
      "Forgemaster",
      "Framer",
      "Thatcher",
    ],
  },
  fix: {
    label: "fixer",
    nouns: [
      "Mender",
      "Fixer",
      "Tinker",
      "Bonesetter",
      "Chirurgeon",
      "Leech",
      "Cobbler",
      "Darner",
      "Healer",
    ],
  },
  review: {
    label: "reviewer",
    nouns: [
      "Warden",
      "Reeve",
      "Seneschal",
      "Assessor",
      "Inquisitor",
      "Examiner",
      "Reckoner",
      "Sentinel",
      "Bailiff",
      "Overseer",
    ],
  },
  research: {
    label: "researcher",
    nouns: [
      "Wanderer",
      "Wayfarer",
      "Scribe",
      "Pilgrim",
      "Seeker",
      "Outrider",
      "Lookout",
      "Chronicler",
      "Questor",
      "Loremaster",
      "Watchman",
      "Warder",
    ],
  },
  clef: {
    label: "classifier",
    nouns: [
      "Oracle",
      "Augur",
      "Seer",
      "Arbiter",
      "Doomsman",
      "Soothsayer",
      "Justiciar",
      "Herald",
    ],
  },
  scout: {
    label: "scout",
    nouns: [
      "Outrider",
      "Forerunner",
      "Pathfinder",
      "Vanguard",
      "Spy",
      "Picket",
    ],
  },
  oracle: {
    label: "advisor",
    nouns: ["Sage", "Chancellor", "Counsellor", "Magister", "Steward"],
  },
  worker: {
    label: "builder",
    nouns: ["Builder", "Wright", "Mason", "Artificer", "Smith"],
  },
  delegate: {
    label: "retainer",
    nouns: ["Retainer", "Henchman", "Yeoman", "Varlet", "Squire", "Page"],
  },
};

export interface Rank {
  at: number;
  name: string;
  glyph: string;
}

export const RANKS: Rank[] = [
  { at: 0, name: "Page", glyph: "♙" },
  { at: 0.25, name: "Squire", glyph: "♘" },
  { at: 0.5, name: "Knight", glyph: "♞" },
  { at: 0.75, name: "Banneret", glyph: "♛" },
];

export function rankIndex(progress: number): number {
  return RANKS.reduce(
    (current, rank, index) => (progress >= rank.at ? index : current),
    0,
  );
}

const AGENT_ROLES: Record<string, string> = {
  worker: "worker",
  implementer: "impl",
  builder: "impl",
  fixer: "fix",
  reviewer: "review",
  verifier: "review",
  researcher: "research",
  research: "research",
  scout: "scout",
  oracle: "oracle",
  advisor: "oracle",
  clef: "clef",
  classifier: "clef",
  delegate: "delegate",
  retainer: "delegate",
};

/** Role from the child key prefix (`impl-`, `fix-`, `review-`, `clef`, ...), else from the agent name. */
export function detectRole(key: string, agent = ""): string {
  const prefix = key.split(/[-:.]/)[0]?.toLowerCase() ?? "";
  if (prefix in ROLES) return prefix;
  const byAgent = AGENT_ROLES[agent.toLowerCase()];
  if (byAgent) return byAgent;
  return "delegate";
}

export function roleOf(roleKey: string): Role {
  return ROLES[roleKey] ?? ROLES.delegate;
}

const NUMERALS = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** Deterministic shuffle so a fresh process re-draws the same order. */
function xorshift(seed: number) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/**
 * Assigns at most one live name per agent, persisting the choice per
 * (persona id, rank). Persisted entries win while their name is still free; a
 * collision (for example after another session used the same name) draws fresh.
 */
export class PersonaBook {
  private readonly store: PersonaStore | undefined;
  private readonly deck: string[];
  private cursor = 0;
  private readonly byOwner = new Map<string, PersonaName>();
  private readonly taken = new Set<string>();
  private dirty = false;

  constructor(
    store: PersonaStore | undefined,
    pool: string[] = NAME_POOL,
    seed = 0x5eed1234,
  ) {
    this.store = store;
    const random = xorshift(seed);
    this.deck = [...pool].sort(() => random() - 0.5);
  }

  /** Names handed to live agents (unique while the pool lasts). */
  get drawnNames(): string[] {
    return [...this.taken];
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  markSaved(): void {
    this.dirty = false;
  }

  private draw(): string {
    for (let attempts = 0; attempts < this.deck.length * 2; attempts += 1) {
      const base = this.deck[this.cursor % this.deck.length];
      const cycle = Math.floor(this.cursor / this.deck.length);
      this.cursor += 1;
      const name =
        cycle === 0
          ? base
          : `${base} ${NUMERALS[cycle - 1] ?? String(cycle + 1)}`;
      if (!this.taken.has(name)) return name;
    }
    return `${this.deck[0]} ${this.cursor}`;
  }

  /** Persona for a child at a rank. Stable per (persona id, rank). */
  persona(
    runId: string,
    key: string,
    roleKey: string,
    rank: number,
  ): PersonaName {
    const id = personaId(runId, key);
    const cacheKey = `${id}:${rank}`;
    const existing = this.byOwner.get(cacheKey);
    if (existing) return existing;

    const stored = this.store?.get(id, rank);
    let name: string;
    let noun: string;
    if (stored && !this.taken.has(stored.name)) {
      name = stored.name;
      noun = stored.noun;
    } else {
      name = this.draw();
      const nouns = roleOf(roleKey).nouns;
      const offset = rank + hashKey(key);
      noun = nouns[offset % nouns.length];
      this.store?.set(id, rank, { name, noun });
      this.dirty = true;
    }
    this.taken.add(name);
    this.byOwner.set(cacheKey, { name, noun });
    return { name, noun };
  }

  /** Names of the personas currently shown (for the uniqueness invariant). */
  liveNames(): string[] {
    return [...this.taken];
  }
}

/**
 * Stable identity of one agent card. Workflow children carry their child key;
 * steps of a chain or parallel run share a run id, so the step key decides.
 */
export function personaId(runId: string, key: string): string {
  if (!runId) return key;
  if (key === runId) return runId;
  return `${runId}::${key}`;
}

export function hashKey(key: string): number {
  let hash = 2166136261;
  for (const char of key) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
