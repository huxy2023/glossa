import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './apps/api/src/db/schema.ts',
  out: './apps/api/drizzle',
  schemaFilter: [process.env.GLOSSA_DB_SCHEMA || 'glossa'],
  dbCredentials: {
    url:
      process.env.DATABASE_URL ||
      'postgresql://glossa:glossa_local_dev@127.0.0.1:54329/glossa',
  },
});
