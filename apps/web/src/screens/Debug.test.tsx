// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Debug } from './Debug.js';

/**
 * The debug page: that it lists what the server recorded, shows one attempt in
 * full, and says so plainly to someone who is not a developer.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'student@example.test',
  kind: 'act',
  portalId: null,
  target: 'action:sign_in',
  outcome: 'failed',
  code: 'signin.rejected',
  message: 'studyo.app did not accept the saved sign-in.',
  startedAt: '2026-10-09T12:00:00.000Z',
  endedAt: '2026-10-09T12:00:09.000Z',
  durationMs: 9000,
  hasScreenshot: true,
};

function serve(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('Debug', () => {
  it('lists attempts with their code, who, and why', async () => {
    serve(200, [row]);
    act(() => root.render(<Debug attemptId={null} />));
    await settle();
    expect(container.textContent).toContain('signin.rejected');
    expect(container.textContent).toContain('student@example.test');
    expect(container.textContent).toContain('did not accept the saved sign-in');
  });

  it('shows one attempt with its steps, error and screenshot', async () => {
    serve(200, {
      ...row,
      steps: [
        { t: 0, name: 'sign_in.step', detail: { step: 0, state: 'password' } },
        { t: 4100, name: 'sign_in.filled' },
      ],
      error: null,
      detail: { pageSaid: 'Wrong password' },
      screenshot: 'data:image/jpeg;base64,AAAA',
      request: {
        kind: 'act',
        outcome: 'failed',
        requestedAt: row.startedAt,
        pickedUpAt: row.startedAt,
        completedAt: row.endedAt,
      },
    });
    act(() => root.render(<Debug attemptId={row.id} />));
    await settle();
    expect(container.textContent).toContain('+4100ms');
    expect(container.textContent).toContain('sign_in.filled');
    expect(container.textContent).toContain('Wrong password');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('tells someone who is not a developer that the page is not for them', async () => {
    serve(404, { error: 'not_found' });
    act(() => root.render(<Debug attemptId={null} />));
    await settle();
    expect(container.textContent).toContain('for developers');
  });
});
