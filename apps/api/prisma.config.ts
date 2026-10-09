import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Migrations need a session connection: Supabase's session pooler (port 5432) in DIRECT_DATABASE_URL when the
  // app itself uses the transaction pooler (port 6543, best for Vercel functions).
  datasource: {
    url: process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"],
  },
});
