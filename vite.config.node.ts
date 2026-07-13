import { defineConfig } from "vite";

// Node-side build: the Vite plugin entry. Externalize node builtins and vite.
export default defineConfig({
  build: {
    lib: { entry: "src/vite/index.ts", formats: ["es"], fileName: () => "vite.js" },
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: { external: [/^node:/, "vite"] },
  },
});
