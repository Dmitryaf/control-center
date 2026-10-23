import type { PeriodSelection } from '../../../shared/period-analysis';
import type { Project } from '../../../shared/contracts';
const kinds = {
  task: 'Результаты задач',
  check: 'Действия и свидетельства проверок',
  decision: 'Локальные решения',
  observation: 'Наблюдения',
  file_decision: 'Датированные метаданные файловых решений',
} as const;
export const emptySelection = (projectId: string | null): PeriodSelection => ({
  projectIds: projectId ? [projectId] : [],
  includeGeneral: false,
  sourceKinds: [],
  includeMetadata: false,
  includeOpenTasks: false,
  includeUserText: false,
  includeRelatedReviews: false,
  includeRelatedAnalyses: false,
  codexDigestIds: [],
});
export function SourceSelection({
  value,
  onChange,
  projects,
  projectId,
  disabled = false,
}: {
  value: PeriodSelection;
  onChange: (value: PeriodSelection) => void;
  projects: Project[];
  projectId: string | null;
  disabled?: boolean;
}) {
  const flag = (
    key:
      | 'includeMetadata'
      | 'includeOpenTasks'
      | 'includeUserText'
      | 'includeRelatedReviews'
      | 'includeRelatedAnalyses',
    label: string,
  ) => (
    <label className="check" key={key}>
      <input
        type="checkbox"
        checked={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
      />
      {label}
    </label>
  );
  return (
    <fieldset disabled={disabled}>
      <legend>Разрешённые источники</legend>
      {!projectId && (
        <div className="form-grid">
          <div>
            <p>Проекты</p>
            {projects.map((p) => (
              <label className="check" key={p.id}>
                <input
                  type="checkbox"
                  checked={value.projectIds.includes(p.id)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      projectIds: e.target.checked
                        ? [...value.projectIds, p.id]
                        : value.projectIds.filter((id) => id !== p.id),
                    })
                  }
                />
                {p.metadata.name}
              </label>
            ))}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={value.includeGeneral}
              onChange={(e) => onChange({ ...value, includeGeneral: e.target.checked })}
            />
            Общие и отвязанные записи без проекта
          </label>
        </div>
      )}
      {flag('includeMetadata', 'Текущая цель и состояние выбранных проектов')}
      {flag('includeOpenTasks', 'Текущие открытые задачи')}
      {Object.entries(kinds).map(([key, label]) => (
        <label className="check" key={key}>
          <input
            type="checkbox"
            checked={value.sourceKinds.includes(key as PeriodSelection['sourceKinds'][number])}
            onChange={(e) =>
              onChange({
                ...value,
                sourceKinds: e.target.checked
                  ? [...value.sourceKinds, key as PeriodSelection['sourceKinds'][number]]
                  : value.sourceKinds.filter((kind) => kind !== key),
              })
            }
          />
          {label}
        </label>
      ))}
      {flag('includeRelatedAnalyses', 'Последние успешные AI-итоги связанных обзоров')}
      {flag('includeUserText', 'Мой сохранённый текст этого обзора')}
      {flag('includeRelatedReviews', 'Тексты связанных обзоров выбранных проектов и общих записей')}
      <p className="help">
        Пути, Git, заметки проектов, тела файлов и переписки целиком не включаются. Итоги выбранных
        диалогов подключаются отдельно. События передаются выдержками с отметкой сокращения. Выбор
        источника разрешает подготовку пакета; отправка подтверждается отдельно.
      </p>
    </fieldset>
  );
}
