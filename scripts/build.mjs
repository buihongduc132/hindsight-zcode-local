// Zero-dependency esbuild bundler: each entrypoint -> single self-contained .cjs.
// Produces dist/{mcp-server,recall,retain}.cjs — each runnable on system Node
// without node_modules. Type-only source (src/*.ts) is checked separately by tsc.
import * as esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";

const ENTRYPOINTS = [
  { in: "src/mcp-server.ts", out: "mcp-server" },
  { in: "hooks/recall.ts", out: "recall" },
  { in: "hooks/retain.ts", out: "retain" },
];

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: "linked",
  legalComments: "none",
  logLevel: "info",
  minifyWhitespace: true,
  minifySyntax: true,
  // Keep names so stack traces stay readable in MCP stderr logs.
  keepNames: true,
  // Never bundle node built-ins (they stay external).
  packages: "external",
  // zod is tiny and inlined everywhere; bundle it.
  external: [],
};

const banner = {
  js: "#!/usr/bin/env node\n// hindsight-zcode-local — bundled by esbuild. Do not edit; rebuild with `npm run build`.",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const results = await Promise.all(
  ENTRYPOINTS.map(({ in: input, out }) =>
    esbuild.build({
      ...shared,
      banner,
      entryPoints: [input],
      outfile: `dist/${out}.cjs`,
    }),
  ),
);

const failed = results.filter((r) => r.errors.length > 0);
if (failed.length) {
  console.error(`\n❌ build failed: ${failed.length} entrypoint(s) had errors`);
  process.exit(1);
}
console.log(`\n✓ bundled ${ENTRYPOINTS.length} entrypoints -> dist/*.cjs`);
