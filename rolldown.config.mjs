import { defineConfig } from "rolldown";

export default defineConfig([
  // ESM build (modern browsers)
  {
    input: "src/gzip-sync.ts",
    output: {
      file: "dist/gzip-sync.mjs",
      format: "esm",
      banner:
        "/* fflate-gzip-sync v0.1.0 - GZIP sync compression only (ESM) */",
    },
    external: [],
    treeshake: true,
    transform: {
      target: "es5",
    },
  },
  // CJS build (Node.js)
  {
    input: "src/gzip-sync.ts",
    output: {
      file: "dist/gzip-sync.cjs",
      format: "cjs",
      banner:
        "/* fflate-gzip-sync v0.1.0 - GZIP sync compression only (CJS) */",
    },
    external: [],
    treeshake: true,
    transform: {
      target: "es5",
    },
  },
  // UMD build (modern browsers)
  {
    input: "src/gzip-sync.ts",
    output: {
      file: "dist/gzip-sync.umd.js",
      format: "umd",
      name: "fflateGzip",
      banner:
        "/* fflate-gzip-sync v0.1.0 - GZIP sync compression only (UMD) */",
    },
    external: [],
    treeshake: true,
    transform: {
      target: "es5",
    },
  },
]);
