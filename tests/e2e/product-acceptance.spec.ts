import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import { connectMcp } from '../mcp-client';
import { periodBounds } from '../../shared/periods';
import type { Workspace } from '../../shared/contracts';
import type { Review } from '../../shared/reviews';
import type { PeriodRun } from '../../shared/period-analysis';

test('owner journey across active, paused, waiting and completed projects: browser → production MCP → week → retained review → portfolio month → offline work', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
  const today = new Date().toISOString().slice(0, 10);
  const bounds = periodBounds('week', today, 'UTC');
  const taskTitle = 'Синтетическая проверка экспорта';
  const note = 'Тестовый файл открыт вручную; вложения ещё не проверены.';
  const weekText = 'Сохранён результат тестового экспорта. Перед выводами проверить вложения.';
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const inputs = [
      { folder: 'active', name: 'Тестовый экспорт', status: 'active', stage: 'Разработка' },
      {
        folder: 'paused',
        name: 'Тестовый архив',
        status: 'paused',
        stage: 'Пауза по решению владельца',
      },
      {
        folder: 'waiting',
        name: 'Тестовый справочник',
        status: 'active',
        stage: 'Ожидание ответа',
      },
      {
        folder: 'completed',
        name: 'Тестовый завершённый проект',
        status: 'completed',
        stage: 'Цель достигнута',
      },
    ];
    const roots: string[] = [];
    for (const input of inputs) {
      const repo = await f.repo(input.folder);
      await writeFile(
        path.join(repo, 'PROJECT.yaml'),
        `name: ${input.name}\nstatus: ${input.status}\nstage: ${input.stage}\ngoal: Проверить основной сценарий на тестовых данных\n`,
      );
      roots.push(repo);
    }
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: {
            ...initial.settings,
            roots,
            timezone: 'UTC',
            autoRefreshMinutes: 0,
          },
        })
      ).ok(),
    ).toBe(true);
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const project = workspace.projects.find((p) => p.path === roots[0])!;
    const file = path.resolve(workspace.storage.databasePath);
    expect(file.startsWith(path.resolve('.local/e2e-data-'))).toBe(true);
    mcp = await connectMcp(path.dirname(file), f.root, true);

    await test.step('1–2: visible project states and current work', async () => {
      await page.goto('/');
      for (const input of inputs) {
        const row = page.locator('.project-summary').filter({ hasText: input.name });
        await expect(row).toContainText(input.stage);
      }
      const row = page.locator('.project-summary').filter({ hasText: inputs[0].name });
      await row.getByRole('link', { name: inputs[0].name, exact: true }).click();
      await expect(page.getByRole('heading', { name: inputs[0].name, exact: true })).toBeVisible();
      await page.goto(`/tasks?project=${project.id}`);
      await expect(page.getByRole('combobox', { name: 'Проект', exact: true })).toHaveValue(
        project.id,
      );
    });
    await test.step('3–4: UI task → actual compiled MCP → immutable saved result', async () => {
      await page.getByLabel('Название задачи').fill(taskTitle);
      await page.getByRole('combobox', { name: 'Когда', exact: true }).selectOption('now');
      await page.getByLabel('Название задачи').press('Enter');
      await expect(page.getByRole('status')).toContainText('Задача сохранена');
      const listed = await mcp!.call('task_list', { projectId: project.id, query: taskTitle });
      expect(listed.isError).toBe(false);
      expect(listed.value.items).toHaveLength(1);
      const task = listed.value.items[0];
      // This is a synthetic MCP receipt, not evidence of a real Codex coding session.
      const completed = await mcp!.call('task_complete', {
        identifier: task.code,
        revision: task.revision,
        result: {
          summary: 'Сохранён тестовый экспорт',
          verified: 'Проверен один тестовый файл',
          unverified: 'Вложения и рабочие данные',
        },
      });
      expect(completed.isError).toBe(false);
      await page.reload();
      await page.getByLabel('Завершённые', { exact: true }).check();
      const card = page.locator('.task-card').filter({ hasText: taskTitle });
      await card.locator('summary').click();
      await expect(card).toContainText('Сохранён тестовый экспорт');
      await expect(card).toContainText('Вложения и рабочие данные');
    });
    await test.step('5–7: own observation → scoped week history → manual review', async () => {
      await page.goto(`/observations?project=${project.id}`);
      await page.getByLabel('Дата наблюдения').fill(today);
      await page.getByLabel('Текст наблюдения').fill(note);
      await page.getByRole('button', { name: 'Сохранить наблюдение', exact: true }).click();
      await expect(page.getByLabel('Текст наблюдения')).toHaveValue('');
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole('region', { name: 'Последние записи проекта' })).toContainText(
        note,
      );
      await expect(page.getByRole('region', { name: 'Последние записи проекта' })).toContainText(
        'Сохранён тестовый экспорт',
      );
      await expect(page.getByRole('link', { name: 'Обзор месяца →', exact: true })).toBeVisible();
      await page.goto(
        `/timeline?project=${project.id}&from=${bounds.periodStart}&to=${bounds.periodEnd}&timezone=UTC`,
      );
      await expect(page.locator('.history-record').filter({ hasText: note })).toHaveCount(1);
      await expect(
        page.locator('.history-record').filter({ hasText: 'Сохранён тестовый экспорт' }),
      ).toHaveCount(1);
      await page.getByRole('link', { name: 'Открыть обзор периода', exact: true }).click();
      await page.getByLabel('Дата внутри периода').fill(today);
      await page.getByRole('button', { name: 'Открыть обзор', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Обзор недели', exact: true })).toBeVisible();
      await page.getByLabel('Текст обзора').fill(weekText);
      await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Обзор сохранён' })).toBeVisible();
    });
    const weekId = new URL(page.url()).searchParams.get('id')!;
    const week = (await (await request.get(`/api/reviews/${weekId}`)).json()) as Review;
    expect(week.userText).toBe(weekText);
    await test.step('8–9: another period, portfolio month and return to saved review', async () => {
      const monthDate = `${today.slice(0, 7)}-01`;
      await page.goto('/reviews');
      await page.getByLabel('Период обзора').selectOption('month');
      await page.getByLabel('Дата внутри периода').fill(monthDate);
      await page.getByLabel('Проект обзора').selectOption('');
      await page.getByRole('button', { name: 'Открыть обзор', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Обзор месяца', exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Связанные обзоры' })).toContainText(
        inputs[0].name,
      );
      const monthText =
        'Экспорт в работе; архив на паузе; справочник ждёт ответа. Общей оценки успеха нет.';
      await page.getByLabel('Текст обзора').fill(monthText);
      await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Обзор сохранён' })).toBeVisible();
      await page.reload();
      await expect(page.getByLabel('Текст обзора')).toHaveValue(monthText);
      await page.goto(`/reviews?id=${weekId}`);
      await expect(page.getByLabel('Текст обзора')).toHaveValue(weekText);
      // Reopening an older period checks persistence; it does not simulate a month of real use.
      await page.goto(`/reviews?project=${project.id}&day=2024-03-06`);
      await page.getByRole('button', { name: 'Открыть обзор', exact: true }).click();
      await page.getByLabel('Текст обзора').fill('Исторический тестовый итог');
      await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Обзор сохранён' })).toBeVisible();
      const oldId = new URL(page.url()).searchParams.get('id')!;
      await page.goto(`/reviews?id=${weekId}`);
      await page.goto(`/reviews?id=${oldId}`);
      await expect(page.getByLabel('Текст обзора')).toHaveValue('Исторический тестовый итог');
    });
    await test.step('10,12: exact local packet without provider; core works after analysis read failure', async () => {
      await page.goto(`/period-analysis?review=${weekId}`);
      const form = page.getByRole('form', { name: 'Подготовка ручного анализа' });
      await form.getByLabel('Результаты задач', { exact: true }).check();
      await form.getByLabel('Наблюдения', { exact: true }).check();
      await form.getByLabel('Мой сохранённый текст этого обзора', { exact: true }).check();
      await form
        .getByLabel('Разрешаю прочитать выбранные источники и сохранить пакет локально')
        .check();
      const prepared = page.waitForResponse(
        (r) => r.url().endsWith('/api/period-analysis/prepare') && r.request().method() === 'POST',
      );
      await page.getByRole('button', { name: 'Подготовить точный пакет', exact: true }).click();
      const response = await prepared;
      expect(response.status()).toBe(201);
      const run = (await response.json()) as PeriodRun;
      expect(run.status).toBe('pending');
      expect(run.approvedAt).toBeNull();
      expect(run.report).toBeNull();
      expect(JSON.stringify(run.payload)).toContain(note);
      expect(JSON.stringify(run.payload)).toContain('Сохранён тестовый экспорт');
      expect(JSON.stringify(run.payload)).toContain(weekText);
      expect(run.payload.sources.every((s) => s.projectId === project.id)).toBe(true);
      await page.route('**/api/period-analysis/status', (route) =>
        route.fulfill({ status: 503, json: { error: 'Synthetic analysis outage' } }),
      );
      await page.reload();
      await expect(page.getByText('Synthetic analysis outage', { exact: false })).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/observations?project=${project.id}`);
      await page.getByLabel('Текст наблюдения').fill('Работа продолжается без AI.');
      await page.getByRole('button', { name: 'Сохранить наблюдение', exact: true }).click();
      await expect(page.getByLabel('Текст наблюдения')).toHaveValue('');
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole('region', { name: 'Последние записи проекта' })).toContainText(
        note,
      );
      await expect(page.getByRole('region', { name: 'Последние записи проекта' })).toContainText(
        'Сохранён тестовый экспорт',
      );
      await expect(page.getByRole('link', { name: 'Обзор месяца →', exact: true })).toBeVisible();
      await page.goto(`/reviews?id=${weekId}`);
      await expect(page.getByLabel('Текст обзора')).toHaveValue(weekText);
      expect((await (await request.get(`/api/reviews/${weekId}`)).json()).revision).toBe(
        week.revision,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
    expect(errors).toEqual([]);
  } finally {
    await mcp?.close();
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
