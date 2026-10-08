import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hybrid.preferedev.xyz",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
