import { defineConfig } from 'prisma/config';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  "prisma": {
  "seed": "node -r ts-node/register prisma/seed.ts || ts-node prisma/seed.ts"
  }
  
});
