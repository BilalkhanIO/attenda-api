import { defineConfig } from 'prisma/config';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  datasource: {
    // Fallback keeps prisma generate working at Docker build time (no DB needed).
    // At runtime DATABASE_URL is always set by Railway.
    url: process.env.DATABASE_URL ?? 'postgresql://localhost:5432/placeholder',
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
