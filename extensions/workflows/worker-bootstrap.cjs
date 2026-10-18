// Launch in a real detached Node process, using the spawning pi installation's SDK.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { fileURLToPath } = require("node:url");

(async () => {
  const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const host = createRequire(path.join(request.runtimeDir, "package.json"));
  const { createJiti } = host("jiti");
  const resolver = createJiti(path.join(request.runtimeDir, "dist/index.js"));
  const alias = {};
  for (const name of [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/compat",
    "@earendil-works/pi-ai/oauth",
    "@earendil-works/pi-ai/providers/all",
    "@earendil-works/pi-tui",
    "typebox",
    "typebox/compile",
    "typebox/value",
  ]) {
    alias[name] = fileURLToPath(
      resolver.esmResolve(
        name === "@earendil-works/pi-ai"
          ? "@earendil-works/pi-ai/compat"
          : name,
      ),
    );
  }
  const jiti = createJiti(__filename, {
    alias,
    fsCache: false,
    moduleCache: true,
  });
  const { main } = await jiti.import(path.join(__dirname, "worker.ts"));
  await main(request);
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
