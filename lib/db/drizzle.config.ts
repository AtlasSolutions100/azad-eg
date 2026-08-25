import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // Relative, forward-slash path: resolved from this config's directory and
  // cross-platform. (An absolute Windows path with backslashes breaks
  // drizzle-kit's internal glob, which treats "\" as an escape character.)
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
