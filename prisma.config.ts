import { defineConfig } from 'prisma/config';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL!,
  },
  seed: 'src/utils/seed.ts',
});
