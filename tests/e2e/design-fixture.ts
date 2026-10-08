import {
  defaultSettings,
  metadataSchema,
  type Workspace,
  type Project,
} from '../../shared/contracts';
import type { Check } from '../../shared/checks';
import { checkView } from '../../server/checks/signals';

// Synthetic workspace: stressful reading states without any owner's data or paths.
export function designFixture(): Workspace {
  const stamp = { createdAt: '2026-09-10T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z' };
  const projects: Project[] = Array.from({ length: 12 }, (_, index) => ({
    id: `project-${index}`,
    path: `/example/projects/project-${index}`,
    metadata: metadataSchema.parse({
      name:
        index === 0
          ? 'Мастерская независимых проектов — проверка спроса на совместную работу и обмен опытом'
          : `Рабочий проект ${index + 1}`,
      type: index % 2 ? 'tool' : 'product',
      status: 'active',
      priority: index === 0 ? 'high' : 'normal',
      goal: 'Помочь небольшим командам принимать решения на основании реальных наблюдений, сохраняя независимость каждого проекта.',
      current_focus:
        'Проверяем, возвращаются ли участники после первой встречи и готовы ли назначить следующую без напоминания.',
      next: ['Предложить участникам выбрать дату повторной встречи и записать их ответы.'],
      blocked_by: index === 0 ? ['Нет подтверждённого времени повторной встречи.'] : [],
      last_reviewed: '2026-09-15',
    }),
    metadataSource: 'local',
    notes: '',
    available: true,
    signals:
      index === 0
        ? [
            {
              code: 'private-context',
              level: 'attention',
              message:
                'Приватный контекст недоступен. Ранее найденные решения сейчас не прочитаны.',
            },
            {
              code: 'publication',
              level: 'attention',
              message: 'Внутренние файлы отслеживаются Git. Проверьте необходимость публикации.',
            },
            {
              code: 'decision-review',
              level: 'attention',
              message: 'Пора пересмотреть решение D-0001',
            },
          ]
        : [],
    yamlConflict: false,
    decisionSources: [],
    snapshot: {
      path: `/example/projects/project-${index}`,
      directoryName: `project-${index}`,
      scannedAt: '2026-10-05T10:00:00Z',
      git: {
        present: index !== 1,
        branch: index === 1 ? null : 'main',
        dirty: index === 1 ? null : false,
        changedFiles: index === 1 ? null : 0,
        remote: null,
        error: null,
        commits:
          index === 1
            ? []
            : [
                {
                  hash: 'abcdef123456',
                  date: '2026-10-05T08:00:00Z',
                  subject: 'Уточнён основной сценарий и обработка недоступного источника',
                },
              ],
      },
      files: [],
      hasAgents: false,
      mapFile: null,
      package: null,
      errors: [],
      yaml: { exists: false, hash: null, metadata: null, error: null },
    },
    context: {
      visibility: 'public',
      privateContextPath: index === 0 ? '/example/private/unavailable' : null,
      privateStatus: index === 0 ? 'unavailable' : 'disconnected',
      hasPrivateMap: false,
      hadPrivateRecords: index === 0,
      allowlist: [],
      audit: {
        status: 'ok',
        kit: index === 0 ? 'tracked' : 'missing',
        findings:
          index === 0 ? [{ path: '.ai-rules/PROJECT_RULES.md', kind: 'infrastructure' }] : [],
      },
    },
  }));
  const entries: Workspace['checkEntries'] = [
    {
      ...stamp,
      id: 'entry-1',
      checkId: 'check-0',
      kind: 'action',
      occurredAt: '2026-09-17',
      text: 'Пригласили пять участников. Предложили выбрать время следующей встречи самостоятельно.',
      url: '',
      type: null,
      numericValue: null,
    },
    {
      ...stamp,
      id: 'entry-2',
      checkId: 'check-0',
      kind: 'evidence',
      occurredAt: '2026-10-04',
      text: 'Два участника ответили положительно, но конкретная дата ещё не назначена. Это интерес, а не подтверждение повторного использования. Нужно отделить согласие от реального действия.',
      url: 'https://example.com/observation',
      type: 'observation',
      numericValue: 2,
    },
  ];
  const checks = Array.from({ length: 3 }, (_, index) => {
    const check: Check = {
      ...stamp,
      id: `check-${index}`,
      projectId: 'project-0',
      ideaId: null,
      title: [
        'Повторная встреча без напоминаний',
        'Готовность поделиться результатом своей проверки',
        'Понятность первого внешнего шага',
      ][index]!,
      question:
        'Назначат ли участники следующую встречу сами, если после первого знакомства дать им возможность выбрать формат и время?',
      assumption: 'Людям нужен регулярный обмен опытом, а не одно знакомство.',
      expectedExternalResult: 'Две самостоятельно назначенные повторные встречи.',
      continueIf: 'Не менее двух участников предложат конкретную дату и придут повторно.',
      stopIf:
        'После двух попыток никто не назначит встречу; положительные отзывы без действия не считаются результатом.',
      nextExternalAction:
        'Написать двум участникам и предложить выбрать конкретную дату следующей встречи.',
      reviewAt: index === 0 ? '2026-10-04' : null,
      reviewCondition: 'После пяти ответов сопоставить действия с критериями.',
      startedAt: ['2026-09-10', '2026-09-27', '2026-10-04'][index]!,
      status: 'active',
      completedAt: null,
      conclusion: null,
    };
    return checkView(check, entries, defaultSettings, projects[0]!.snapshot, '2026-10-05');
  });
  return {
    refresh: { running: false, lastAttemptAt: null, errors: [] },
    projects,
    checks,
    checkEntries: entries,
    settings: { ...defaultSettings, roots: ['/example/projects'] },
    scan: { scannedAt: '2026-10-05T10:00:00Z', running: false, errors: [] },
    storage: { databasePath: '/example/data/workspace.sqlite' },
    relations: [],
    tasks: [
      {
        ...stamp,
        id: 'task-0',
        number: 1,
        code: 'CC-1',
        revision: 1,
        title: 'Согласовать время и записать реальные ответы участников',
        description: '',
        expectedResult: '',
        acceptance: '',
        links: [],
        result: null,
        projectId: 'project-0',
        state: 'now',
        priority: 'high',
        completedAt: null,
      },
    ],
    ideas: [
      {
        ...stamp,
        id: 'idea-0',
        title: 'Обмен опытом между небольшими независимыми командами',
        description: 'Проверить повторное использование.',
        projectId: 'project-0',
        state: 'testing',
      },
    ],
    decisions: [
      {
        ...stamp,
        id: 'decision-0',
        title:
          'Сохранить ручной формат следующей встречи до подтверждения повторного использования',
        projectId: null,
        context: 'Положительные отзывы не подтверждают регулярную потребность.',
        decision:
          'Не расширять инструмент до наблюдаемого повторного действия участников. Вернуться к решению после следующей проверки.',
        reason: 'Сначала нужно внешнее свидетельство.',
        date: '2026-10-04',
        status: 'pending',
      },
    ],
    fileDecisions: [
      {
        key: 'file-0',
        projectId: 'project-0',
        sourcePath: 'decisions/D-0001.md',
        source: 'repository',
        metadata: {
          schema_version: 1,
          id: 'D-0001',
          title:
            'Условия сохранения ручного процесса и перехода к автоматизации после подтверждённого спроса',
          date: '2026-09-10',
          status: 'accepted',
          area: 'product',
          implementation: 'implemented',
          review_after: '2026-10-04',
          supersedes: [],
          superseded_by: null,
          visibility: 'repository',
        },
        title:
          'Условия сохранения ручного процесса и перехода к автоматизации после подтверждённого спроса',
        body: '',
        hasContent: true,
        error: null,
        signals: [
          { code: 'review', level: 'attention', message: 'Пора пересмотреть решение D-0001' },
        ],
      },
    ],
  };
}
