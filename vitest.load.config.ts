import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// The timed load tests, on their own (npm test runs them after the other server tests).
export default defineConfig({ test: { ...base.test, include: ["test/load.test.ts"], exclude: ["**/node_modules/**"] } });
