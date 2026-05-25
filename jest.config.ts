import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testTimeout: 30_000,
  clearMocks: true,
  testPathIgnorePatterns: ['/node_modules/', '/__mocks__/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/__tests__/**',
    '!src/utils/seed.ts',
    '!src/server.ts',
  ],
  coverageThreshold: {
    global: { branches: 60, functions: 70, lines: 70, statements: 70 },
  },
  moduleNameMapper: {
    '^@/(.*)$':  '<rootDir>/src/$1',
    '^uuid$':    '<rootDir>/src/__tests__/__mocks__/uuid.ts',
  },
};

export default config;
