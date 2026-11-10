/**
 * Prisma 7: what the Prisma CLI connects to (migrate deploy, migrate status,
 * migrate diff). schema.prisma no longer carries any connection string.
 *
 * - `url` is DIRECT_URL, the OWNER connection — the role `directUrl` played in
 *   Prisma 6. Migrations must never run through the pooled least-privilege
 *   runtime role (DATABASE_URL), which cannot run DDL anyway.
 * - The application does not read this file: lib/db.ts builds its client with
 *   the Postgres driver adapter on DATABASE_URL (lib/pg-pool-config.ts), and the
 *   operator scripts build theirs from a guarded URL
 *   (scripts/lib/assert-not-production.ts).
 * - `shadowDatabaseUrl` is used only by CI's drift check (`migrate diff
 *   --from-migrations`), which needs an empty scratch database. Never set it in
 *   Vercel.
 *
 * process.env, not Prisma's env(): env() throws when the variable is missing, and
 * `prisma generate` loads this file too — in `npm ci`'s postinstall, in the
 * restore drill and in provision-app-role, none of which has a database URL.
 * An empty URL is refused by any command that connects.
 *
 * The Prisma 7 CLI no longer reads .env by itself, so it is loaded here.
 * `quiet` keeps dotenv 17's banner off stdout, where `migrate diff --script`
 * writes its SQL. dotenv never overrides a variable that is already set: the
 * environment Vercel or CI provides always wins over a checkout's .env.
 */
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DIRECT_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
