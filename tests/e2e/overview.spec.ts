import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { designFixture } from './design-fixture';
import { fixture } from '../fixtures';
import type { Task, TaskHistoryPage, Workspace } from '../../shared/contracts';

test('real project signals keep current tasks free of legacy warnings and prioritize pending decisions', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const headers = { 'X-Control-Center': '1' };
  try {
    const repo = await f.repo('attention-regression');
    await writeFile(path.join(repo, 'PROJECT.yaml'), 'name: Signal project\nstatus: active\n');
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: { ...initial.settings, roots: [repo], autoRefreshMinutes: 0 },
        })
      ).ok(),
    ).toBe(true);
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const project = workspace.projects.find((item) => item.path === repo)!;
    for (const state of ['now', 'next']) {
      expect(
        (
          await request.post('/api/tasks', {
            headers,
            data: { title: `Signal task ${state}`, projectId: project.id, state },
          })
        ).ok(),
      ).toBe(true);
    }
    expect(
      (
        await request.post('/api/decisions', {
          headers,
          data: {
            title: 'Direction choice',
            projectId: project.id,
            decision: 'Choose direction',
            date: '2026-10-23',
            status: 'pending',
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    const attention = page
      .locator('.attention-line')
      .filter({ has: page.locator(`a[href="/projects/${project.id}"]`) });
    await expect(attention).toHaveClass(/decision/);
    await expect(attention).toContainText('Ожидают решения: 1');
    await expect(page.getByText('Не определён текущий фокус', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Не определён следующий шаг', { exact: true })).toHaveCount(0);
    await expect(page.locator('.current-work')).toContainText('Signal task now');
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});

test('overview shows project context and exact current tasks once, keeps attention and secondary details available on wide/narrow screens', async ({
  page,
}) => {
  const data = designFixture();
  const base = data.tasks[0];
  data.tasks.push({
    ...base,
    id: 'low',
    code: 'CC-22',
    number: 22,
    title: 'Низкий приоритет',
    projectId: null,
    priority: 'low',
  });
  data.tasks.push({
    ...base,
    id: 'next',
    code: 'CC-23',
    number: 23,
    title: 'Потом, не сейчас',
    state: 'next',
  });
  data.tasks.push({
    ...base,
    id: 'done',
    code: 'CC-24',
    number: 24,
    title: 'Уже завершено',
    completedAt: base.updatedAt,
  });
  data.projects[1].metadata.status = 'paused';
  data.projects[2].metadata.stage = 'Поддержка';
  data.projects[3].metadata.stage = 'Ожидание ответа';
  data.projects[4].available = false;
  const recent: TaskHistoryPage = {
    total: 1,
    items: [
      {
        id: 1,
        kind: 'completed',
        recordedAt: base.updatedAt,
        projectId: base.projectId,
        projectName: data.projects[0].metadata.name,
        task: {
          ...base,
          result: {
            summary:
              'Сохранённый результат с длинным описанием проверки основного сценария и доступности на узком экране',
            verified: 'Локальная проверка',
            unverified: '',
            remaining: '',
          },
        },
        taskExists: true,
      },
    ],
  };
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await page.route('**/api/task-history?**', (route) => {
    const project = new URL(route.request().url()).searchParams.get('projectId');
    const items = project
      ? recent.items.filter((entry) => entry.projectId === project)
      : recent.items;
    return route.fulfill({ json: { total: items.length, items } });
  });
  await mkdir('.local/overview-review', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.current-task-list li')).toHaveCount(2);
    await expect(page.locator('.current-task-list li').first()).toContainText(base.code);
    await expect(page.locator('.current-task-list li').last()).toContainText('Общая задача');
    await expect(page.locator('.current-work .project-row')).toHaveCount(12);
    await expect(
      page.locator('.current-work .project-row').filter({ hasText: 'Поддержка' }),
    ).toBeVisible();
    await expect(
      page.locator('.current-work .project-row').filter({ hasText: 'Ожидание ответа' }),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: data.projects[1].metadata.name, exact: true }),
    ).toContainText('Отложен');
    await expect(
      page.getByRole('article', { name: data.projects[0].metadata.name, exact: true }),
    ).toContainText(data.projects[0].metadata.goal);
    await expect(
      page.getByRole('article', { name: data.projects[2].metadata.name, exact: true }),
    ).toContainText('Записей работы пока нет');
    await expect(
      page.getByRole('article', { name: data.projects[0].metadata.name, exact: true }),
    ).toContainText('Сохранённый результат');
    await expect(
      page.locator('.current-work').getByRole('link', { name: `${base.code} · ${base.title}` }),
    ).toHaveAttribute('href', `/tasks?task=${base.code}`);
    await expect(page.locator('.overview-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('.checks-overview')).toBeHidden();
    await expect(page.locator('.attention-line').first()).toHaveClass(/decision/);
    await expect(page.locator('#attention')).toContainText(data.decisions[0].title);
    await expect(
      page.getByRole('article', { name: data.projects[4].metadata.name, exact: true }),
    ).toContainText('Каталог недоступен · сохранённый снимок');
    const tasks = (await page.locator('.current-work').boundingBox())!;
    const attention = (await page.locator('#attention').boundingBox())!;
    const history = (await page.locator('.recent-work').boundingBox())!;
    expect(tasks.y).toBeLessThan(attention.y);
    expect(attention.y).toBeLessThan(history.y);
    await expect(page.locator('.recent-work')).toContainText('Сохранённый результат');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `.local/overview-review/overview-${width}.png`, fullPage: true });
    const summary = page.locator('.overview-details > summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.checks-overview')).toBeVisible();
    await expect(page.locator('.movement-clock').first()).toContainText('18');
    await expect(page.locator('.project-register')).toBeVisible();
    await expect(page.locator('.git-overview .activity-list')).toBeHidden();
    await page.locator('.git-overview > summary').click();
    await expect(page.locator('.git-overview .activity-list')).toBeVisible();
    await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page
    .locator('.current-work')
    .getByRole('link', { name: `${base.code} · ${base.title}` })
    .click();
  await expect(page.getByLabel('Название задачи')).toHaveValue(base.title);
});

test('project card reads persisted history and keeps it visible after a failed refresh', async ({
  page,
}) => {
  const data = designFixture();
  data.projects = data.projects.slice(0, 2);
  let fail = false;
  const entry = {
    id: 8,
    kind: 'completed',
    recordedAt: '2026-10-20T08:00:00Z',
    projectId: data.projects[0].id,
    projectName: data.projects[0].metadata.name,
    task: {
      ...data.tasks[0],
      result: { summary: 'Сохранённый итог проекта', verified: '', unverified: '', remaining: '' },
    },
    taskExists: false,
  };
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await page.route('**/api/task-history?**', (route) => {
    const project = new URL(route.request().url()).searchParams.get('projectId');
    if (project === data.projects[0].id && fail)
      return route.fulfill({ status: 503, json: { error: 'History unavailable' } });
    const items = project === data.projects[0].id ? [entry] : [];
    return route.fulfill({ json: { total: items.length, items } });
  });
  await page.goto('/');
  const card = page.getByRole('article', { name: data.projects[0].metadata.name, exact: true });
  await expect(card).toContainText('Сохранённый итог проекта');
  await expect(card.locator('.project-latest time')).toHaveAttribute('datetime', entry.recordedAt);
  await expect(
    page.getByRole('article', { name: data.projects[1].metadata.name, exact: true }),
  ).toContainText('Записей работы пока нет');
  fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(card.getByRole('alert')).toContainText('Не удалось обновить запись');
  await expect(card).toContainText('Сохранённый итог проекта');
  fail = false;
  await card.getByRole('button', { name: 'Повторить' }).click();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await card.getByRole('link', { name: `Задача завершена · ${entry.task.code}` }).click();
  await expect(page.getByLabel('Номер задачи')).toHaveValue(entry.task.code);
});

test('overview period uses inclusive UTC dates and carries them into history', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-23T03:00:00Z') });
  const data = designFixture();
  data.projects = data.projects.slice(0, 1);
  const entries = ['2026-10-17T00:00:00Z', '2026-10-16T23:59:59Z'].map((recordedAt, index) => ({
    id: index + 1,
    kind: 'result',
    recordedAt,
    projectId: null,
    projectName: null,
    task: {
      ...data.tasks[0],
      result: {
        summary: index ? 'До периода' : 'На границе периода',
        verified: '',
        unverified: '',
        remaining: '',
      },
    },
    taskExists: true,
  }));
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  await page.route('**/api/task-history?**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const items = params.has('projectId')
      ? []
      : entries.filter(
          (entry) => !params.get('from') || entry.recordedAt.slice(0, 10) >= params.get('from')!,
        );
    return route.fulfill({ json: { total: items.length, items } });
  });
  await page.goto('/');
  await expect(page.locator('.recent-work')).toContainText('До периода');
  await page.getByLabel('Период записей').selectOption('7');
  await expect(page.locator('.recent-work')).toContainText('2026-10-17 — 2026-10-23');
  await expect(page.locator('.recent-work')).toContainText('На границе периода');
  await expect(page.locator('.recent-work')).not.toContainText('До периода');
  await expect(page.locator('.recent-work')).toContainText('Показано 1 из 1');
  const historyRead = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/history',
  );
  await page.locator('.recent-work').getByRole('link', { name: 'Вся история →' }).click();
  await expect(page.getByLabel('С даты', { exact: true })).toHaveValue('2026-10-17');
  await expect(page.getByLabel('По дату', { exact: true })).toHaveValue('2026-10-23');
  expect(new URL((await historyRead).url()).searchParams.get('timezone')).toBe('UTC');
  await expect(page.getByText('Часовой пояс: UTC.', { exact: false })).toBeVisible();
});

test('recent work preserves newer reads, exposes a current failure and retries without clearing known results', async ({
  page,
}) => {
  const data = designFixture();
  const entry = {
    id: 1,
    kind: 'baseline',
    recordedAt: data.tasks[0].updatedAt,
    projectId: null,
    projectName: null,
    task: {
      ...data.tasks[0],
      result: { summary: 'Актуальный результат', verified: '', unverified: '', remaining: '' },
    },
    taskExists: true,
  };
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let fail = false;
  await page.route('**/api/task-history?**', async (route) => {
    if (new URL(route.request().url()).searchParams.has('projectId')) {
      await route.fulfill({ json: { total: 0, items: [] } });
      return;
    }
    calls++;
    if (calls === 1) {
      await waiting;
      await route.fulfill({ status: 503, json: { error: 'Старая ошибка' } });
    } else if (fail)
      await route.fulfill({ status: 503, json: { error: 'Сведения временно недоступны' } });
    else await route.fulfill({ json: { total: 1, items: [entry] } });
  });
  await page.goto('/');
  await expect(page.getByText('Загружаем результаты…')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.recent-work')).toContainText('Актуальный результат');
  release();
  await expect(page.getByRole('alert', { name: 'Последние результаты', exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator('.recent-work')).toContainText('более ранняя история недоступна');
  fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('alert', { name: 'Последние результаты', exact: true }),
  ).toContainText('Сведения временно недоступны');
  await expect(page.locator('.recent-work')).toContainText('Актуальный результат');
  fail = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Последние результаты', exact: true })).toHaveCount(
    0,
  );
});

test('legacy plans remain readable and importable, editing/export preserve original fields and unknown YAML instead of task titles', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const repo = await f.repo('overview-transition');
  const yaml = path.join(repo, 'PROJECT.yaml');
  await writeFile(
    yaml,
    'name: План проекта\ncurrent_focus: Прежний фокус\nnext:\n  - Прежний шаг\ncustom_field: Keep unknown\n',
  );
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  await request.put('/api/settings', {
    headers,
    data: { ...initial.settings, roots: [repo], autoRefreshMinutes: 0 },
  });
  const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
  const project = workspace.projects.find((item) => item.path === repo)!;
  try {
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Изменить сводку', exact: true }).click();
    // An existing API client changes the legacy plan while this UI draft is open.
    const legacyUpdate = await request.put(`/api/projects/${project.id}`, {
      headers,
      data: {
        metadata: {
          ...project.metadata,
          current_focus: 'Прежний фокус из другого клиента',
          next: ['Прежний шаг из другого клиента'],
        },
        notes: '',
      },
    });
    expect(legacyUpdate.status()).toBe(200);
    await expect(page.getByLabel('Текущий фокус')).toHaveCount(0);
    await expect(page.getByLabel('Следующие шаги')).toHaveCount(0);
    await page.getByLabel('Зачем существует', { exact: true }).fill('Обновлённая цель');
    await page.getByRole('button', { name: 'Сохранить сводку', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Сводка сохранена');
    await page.locator('.legacy-plan > summary').click();
    await expect(page.locator('.legacy-plan')).toContainText('Прежний фокус');
    await expect(page.locator('.legacy-plan')).toContainText('Прежний фокус из другого клиента');
    await expect(page.locator('.legacy-plan')).toContainText('Прежний шаг');
    await expect(page.locator('.legacy-plan')).toContainText('Прежний шаг из другого клиента');
    await page.getByRole('button', { name: 'Добавить шаги на доску', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Прежняя сводка сохранена');
    await page.getByRole('button', { name: 'Добавить шаги на доску', exact: true }).click();
    const imported = (await (await request.get('/api/workspace')).json()) as Workspace;
    const tasks = imported.tasks.filter((item) => item.projectId === project.id);
    expect(tasks).toHaveLength(1);
    const changed = await request.put(`/api/tasks/${tasks[0].id}`, {
      headers,
      data: { ...tasks[0], title: 'Новая текущая задача', state: 'now' },
    });
    expect(changed.status()).toBe(200);
    const task = (await changed.json()) as Task;
    await page.getByRole('button', { name: 'Обновить PROJECT.yaml', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('PROJECT.yaml записан');
    const content = await readFile(yaml, 'utf8');
    expect(content).toContain('Прежний фокус');
    expect(content).toContain('Прежний фокус из другого клиента');
    expect(content).toContain('Прежний шаг');
    expect(content).toContain('Прежний шаг из другого клиента');
    expect(content).toContain('Keep unknown');
    expect(content).toContain('Обновлённая цель');
    expect(content).not.toContain('Новая текущая задача');
    await page.goto('/');
    const link = page
      .locator('.current-work')
      .getByRole('link', { name: `${task.code} · Новая текущая задача` });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByLabel('Название задачи')).toHaveValue('Новая текущая задача');
    await request.post(`/api/tasks/${task.id}/complete`, {
      headers,
      data: {
        revision: task.revision,
        result: { summary: 'Завершено через реальный HTTP', verified: 'Сохранён прежний YAML' },
      },
    });
    await page.goto('/');
    await expect(page.locator('.current-work')).not.toContainText('Новая текущая задача');
    await expect(page.locator('.recent-work')).toContainText('Завершено через реальный HTTP');
    await page
      .locator('.recent-work')
      .getByRole('link', { name: `${task.code} · Новая текущая задача` })
      .click();
    await expect(page.locator('.history-entry')).toContainText('Завершено через реальный HTTP');
  } finally {
    await request.put('/api/settings', {
      headers,
      data: { ...workspace.settings, roots: [], autoRefreshMinutes: 0 },
    });
    await f.cleanup();
  }
});
