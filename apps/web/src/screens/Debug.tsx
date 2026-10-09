import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';

/**
 * What the desktop app recorded about its browser work, for developers.
 *
 * A list of attempts -- failures first to the eye, newest first in order --
 * and one attempt in full: every step with its time, the error, and the
 * screenshot taken when it failed. The server only answers developers; anyone
 * else gets "not found" here, the same as from any address that is not a page.
 */

interface AttemptRow {
  id: string;
  email: string;
  kind: string;
  portalId: string | null;
  target: string | null;
  outcome: string;
  code: string | null;
  message: string | null;
  startedAt: string;
  durationMs: number;
  hasScreenshot: boolean;
}

interface Step {
  t: number;
  name: string;
  detail?: unknown;
}

interface AttemptDetail extends AttemptRow {
  steps: Step[];
  error: { name?: string; message?: string; stack?: string } | null;
  detail: unknown;
  screenshot: string | null;
  request: {
    kind: string;
    outcome: string | null;
    requestedAt: string;
    pickedUpAt: string | null;
    completedAt: string | null;
  } | null;
}

export function Debug({ attemptId }: { attemptId: string | null }) {
  return attemptId ? <AttemptView id={attemptId} /> : <AttemptList />;
}

function AttemptList() {
  const [rows, setRows] = useState<AttemptRow[] | null>(null);
  const [failedOnly, setFailedOnly] = useState(true);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const query: Record<string, string> = { limit: '200' };
        if (failedOnly) query.failed = '1';
        if (code.trim()) query.code = code.trim();
        const res = await api.debug.attempts.$get({ query });
        if (res.status === 404) throw new Error('This page is for developers.');
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        const body = (await res.json()) as unknown as AttemptRow[];
        if (live) {
          setRows(body);
          setProblem(null);
        }
      } catch (error) {
        if (live) setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      live = false;
    };
  }, [failedOnly, code]);

  return (
    <div className="debug">
      <header className="debug-head">
        <h1>Browser attempts</h1>
        <div className="debug-tools">
          <label>
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(e) => setFailedOnly(e.target.checked)}
            />{' '}
            Failures only
          </label>
          <input
            type="search"
            placeholder="Code, e.g. signin.rejected"
            aria-label="Filter by code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
      </header>

      {problem && <p className="muted">{problem}</p>}
      {rows && rows.length === 0 && <p className="muted">Nothing recorded.</p>}

      {rows && rows.length > 0 && (
        <div className="debug-table" role="table" aria-label="Attempts">
          {rows.map((row) => (
            <button
              key={row.id}
              role="row"
              className={`debug-row ${row.outcome === 'failed' ? 'is-failed' : ''}`}
              onClick={() => navigate({ name: 'debugAttempt', attemptId: row.id })}
            >
              <span className="debug-when">{new Date(row.startedAt).toLocaleString()}</span>
              <span className="debug-code">{row.code ?? 'ok'}</span>
              <span className="debug-what">
                {row.kind} {row.portalId ?? row.target ?? ''}
              </span>
              <span className="debug-who">{row.email}</span>
              <span className="debug-ms">{(row.durationMs / 1000).toFixed(1)}s</span>
              {row.message && <span className="debug-message">{row.message}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function AttemptView({ id }: { id: string }) {
  const [attempt, setAttempt] = useState<AttemptDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.debug.attempts[':id'].$get({ param: { id } });
        if (res.status === 404) throw new Error('No such attempt, or this page is for developers.');
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        setAttempt((await res.json()) as unknown as AttemptDetail);
      } catch (error) {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [id]);

  return (
    <div className="debug">
      <header className="debug-head">
        <button className="link" onClick={() => navigate({ name: 'debug' })}>
          ← All attempts
        </button>
      </header>
      {problem && <p className="muted">{problem}</p>}
      {attempt && (
        <>
          <h1 className={attempt.outcome === 'failed' ? 'debug-failed' : ''}>
            {attempt.code ?? 'ok'}
          </h1>
          {attempt.message && <p>{attempt.message}</p>}
          <dl className="debug-facts">
            <dt>Who</dt>
            <dd>{attempt.email}</dd>
            <dt>What</dt>
            <dd>
              {attempt.kind} {attempt.portalId ?? ''} {attempt.target ?? ''}
            </dd>
            <dt>When</dt>
            <dd>
              {new Date(attempt.startedAt).toLocaleString()}, took{' '}
              {(attempt.durationMs / 1000).toFixed(1)}s
            </dd>
            <dt>Id</dt>
            <dd>
              <code>{attempt.id}</code>
            </dd>
            {attempt.request && (
              <>
                <dt>Request</dt>
                <dd>
                  {attempt.request.kind}: asked {time(attempt.request.requestedAt)}, collected{' '}
                  {time(attempt.request.pickedUpAt)}, reported {time(attempt.request.completedAt)}{' '}
                  as {attempt.request.outcome ?? '—'}
                </dd>
              </>
            )}
          </dl>

          <h2>Steps</h2>
          <ol className="debug-steps">
            {attempt.steps.map((step, i) => (
              <li key={i}>
                <span className="debug-ms">+{step.t}ms</span> <strong>{step.name}</strong>
                {step.detail !== undefined && <code>{JSON.stringify(step.detail)}</code>}
              </li>
            ))}
          </ol>

          {attempt.detail !== null && attempt.detail !== undefined && (
            <>
              <h2>Detail</h2>
              <pre className="debug-pre">{JSON.stringify(attempt.detail, null, 2)}</pre>
            </>
          )}

          {attempt.error && (
            <>
              <h2>Error</h2>
              <pre className="debug-pre">
                {attempt.error.name}: {attempt.error.message}
                {'\n'}
                {attempt.error.stack}
              </pre>
            </>
          )}

          {attempt.screenshot && (
            <>
              <h2>Screenshot at the failure</h2>
              <img
                className="debug-shot"
                src={attempt.screenshot}
                alt="The browser when it failed"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function time(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString() : 'never';
}
