import path from "node:path";
import { z } from "zod";

// Load .env if present (built into Node 20.12+, so no dotenv package needed).
try {
  process.loadEnvFile();
} catch {
  // No .env file - fine, we fall back to real environment variables / defaults.
}

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Optional so the server and tests run without it; the agent reports a clear error if it is missing.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default("gemini-3.1-flash-lite"),
  DATA_FILE: z.string().min(1).default("data/runtime.json"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n  ${problems.join("\n  ")}`);
}
const env = parsed.data;

export const config = {
  port: env.PORT,
  geminiApiKey: env.GEMINI_API_KEY || undefined,
  geminiModel: env.GEMINI_MODEL,
  dataFile: path.resolve(process.cwd(), env.DATA_FILE),
  seedFile: path.resolve(process.cwd(), "data/seed.json"),
};
