import assert from "node:assert/strict";
import * as os from "node:os";
import { test } from "node:test";
import { redact, shortenPath } from "./redact.ts";

test("redacts bearer tokens", () => {
  assert.equal(
    redact("curl -H 'Authorization: Bearer abcdefghijklmnop'"),
    "curl -H 'Authorization: Bearer [redacted]'",
  );
});

test("redacts bearer values after the keyword", () => {
  const out = redact(
    "sent Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 to the api",
  );
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), out);
  assert.match(out, /Bearer \[redacted\]/);
});

test("redacts KEY/TOKEN/PASSWORD assignments in shell and ini styles", () => {
  assert.equal(
    redact("export OPENAI_API_KEY=sk-live-should-not-appear"),
    "export OPENAI_API_KEY=[redacted]",
  );
  assert.equal(
    redact("GITHUB_TOKEN=ghp_abcdefghijklmnopqrst"),
    "GITHUB_TOKEN=[redacted]",
  );
  assert.equal(redact("password: hunter2hunter2"), "password: [redacted]");
  assert.equal(redact("DB_password = supersecret"), "DB_password=[redacted]");
});

test("redacts long hex and base64 blobs", () => {
  const hex = "a".repeat(48);
  assert.ok(!redact(`digest ${hex}`).includes(hex));
  const blob = "QWxsIHlvdXIgYmFzZTY0IGFyZSBiZWxvbmcgdG8gdXM=";
  assert.ok(!redact(`payload ${blob}`).includes(blob));
});

test("redacts private key blocks and known key prefixes", () => {
  const key =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(key), "[redacted-private-key]");
  assert.ok(
    !redact("token sk-abcdefghijklmnopqrstuvwx").includes(
      "sk-abcdefghijklmnopqrstuvwx",
    ),
  );
  assert.ok(!redact("github_pat_" + "a".repeat(30)).includes("github_pat_"));
});

test("shortens the home directory", () => {
  const home = os.homedir();
  const out = redact(`read ${home}/.pi/agent/settings.json`);
  assert.equal(out, "read ~/.pi/agent/settings.json");
});

test("leaves ordinary prose and paths alone", () => {
  const prose =
    "The build finished in 42s and the rollback path looks unsafe; retry with the archive.";
  assert.equal(redact(prose), prose);
  assert.equal(
    redact("run go test -race ./internal/modes/arena"),
    "run go test -race ./internal/modes/arena",
  );
  assert.equal(
    redact("run id 053c1c6e-a255-4b46-96da-478cf27a3bde"),
    "run id 053c1c6e-a255-4b46-96da-478cf27a3bde",
  );
});

test("redacts JSON-quoted keys, CLI flags and URL credentials", () => {
  assert.equal(
    redact('{"api_key": "abcd1234efgh5678"}'),
    '{"api_key": [redacted]}',
  );
  assert.equal(
    redact('{"password": "hunter2hunter2"}'),
    '{"password": [redacted]}',
  );
  assert.equal(
    redact("mysql --password hunter2hunter2"),
    "mysql --password=[redacted]",
  );
  assert.equal(
    redact("curl --token=abc123def456ghi https://example.invalid"),
    "curl --token=[redacted] https://example.invalid",
  );
  assert.equal(
    redact("postgres://admin:S3cretPassw0rd@db.example/app"),
    "postgres://admin:[redacted]@db.example/app",
  );
});

test("redacts provider key formats and JWTs", () => {
  for (const secret of [
    "AKIAIOSFODNN7EXAMPLE",
    "AIzaSyA1234567890abcdefghijklmnopqrstuvw",
    "hf_abcdefghijklmnopqrstuvwx",
    "npm_abcdefghijklmnopqrstuvwx",
  ]) {
    const out = redact(`key ${secret} end`);
    assert.equal(out.includes(secret), false, out);
    assert.match(out, /\[redacted-key\]/);
  }
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const out = redact(`Authorization: Bearer ${jwt}`);
  assert.equal(out.includes(jwt), false, out);
  assert.equal(out.includes("eyJ"), false, out);
});

test("F1: a base64 secret containing `/` is redacted without eating file paths", () => {
  // The AWS form: the value contains `/` and no `=`, so the no-slash blob rule
  // cannot see it, and the generic keyword rule has no word boundary after
  // `Secret`.
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  assert.equal(redact(secret), "[redacted-blob]");
  const json = `{"SecretAccessKey": "${secret}"}`;
  const redactedJson = redact(json);
  assert.equal(redactedJson, '{"SecretAccessKey": [redacted]}');
  assert.equal(redactedJson.includes(secret), false, redactedJson);
  const ini = `aws_secret_access_key = ${secret}`;
  assert.equal(redact(ini).includes(secret), false, redact(ini));
  // The same slash rule must not fire on a path segment: the long-path test
  // above covers the home-anchored form, this one the absolute form.
  const absolute =
    "/home/someone/Documents/GitHub/somerepo/src/components/Header/index.ts";
  assert.equal(redact(absolute), absolute);
});

test("N3: a slash secret with a long slash-free tail is redacted whole", () => {
  // The slash-free blob rule can match the trailing segment of this run and
  // leave the leading 30 characters in clear when it runs first.
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  assert.equal(redact(`key ${secret}`), "key [redacted-blob]");
});

test("N4: a digit-bearing mixed-case path survives the slash rule", () => {
  const path = "/srv/app2/SomeModule/v3/HandlerFactory9/index.ts";
  assert.equal(redact(path), path);
});

test("N4: a slash secret under a non-keyword JSON key is redacted", () => {
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  assert.equal(redact(`{"blob": "${secret}"}`), '{"blob": "[redacted-blob]"}');
});

test("N4: a slash secret after `=` in a URL query is redacted", () => {
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  assert.equal(
    redact(`https://example.invalid/data?blob=${secret}&x=1`),
    "https://example.invalid/data?blob=[redacted-blob]&x=1",
  );
});

test("N4: a directory path with no extension survives the slash rule", () => {
  const path = "/srv/app2/SomeModule/v3/HandlerFactory9/handlers/";
  assert.equal(redact(path), path);
});

test("N4: a relative path with an extension survives the slash rule", () => {
  const path = "src/app2/SomeModule/v3/HandlerFactory9/index.ts";
  assert.equal(redact(path), path);
});

test("N4: a slash secret before a sentence period is redacted whole", () => {
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Zz9yXwVuTsRq8PoNmLk/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  assert.equal(redact(`the key is ${secret}.`), "the key is [redacted-blob].");
});

test("N4: a slash secret directly after `:` is redacted whole", () => {
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Zz9yXwVuTsRq8PoNmLk/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  assert.equal(redact(`key:${secret}`), "key:[redacted-blob]");
});

test("N3: a slash secret followed by `.` and a letter is redacted whole", () => {
  // The extension guard rejects the whole run, so the slash-free rule redacts
  // only its trailing segment; without a second pass over the leading part it
  // stays in clear.
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Zz9yXwVuTsRq8PoNmLk/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  assert.equal(
    redact(`key ${secret}.sig`),
    "key [redacted-blob][redacted-blob].sig",
  );
  assert.equal(
    redact(`key ${secret}.sig`).includes("Zz9yXwVuTsRq8PoNmLk"),
    false,
  );
});

test("RF4-2: a digit-free slash secret carrying `+` is redacted whole", () => {
  // `+` is the only digit-or-padding evidence in this run; a guard that
  // accepted digits alone as proof of a secret would leave it in clear.
  const secret =
    "AbcdefghijKLMNOPqrstuvwxyz+Abc/ZzyXwVuTsRqPoNmLk/QwertyuiopASDFGHJKLzxcvbnmabcdefghijkl";
  const out = redact(`key ${secret}`);
  assert.equal(out, "key [redacted-blob]");
  assert.equal(out.includes(secret), false, out);
});

test("RF4-2: a slash secret directly after `,` is redacted whole", () => {
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Zz9yXwVuTsRq8PoNmLk/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  const out = redact(`id,${secret}`);
  assert.equal(out, "id,[redacted-blob]");
  assert.equal(out.includes(secret), false, out);
});

test("RF4-2: a slash secret inside parentheses is redacted whole", () => {
  const secret =
    "Ab3defghijKLMNOPqrstuvwxyz0123/Zz9yXwVuTsRq8PoNmLk/Q9wertyuiopASDFGHJKLzxcvbnm0123456789abcd";
  const out = redact(`(${secret})`);
  assert.equal(out, "([redacted-blob])");
  assert.equal(out.includes(secret), false, out);
});

test("a long ordinary file path is not mistaken for a base64 blob", () => {
  const home = os.homedir();
  const path = `${home}/Documents/GitHub/somerepo/src/components/Header/index.ts`;
  const out = redact(`read: ${path}`);
  assert.equal(
    out,
    "read: ~/Documents/GitHub/somerepo/src/components/Header/index.ts",
  );
  assert.equal(out.includes("[redacted-blob]"), false, out);
  // A long lowercase identifier with no digits or padding survives too.
  const identifier = "somerelativelylongcamelcaseidentifierwithoutdigits";
  assert.equal(redact(identifier), identifier);
});

test("shortenPath collapses long paths", () => {
  assert.equal(shortenPath("short/path"), "short/path");
  const long = "/very/long/path/that/keeps/going/and/going/for/a/while/file.go";
  const shortened = shortenPath(long, 30);
  assert.ok(shortened.length <= 32, shortened);
  assert.ok(shortened.endsWith("file.go"), shortened);
});
