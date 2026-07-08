module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
    }],
    '^.+\\.js$': ['ts-jest', {
      useESM: true,
    }],
  },
  collectCoverageFrom: ['**/*.(t|j)s'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Empty (rather than a `node_modules/(?!(jose)/)`-style allowlist) is
  // intentional and matches test/jest-int.json: with pnpm's nested
  // node_modules layout, a lookahead anchored at the *first* node_modules/
  // segment (e.g. node_modules/.pnpm/jose@.../node_modules/jose/...) never
  // reaches jose's own directory, so such a pattern silently leaves jose
  // untransformed and its ESM build fails to parse under ts-jest/CJS.
  // test/jest-e2e.json still uses that pattern, but it has zero e2e specs
  // today so the bug there is latent.
  transformIgnorePatterns: [],
};
