import { Trash2 } from 'lucide-react';
import { api } from '../../shared/http';
import { useActions } from '../../shared/workspace';

export function RemoveProject({
  id,
  name,
  onRemoved,
}: {
  id: string;
  name: string;
  onRemoved?: () => void;
}) {
  const { act, busy } = useActions();
  return (
    <button
      className="remove-project"
      disabled={busy}
      onClick={async () => {
        if (
          !confirm(
            `Удалить «${name}» из Control Center? Каталог и файлы останутся на диске. Записи будут отвязаны, локальная сводка и связи удалены, путь исключён из сканирования.`,
          )
        )
          return;
        if (await act(() => api(`/projects/${id}`, 'DELETE'), 'Проект удалён из Control Center'))
          onRemoved?.();
      }}
    >
      <Trash2 size={15} aria-hidden="true" />
      Удалить из Control Center
    </button>
  );
}
