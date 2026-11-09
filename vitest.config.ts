import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'infra/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 30000 } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 60000 } },
    ],
  },
});
