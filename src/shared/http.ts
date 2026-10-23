/** Same loopback HTTP contract for both clients. Never retries a write. */
export async function api<T>(
  path: string,
  method = 'GET',
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    signal,
    headers:
      method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Control-Center': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Запрос не выполнен.');
  return result;
}
