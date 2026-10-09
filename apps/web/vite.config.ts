import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { getBuildInfo } from "../../scripts/build-info.mjs";

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  define: {
    __BUILD_INFO__: JSON.stringify(
      getBuildInfo(fileURLToPath(new URL("../..", import.meta.url))),
    ),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  build: {
    target: ["es2022", "chrome111", "firefox128", "safari16.4"],
  },
});
