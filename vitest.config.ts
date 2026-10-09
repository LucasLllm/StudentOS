import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      '{packages,apps}/*/src/**/*.test.{ts,tsx}',
      'apps/relay/*.test.mjs',
      'apps/desktop/src/**/*.test.mjs',
      'eslint-rules/*.test.mjs',
    ],
    // Integration tests share one Postgres database, so parallel files would
    // race on the same rows. The suite is small; correctness beats speed here.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      /*
       * The web app refuses to load without this, deliberately: a missing API
       * base makes sign-in post to the dev server and fail as a 404 that
       * points nowhere near the cause. But .env is not committed, so a unit
       * test that imports a screen inherited that refusal on any machine
       * without one -- which is every CI runner and every fresh clone. CI has
       * failed on this for weeks while the suite passed for anyone who had
       * a .env sitting there.
       *
       * The suite supplies its own, so it depends on nothing outside the
       * repo. Unroutable on purpose: nothing in a test should dial it, and if
       * something starts to, it fails at once instead of reaching a real API.
       */
      VITE_API_BASE_URL: 'http://127.0.0.1:1',
    },
  },
});
