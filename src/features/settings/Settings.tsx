import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { settingsSchema, type Settings as SettingsData } from '../../../shared/contracts';
import { api } from '../../shared/http';
import { lines } from '../../shared/labels';
import { useWorkspace, useActions } from '../../shared/workspace';
import { UnsavedChanges } from '../../shared/UnsavedChanges';

type Fields = Omit<SettingsData, 'roots' | 'exclusions' | 'excludedProjectPaths'> & {
  roots: string;
  exclusions: string;
  excludedProjectPaths: string;
};
const formValues = (settings: SettingsData): Fields => ({
  ...settings,
  roots: settings.roots.join('\n'),
  exclusions: settings.exclusions.join('\n'),
  excludedProjectPaths: settings.excludedProjectPaths.join('\n'),
});
export default function Settings() {
  const { data: workspace } = useWorkspace();
  const { act, busy } = useActions();
  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { isDirty },
  } = useForm<Fields>({ defaultValues: formValues(workspace!.settings) });
  const [backupPath, setBackupPath] = useState('');
  const [validation, setValidation] = useState('');
  useEffect(() => {
    if (!isDirty) reset(formValues(workspace!.settings));
  }, [workspace, isDirty, reset]);
  async function save(values: Fields) {
    const parsed = settingsSchema.safeParse({
      ...values,
      roots: lines(values.roots),
      exclusions: lines(values.exclusions),
      excludedProjectPaths: lines(values.excludedProjectPaths),
    });
    if (!parsed.success) {
      setValidation(parsed.error.issues.map((i) => i.message).join('; '));
      return;
    }
    setValidation('');
    const ok = await act(
      () => api('/settings', 'PUT', parsed.data),
      'Настройки сохранены. Каталоги проверены.',
    );
    if (ok && JSON.stringify(getValues()) === JSON.stringify(values)) reset(values);
  }
  const numberField = (
    name: keyof Omit<Fields, 'roots' | 'exclusions' | 'excludedProjectPaths'>,
    label: string,
    min = 1,
    max = 3650,
  ) => (
    <label key={name}>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        required
        {...register(name, { valueAsNumber: true })}
      />
    </label>
  );
  return (
    <>
      <UnsavedChanges dirty={isDirty} />
      <div className="page-heading">
        <div>
          <p className="section-label">Локальное пространство</p>
          <h1>Настройки</h1>
          <p className="subtitle">Откуда читать проекты и когда обращать на них внимание.</p>
        </div>
      </div>
      <form className="panel form settings-form" onSubmit={handleSubmit(save)}>
        <h2>Каталоги проектов</h2>
        <label>
          Полные пути, каждый с новой строки
          <textarea rows={4} placeholder={'C:/Personal\nC:/Work'} {...register('roots')} />
        </label>
        <p className="help">
          Поиск останавливается внутри найденного проекта. Вложенный проект можно добавить отдельным
          каталогом. Символические ссылки не обходятся.
        </p>
        <label>
          Исключённые имена каталогов
          <textarea rows={4} {...register('exclusions')} />
        </label>
        <details>
          <summary>Проекты, удалённые из Control Center</summary>
          <label className="section-space">
            Исключённые пути проектов, каждый с новой строки
            <textarea rows={3} {...register('excludedProjectPaths')} />
          </label>
          <p className="help">
            Чтобы вернуть проект, удалите его путь из списка. Проект будет найден заново; удалённые
            заметки, сводка и связи не восстанавливаются.
          </p>
        </details>
        <h2>Обновление состояния проектов</h2>
        {numberField('autoRefreshMinutes', 'Интервал обновления, минут', 0, 60)}
        <p className="help">
          0 отключает автоматическое обновление. Пока запущен локальный сервер, он перечитывает Git,
          сводки и решения известных проектов. Новые каталоги находятся при сканировании. Файлы,
          задачи и ваши правки сводок не меняются.
        </p>
        <div className="form-grid">
          {numberField('inactivityDays', 'Нет новых commits, дней')}
          {numberField('reviewDays', 'Пересмотр метаданных, дней')}
        </div>
        <h2>Время без внешнего движения</h2>
        <p className="help">
          Только для активных проверок. Интервалы должны возрастать. Git не сбрасывает эти сроки.
        </p>
        <div className="form-grid">
          {numberField('movementInfoDays', 'Информация, дней')}
          {numberField('movementAttentionDays', 'Внимание, дней')}
          {numberField('movementDecisionDays', 'Нужно решение, дней')}
        </div>
        {validation && <p role="alert">{validation}</p>}
        <div>
          <button className="primary" disabled={busy}>
            {busy ? 'Сканирование…' : 'Сохранить и сканировать'}
          </button>
        </div>
      </form>
      <section className="panel section-space prose">
        <h2>Как хранятся данные</h2>
        <p className="source-path">База: {workspace!.storage.databasePath}</p>
        <button
          disabled={busy}
          onClick={() =>
            act(async () => {
              setBackupPath((await api<{ path: string }>('/backup', 'POST')).path);
            }, 'Резервная копия создана и проверена')
          }
        >
          Создать резервную копию
        </button>
        {backupPath && <p className="source-path">Копия: {backupPath}</p>}
        <p className="help">
          Для восстановления остановите приложение, сохраните текущую базу вместе с -wal/-shm
          отдельно и поместите копию под именем control-center.sqlite в указанный каталог.
          Подробности — в README.
        </p>
        <p>
          Задачи, идеи, решения, связи, настройки и ваши правки сводок хранятся в локальной SQLite.
          Сканирование читает репозитории без изменения файлов.
        </p>
        <p>
          Файл PROJECT.yaml меняется только по кнопке экспорта на странице проекта. Сохранённые в
          Control Center правки имеют приоритет над YAML.
        </p>
      </section>
    </>
  );
}
