import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // Mirrors the rollup string plugin: markup is imported as a plain string
    {
      name: 'html-as-string',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('.html')) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
