import { defineConfig } from "vite";
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/api/index/" : "/",
  server: { proxy: { "/api": "http://localhost:7071" } },
}));
