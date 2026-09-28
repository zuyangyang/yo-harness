import { describe, expect, it, vi, afterEach } from 'vitest';

import { DaemonApiClient } from '../../src/daemon/daemon-api.js';
import { FatalError } from '../../src/types/errors.js';

function mockFetch(status: number, body: unknown) {
  return vi.fn(() =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      statusText: status === 200 ? 'OK' : 'Error',
    })),
  );
}

describe('DaemonApiClient', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('startTask sends POST with body and parses response', async () => {
    fetchSpy = mockFetch(200, { taskId: 't1', sessionId: 's1' });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock' });
    const result = await client.startTask({ prompt: 'hello', cwd: '/tmp', model: 'claude-3' });

    expect(result).toEqual({ taskId: 't1', sessionId: 's1' });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost/tasks/start');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ prompt: 'hello', cwd: '/tmp', model: 'claude-3' }));
  });

  it('listTasks sends GET with limit query', async () => {
    fetchSpy = mockFetch(200, []);
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock' });
    await client.listTasks(10);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost/tasks?limit=10');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('getTask sends GET with encoded taskId', async () => {
    fetchSpy = mockFetch(200, { id: 'abc', description: 'test' });
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock' });
    await client.getTask('abc');

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toBe('http://localhost/tasks/abc');
  });

  it('cancelTask sends POST to cancel endpoint', async () => {
    fetchSpy = mockFetch(200, '');
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock' });
    await client.cancelTask('abc');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost/tasks/abc/cancel');
    expect(init.method).toBe('POST');
  });

  it('throws FatalError on non-ok response', async () => {
    fetchSpy = mockFetch(500, 'internal error');
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock' });
    await expect(client.listTasks()).rejects.toThrow(FatalError);
  });

  it('throws FatalError on fetch failure (daemon not running)', async () => {
    fetchSpy = vi.fn(() => Promise.reject(new TypeError('connection refused')));
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock' });
    await expect(client.startTask({ prompt: 'x', cwd: '/tmp', model: 'm' })).rejects.toThrow(/daemon connection failed/);
  });

  it('throws FatalError on timeout', async () => {
    fetchSpy = vi.fn(
      () => new Promise((_resolve, reject) => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const client = new DaemonApiClient({ socketPath: '/tmp/test.sock', timeoutMs: 100 });
    await expect(client.listTasks()).rejects.toThrow(/daemon request timeout/);
  });
});
