import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cssInjectedByJs from "vite-plugin-css-injected-by-js";

// Browser-side build: the panel entry. React is a peer; CSS (modules) is
// injected by JS at runtime — acceptable because the panel is dev-only.
export default defineConfig({
  plugins: [react(), cssInjectedByJs()],
  build: {
    lib: { entry: "src/panel/index.ts", formats: ["es"], fileName: () => "panel.js" },
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    },
  },
});
