import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'infra/**/*.test.ts'] } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], testTimeout: 30000 } },
      {
        // Same env policy as every local command: exported env > .env.local > .env.deploy > .env.example.
        test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], setupFiles: ['scripts/load-env.ts'], testTimeout: 60000 },
      },
    ],
  },
});
