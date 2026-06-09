/** App base path ('/tango-workout'), so API calls work behind the path-mounted proxy. */
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

async function handle(res: Response) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const error = new Error((body as { error?: string }).error ?? res.statusText);
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }
  return res.json();
}

export const apiGet = <T>(url: string): Promise<T> => fetch(BASE + url).then(handle) as Promise<T>;

const send =
  (method: string) =>
  <T>(url: string, body?: unknown): Promise<T> =>
    fetch(BASE + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(handle) as Promise<T>;

export const apiPost = send('POST');
export const apiPatch = send('PATCH');
export const apiDelete = send('DELETE');
