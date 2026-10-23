import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import type { Workspace } from '../../shared/contracts';
import { api } from './http';

export const workspaceKey = ['workspace'] as const;
export function useWorkspace() {
  return useQuery({
    queryKey: workspaceKey,
    queryFn: ({ signal }) => api<Workspace>('/workspace', 'GET', undefined, signal),
    retry: false,
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}
const Actions = createContext<{
  busy: boolean;
  error: string;
  notice: string;
  act: (work: () => Promise<unknown>, message?: string) => Promise<boolean>;
} | null>(null);
export function ActionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const locked = useRef(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mutation = useMutation({
    mutationFn: (work: () => Promise<unknown>) => work(),
    retry: false,
  });
  async function act(work: () => Promise<unknown>, message = '') {
    if (locked.current) return false;
    locked.current = true;
    setWorking(true);
    setError('');
    setNotice('');
    try {
      await mutation.mutateAsync(work);
      await client.invalidateQueries({ queryKey: workspaceKey });
      setNotice(message);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие.');
      return false;
    } finally {
      locked.current = false;
      setWorking(false);
    }
  }
  return (
    <Actions.Provider value={{ busy: working, error, notice, act }}>{children}</Actions.Provider>
  );
}
export function useActions() {
  const context = useContext(Actions);
  if (!context) throw new Error('ActionProvider required');
  return context;
}
