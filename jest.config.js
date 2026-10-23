/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // The shipped example suites import mcp-core by its package name, exactly as a consumer does;
    // inside this repo those subpaths resolve to the source.
    '^@novorb/mcp-core/testing$': '<rootDir>/src/testing/index.ts',
    '^@novorb/mcp-core/logger$': '<rootDir>/src/utils/logger.ts',
    '^@novorb/mcp-core/sdk/(server|client)/stdio$': '<rootDir>/src/sdk/$1-stdio.ts',
    '^@novorb/mcp-core/sdk/(server|client|node|express)$': '<rootDir>/src/sdk/$1.ts',
    '^@novorb/mcp-core/(server|transport|retry|pagination|http-client|tools|bootstrap|express|auth)$':
      '<rootDir>/src/$1.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    // Transpile-only ESM: `isolatedModules: true` lives in tsconfig.json (the modern location ts-jest
    // reads); `tsc --noEmit` (the 00 typecheck gate) is the type authority.
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  // The example suites run against the echo fixture so they cannot rot.
  testMatch: ['**/tests/**/*.test.ts', '**/examples/testing/*.example.ts'],
  setupFiles: ['<rootDir>/tests/setup-env.ts'],
  // Instrument every source module (not just the imported ones) so an untested file counts
  // against coverage. `index.ts` files are pure re-exports (no logic) and are excluded.
  // `src/sdk/*` are pure `export *` re-exports of the SDK packages.
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/testing/index.ts', '!src/sdk/**'],
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 85,
      functions: 85,
      lines: 85,
    },
  },
};
