import { ActionMenuItem } from '../../shared/ActionMenu';
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
    <ActionMenuItem
      disabled={busy}
      onSelect={async () => {
        if (
          !confirm(
            `Удалить «${name}» из Control Center? Каталог и файлы останутся на диске. Записи будут отвязаны, локальная сводка и связи удалены. Отдельный путь проекта будет убран из каталогов сканирования, повторное обнаружение исключено.`,
          )
        )
          return;
        if (await act(() => api(`/projects/${id}`, 'DELETE'), 'Проект удалён из Control Center'))
          onRemoved?.();
      }}
    >
      Удалить из Control Center
    </ActionMenuItem>
  );
}
