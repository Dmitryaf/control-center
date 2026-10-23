import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type {
  AnalysisStatus,
  AnalysisPreview,
  AnalysisResult,
  AnalysisReport,
} from '../../../shared/analysis';
import type { Task } from '../../../shared/contracts';
import { api } from '../../shared/http';
import { priorityLabels } from '../../shared/labels';
import { useWorkspace, workspaceKey } from '../../shared/workspace';
import { SavedAnalyses } from './RecentAnalyses';
type Draft = AnalysisReport['proposals'][number] & { created: Task | null };
export default function Analysis() {
  const { data: w } = useWorkspace();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const [selection, setSelection] = useState<string[]>(() => {
    const id = params.get('project');
    return id && w!.projects.some((p) => p.id === id) ? [id] : [];
  });
  const [status, setStatus] = useState<AnalysisStatus | null>(null);
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [reviewed, setReviewed] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState('');
  const [clock, setClock] = useState(Date.now());
  const version = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    let mounted = true;
    void api<AnalysisStatus>('/analysis/status')
      .then((v) => {
        if (mounted) setStatus(v);
      })
      .catch((e) => {
        if (mounted) setFailure(e.message);
      });
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => {
      mounted = false;
      version.current++;
      clearInterval(timer);
    };
  }, []);
  async function action(work: (current: () => boolean) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setWorking(true);
    setFailure('');
    const v = ++version.current;
    const current = () => v === version.current;
    try {
      await work(current);
    } catch (cause) {
      if (current()) setFailure((cause as Error).message);
    } finally {
      lock.current = false;
      if (current()) setWorking(false);
    }
  }
  const expired = !!preview && Date.parse(preview.expiresAt) <= clock;
  function choose(id: string, checked: boolean) {
    version.current++;
    setSelection((v) => (checked ? [...v, id] : v.filter((x) => x !== id)));
    setPreview(null);
    setResult(null);
    setDrafts([]);
    setReviewed(false);
  }
  function change(
    index: number,
    field: 'title' | 'description' | 'expectedResult' | 'acceptance' | 'priority',
    value: string,
  ) {
    setDrafts((v) => v.map((d, i) => (i === index ? { ...d, [field]: value } : d)));
  }
  return (
    <div className="analysis-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Смысл проектов и дальнейшее развитие</p>
          <h1>Анализ проектов</h1>
        </div>
        <Link to="/">К обзору →</Link>
      </div>
      <p>
        Здесь доступны сохранённые обзоры и краткий разбор текущих сводок. Для понимания изменений
        за неделю или месяц откройте обзор периода: там можно выбрать историю, наблюдения и итоги
        диалогов.
      </p>
      <p>
        <Link to="/reviews">Обзор недели или месяца →</Link>
      </p>
      <SavedAnalyses projectIds={selection} />
      <h2>Краткий разбор текущего состояния</h2>
      <p className="help">
        Этот запрос использует сводки, открытые задачи и пять последних записей работы каждого
        выбранного проекта. Результат доступен 15 минут; обзор периода сохраняется в истории.
      </p>
      {failure && (
        <div className="message error" role="alert" aria-label="Анализ проектов">
          {failure}
        </div>
      )}
      {working && <p role="status">Выполняем запрос…</p>}
      {status && !status.ready && (
        <div className="message warning">
          <strong>OpenAI не настроен</strong>
          <p>Добавьте API-ключ и модель в окружение сервера. Данные можно просмотреть заранее.</p>
          <details>
            <summary>Как подключить</summary>
            <p>
              Задайте <code>OPENAI_API_KEY</code> и <code>CONTROL_CENTER_OPENAI_MODEL</code> перед
              запуском Control Center, затем перезапустите сервер. Ключ не вводится в браузере и не
              сохраняется в базе.
            </p>
            <button
              disabled={working}
              onClick={() =>
                action(async (current) => {
                  const s = await api<AnalysisStatus>('/analysis/status');
                  if (current()) setStatus(s);
                })
              }
            >
              Проверить настройки
            </button>
          </details>
        </div>
      )}
      <fieldset disabled={working} className="project-selection">
        <legend>Проекты для анализа · до 10</legend>
        {w!.projects.map((p) => (
          <label className="checkbox" key={p.id}>
            <input
              type="checkbox"
              checked={selection.includes(p.id)}
              onChange={(e) => choose(p.id, e.target.checked)}
            />
            <span>
              {p.metadata.name}
              {!p.available && <small> · сохранённый снимок, каталог недоступен</small>}
            </span>
          </label>
        ))}
        {!w!.projects.length && (
          <p className="empty">Добавьте проекты в настройках и выполните сканирование.</p>
        )}
      </fieldset>
      <button
        disabled={working || !selection.length || selection.length > 10}
        onClick={() =>
          action(async (current) => {
            const response = await api<AnalysisPreview>('/analysis/prepare', 'POST', {
              projectIds: selection,
            });
            if (current()) {
              setPreview(response);
              setStatus(response.config);
              setResult(null);
              setDrafts([]);
              setReviewed(false);
            }
          })
        }
      >
        Просмотреть данные
      </button>
      {preview && (
        <section className="section-space analysis-preview" aria-labelledby="preview-heading">
          <h2 id="preview-heading">Данные для отправки</h2>
          <p>
            Подготовлены {new Date(preview.payload.preparedAt).toLocaleString('ru')}. Пакет
            действителен до {new Date(preview.expiresAt).toLocaleString('ru')}.
          </p>
          <p>
            Включены сводки, открытые задачи и по 5 последних записей работы выбранных проектов.
            Файлы, Git, заметки и приватные решения не включены. Сохранённые сведения могут
            устареть; пакет ниже останется неизменным при отправке.
          </p>
          <p className="help">
            Сводки и результаты могут содержать личные сведения. Проверьте весь текст; при
            необходимости исключите проект или исправьте исходную запись. Автоматическая проверка не
            распознаёт все секреты.
          </p>
          <pre tabIndex={0} aria-label="Полный пакет данных">
            {JSON.stringify(preview.payload, null, 2)}
          </pre>
          <p>
            Получатель: OpenAI · модель {preview.config.model || 'не задана'}. Один платный запрос,
            до {preview.config.maxOutputTokens} выходных токенов, ожидание до{' '}
            {preview.config.timeoutSeconds} секунд. Цена зависит от модели и объёма; повтор не
            выполняется автоматически.
          </p>
          <p className="help">
            Ответ не сохраняется как состояние OpenAI (<code>store: false</code>); это не обещание
            отсутствия иных сроков хранения у провайдера. Предложения живут на этом экране и
            исчезнут после его закрытия.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={reviewed}
              disabled={working || !!result}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            <span>Я просмотрел данные и разрешаю отправить этот пакет в OpenAI</span>
          </label>
          <button
            className="primary"
            disabled={working || !reviewed || !preview.config.ready || !!result || expired}
            onClick={() =>
              action(async (current) => {
                const response = await api<AnalysisResult>('/analysis/run', 'POST', {
                  previewId: preview.id,
                  consent: true,
                });
                if (current()) {
                  setResult(response);
                  setDrafts(response.report.proposals.map((d) => ({ ...d, created: null })));
                }
              })
            }
          >
            Отправить в OpenAI
          </button>
          {expired && !result && (
            <p className="help">Срок пакета истёк. Подготовьте данные заново.</p>
          )}
        </section>
      )}
      {result && (
        <section className="section-space analysis-result" aria-labelledby="result-heading">
          <h2 id="result-heading">Предложения</h2>
          <p className="preserve">{result.report.summary}</p>
          <p className="help">
            {result.model} · {new Date(result.generatedAt).toLocaleString('ru')}
            {result.usage
              ? ` · входных токенов ${result.usage.inputTokens}, выходных ${result.usage.outputTokens}`
              : ''}
            . Это предложения модели; фактическая работа и проверки не выполнялись.
          </p>
          {!drafts.length && <p className="empty">Новых задач модель не предложила.</p>}
          {drafts.map((d, index) => (
            <article className="proposal" key={index}>
              <h3>
                {preview?.payload.projects.find((p) => p.id === d.projectId)?.name ??
                  'Неизвестный проект'}
              </h3>
              <p className="preserve">{d.reason}</p>
              <p className="help">Основания:</p>
              <ul>
                {d.sources.map((source) => {
                  const p = preview?.payload.projects.find(
                    (p) =>
                      p.source === source ||
                      p.tasks.some((t) => t.source === source) ||
                      p.recentWork.some((t) => t.source === source),
                  );
                  const t = p?.tasks.find((t) => t.source === source);
                  const h = p?.recentWork.find((t) => t.source === source);
                  return (
                    <li key={source}>
                      {p?.source === source
                        ? `Сводка: ${p.name}`
                        : t
                          ? `${t.code}: ${t.title}`
                          : h
                            ? `${h.taskCode}, запись ${new Date(h.recordedAt).toLocaleString('ru')}`
                            : source}
                    </li>
                  );
                })}
              </ul>
              <fieldset disabled={working || !!d.created} className="form">
                <legend>Предложение {index + 1}</legend>
                <label>
                  Название
                  <input
                    value={d.title}
                    maxLength={240}
                    onChange={(e) => change(index, 'title', e.target.value)}
                  />
                </label>
                {(
                  [
                    ['description', 'Описание'],
                    ['expectedResult', 'Ожидаемый результат'],
                    ['acceptance', 'Условия завершения'],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <textarea
                      rows={2}
                      maxLength={10000}
                      value={d[key]}
                      onChange={(e) => change(index, key, e.target.value)}
                    />
                  </label>
                ))}
                <label>
                  Приоритет
                  <select
                    value={d.priority}
                    onChange={(e) => change(index, 'priority', e.target.value)}
                  >
                    {Object.entries(priorityLabels).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
              </fieldset>
              {d.created ? (
                <Link to={`/tasks?task=${d.created.code}`}>Открыть {d.created.code} →</Link>
              ) : (
                <button
                  disabled={working || !d.title.trim()}
                  onClick={() =>
                    action(async (current) => {
                      const task = await api<Task>('/tasks', 'POST', {
                        projectId: d.projectId,
                        title: d.title,
                        description: d.description,
                        expectedResult: d.expectedResult,
                        acceptance: d.acceptance,
                        priority: d.priority,
                        state: 'next',
                        requestKey: `analysis:${result.previewId}:${index}`,
                      });
                      if (current()) {
                        setDrafts((v) =>
                          v.map((item, i) => (i === index ? { ...item, created: task } : item)),
                        );
                        await client.invalidateQueries({ queryKey: workspaceKey });
                      }
                    })
                  }
                >
                  Создать задачу «Следом»
                </button>
              )}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
