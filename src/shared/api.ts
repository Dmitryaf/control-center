import { ref } from 'vue';
import type { Workspace } from '../../shared/contracts';

export const workspace = ref<Workspace | null>(null);
export const busy = ref(false);
export const error = ref('');
export const notice = ref('');
export async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers:
      method === 'GET'
        ? {}
        : {
            'Content-Type': 'application/json',
            'X-Control-Center': '1',
          },
    body: method === 'GET' ? undefined : JSON.stringify(data ?? {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Запрос не выполнен.');
  return result;
}
export async function reload() {
  workspace.value = await api<Workspace>('/workspace');
}
export async function act(action: () => Promise<void>, message = ''): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
    await reload();
    notice.value = message;
    return true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не удалось выполнить действие.';
    return false;
  } finally {
    busy.value = false;
  }
}
