import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The server's tests; the React app's tests run in web/ with a simulated browser (npm --prefix web test).
    include: ["test/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      // Vitest sets BASE_URL="/" for Vite apps; Ubah expects a full URL.
      BASE_URL: "http://localhost:3000",
      // Tests retrain the models; keep that out of the committed models/ folder.
      MODELS_DIR: join(tmpdir(), "ubah-test-models"),
    },
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
