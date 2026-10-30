import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useBlocker } from 'react-router';
const Drafts = createContext<((id: string, dirty: boolean) => void) | null>(null);
/** One router blocker aggregates independently edited forms. */
export function DraftProvider({ children }: { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, boolean>>({});
  const currentDrafts = useRef<Record<string, boolean>>({});
  const dirty = Object.values(drafts).some(Boolean);
  // Router callbacks can run in the same tick as a completed save. Read the
  // current registration rather than a blocker boolean from the previous render.
  const blocker = useBlocker(() => Object.values(currentDrafts.current).some(Boolean));
  const dialog = useRef<HTMLDialogElement>(null);
  const update = useRef((id: string, value: boolean) => {
    const current = currentDrafts.current;
    if (current[id] === value || (!value && !(id in current))) return current;
    const next = { ...current };
    if (value) next[id] = true;
    else delete next[id];
    currentDrafts.current = next;
    setDrafts(next);
  }).current;
  useEffect(() => {
    if (blocker.state === 'blocked') dialog.current?.showModal();
  }, [blocker.state]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  return (
    <Drafts.Provider value={update}>
      {children}
      {blocker.state === 'blocked' && (
        <dialog
          ref={dialog}
          role="alertdialog"
          aria-labelledby="discard-heading"
          className="panel message warning"
          onCancel={(e) => {
            e.preventDefault();
            blocker.reset();
          }}
        >
          <h2 id="discard-heading">Изменения ещё не сохранены</h2>
          <p>Отбросить изменения и перейти на другую страницу?</p>
          <button autoFocus onClick={() => blocker.reset()}>
            Продолжить редактирование
          </button>
          <button onClick={() => blocker.proceed()}>Отбросить изменения</button>
        </dialog>
      )}
    </Drafts.Provider>
  );
}
export function UnsavedChanges({ dirty }: { dirty: boolean }) {
  const update = useContext(Drafts);
  const id = useId();
  if (!update) throw new Error('DraftProvider required');
  useEffect(() => {
    update(id, dirty);
    return () => update(id, false);
  }, [id, dirty, update]);
  return null;
}
