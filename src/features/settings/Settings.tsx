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
    name: keyof Omit<Fields, 'roots' | 'exclusions' | 'excludedProjectPaths' | 'timezone'>,
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
          <h1>Настройки</h1>
        </div>
      </div>
      <form className="panel form settings-form" onSubmit={handleSubmit(save)}>
        <h2>Каталоги проектов</h2>
        {workspace!.scan.scannedAt && (
          <small>
            Последнее сканирование ·{' '}
            <time dateTime={workspace!.scan.scannedAt}>
              {new Date(workspace!.scan.scannedAt).toLocaleString('ru')}
            </time>
          </small>
        )}
        <label>
          Полные пути, каждый с новой строки
          <textarea rows={4} placeholder={'C:/Personal\nC:/Work'} {...register('roots')} />
        </label>
        <p className="help">Вложенный проект можно добавить отдельным путём.</p>
        <details>
          <summary>Исключения при поиске</summary>
          <label>
            Исключённые имена каталогов
            <textarea rows={4} {...register('exclusions')} />
          </label>
        </details>
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
        <label>
          Часовой пояс истории и обзоров
          <input required {...register('timezone')} placeholder="Asia/Yekaterinburg" />
        </label>
        <p className="help">
          Например, Asia/Yekaterinburg. Смена пояса применяется к новым обзорам.
        </p>
        {numberField('autoRefreshMinutes', 'Интервал обновления, минут', 0, 60)}
        <p className="help">
          Укажите 0, чтобы отключить обновления. Новые каталоги добавляются при сканировании.
        </p>
        <details>
          <summary>Когда напоминать о проектах и проверках</summary>
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
        </details>
        {validation && <p role="alert">{validation}</p>}
        <div>
          <button className="primary" disabled={busy}>
            {busy ? 'Сканирование…' : 'Сохранить и сканировать'}
          </button>
        </div>
      </form>
      <section className="panel section-space prose">
        <h2>Резервная копия</h2>
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
        <details>
          <summary>Расположение базы и восстановление</summary>
          <p className="source-path">{workspace!.storage.databasePath}</p>
          <p>
            Остановите приложение и сохраните текущую базу вместе с файлами -wal и -shm отдельно.
            Поместите копию под именем control-center.sqlite в каталог базы.
          </p>
        </details>
      </section>
    </>
  );
}
