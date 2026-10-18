/**
 * Everything printed inside a thought bubble goes through `redact` first: events
 * carry prompts, commands and tool output, and a terminal is a screenshot away
 * from being shared. Rules are deliberately blunt; false positives are cheaper
 * than a leaked token.
 *
 * The home directory is collapsed first, so the path rules below see `~` and a
 * long absolute path cannot be mistaken for a base64 blob.
 */
import * as os from "node:os";

const HOME = os.homedir();

type Replacement =
  string | ((match: string, offset: number, whole: string) => string);

interface Rule {
  pattern: RegExp;
  replacement: Replacement;
}

const SLASH_BLOB: Rule = {
  pattern: /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
  replacement: (match, offset, whole) => {
    if (!/[a-z]/.test(match) || !/[A-Z]/.test(match)) return match;
    if (!/[0-9+=]/.test(match)) return match;
    const before = offset > 0 ? whole[offset - 1] : "";
    if (before === "/" || before === "~" || before === ".") return match;
    if (whole[offset + match.length] === ".") {
      const next = whole[offset + match.length + 1] ?? "";
      if (/[A-Za-z0-9]/.test(next)) return match;
    }
    return "[redacted-blob]";
  },
};

const RULES: Rule[] = [
  {
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted-private-key]",
  },
  {
    pattern: /\b(Bearer)\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
    replacement: "$1 [redacted]",
  },
  {
    // `key: value`, `key=value` and the JSON-quoted `"key": "value"` form; the
    // optional closing quote after the key is what makes JSON match.
    pattern:
      /\b(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|client[-_]?secret|password|passwd|secret)\b("?\s*[:=]\s*)("?)(?!Bearer\b)([^\s"',;]{4,})\3/gi,
    replacement: "$1$2[redacted]",
  },
  {
    // AWS secret access keys are 40 base64 characters. `SecretAccessKey` has no
    // word boundary after `secret`, so the generic keyword rule cannot see it,
    // and the JSON form carries no `=`. Both the JSON and ini spellings match.
    pattern:
      /\b((?:aws_)?secret_?access_?key)\b("?\s*[:=]\s*)("?)([A-Za-z0-9/+]{40,}={0,2})\3/gi,
    replacement: "$1$2[redacted]",
  },
  {
    pattern:
      /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*)\s*=\s*("?)([^\s"';]{4,})\2/gi,
    replacement: "$1=[redacted]",
  },
  {
    // Command-line flags: `mysql --password hunter2`, `curl --token=abc123`.
    pattern:
      /(^|\s)(--(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|client[-_]?secret))(?:=|\s+)\S+/gi,
    replacement: "$1$2=[redacted]",
  },
  {
    // Credentials inside a URL: `postgres://admin:S3cret@db`.
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]{1,64}:)([^\s@/]{2,})@/gi,
    replacement: "$1[redacted]@",
  },
  {
    pattern:
      /\b(?:sk|pk|rk|ghp|gho|ghs|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
    replacement: "[redacted-key]",
  },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: "[redacted-key]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{28,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, replacement: "[redacted-key]" },
  { pattern: /\bnpm_[A-Za-z0-9]{20,}\b/g, replacement: "[redacted-key]" },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "[redacted-jwt]",
  },
  { pattern: /\b[0-9a-fA-F]{32,}\b/g, replacement: "[redacted-hex]" },
  // Base64 runs may contain `/`, which the slash-free rule below cannot match.
  // Splitting a long path on `/` looks the same, so a candidate must carry
  // both letter cases and a digit or padding, must not start inside a path
  // segment (no `/`, `~` or `.` right before it), and must not be glued to a
  // file extension right after it. A real base64 secret still matches. This
  // rule runs first, because the slash-free rule would otherwise match only the
  // trailing segment of a run and leave the leading part in clear.
  SLASH_BLOB,
  {
    // Long base64-ish runs. 40+ characters without `/`, `.` or `-`, so an
    // ordinary file path or prose word never matches, and with at least one
    // digit or `+`/`=` inside, so a long camel-case identifier survives.
    pattern:
      /\b(?=[A-Za-z0-9+]*[+=0-9])[A-Za-z0-9+]{40,}={0,2}(?![A-Za-z0-9+/=])/g,
    replacement: "[redacted-blob]",
  },
  // The extension guard can reject a whole run, after which the slash-free rule
  // redacts only its tail. Offer the remaining leading part to the callback a
  // second time, now followed by `[` rather than the extension.
  SLASH_BLOB,
];

export function redact(text: string): string {
  let out = text;
  // Collapse the home directory first: `~` is short, so a home path cannot
  // reach the 40-character blob rule and lose its name.
  if (HOME && HOME.length > 1) {
    out = out.split(HOME).join("~");
  }
  for (const rule of RULES) {
    const { pattern, replacement } = rule;
    out =
      typeof replacement === "string"
        ? out.replace(pattern, replacement)
        : out.replace(pattern, replacement);
  }
  return out;
}

/** Shorten a path for display, collapsing the home directory and long runs. */
export function shortenPath(value: string, max = 48): string {
  const home =
    HOME && HOME.length > 1 && value.startsWith(HOME)
      ? `~${value.slice(HOME.length)}`
      : value;
  if (home.length <= max) return home;
  const parts = home.split("/");
  if (parts.length <= 3) return `…${home.slice(-(max - 1))}`;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}
