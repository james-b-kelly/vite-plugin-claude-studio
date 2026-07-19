import { defineConfig } from "vite";

// Node-side build: the Vite plugin entry plus the Designer-mode gate hook
// (spawned as `node dist/gate.js` by designerCliArgs). Externalize node
// builtins and vite.
export default defineConfig({
  build: {
    lib: {
      entry: { vite: "src/vite/index.ts", gate: "src/gate/index.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: { external: [/^node:/, "vite"] },
  },
});
