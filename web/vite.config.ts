import { defineConfig } from "vite";
export default defineConfig({
  base: "/play/",
  server: { proxy: { "/api": { target: "http://127.0.0.1:4317", ws: true } } },
});
