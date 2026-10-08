import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import { connectMcp } from '../mcp-client';
import type { Workspace } from '../../shared/contracts';

test('browser ↔ production stdio MCP, filters, completion, draft conflict and responsive keyboard workflow', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const repo = await f.repo('tasks-mcp-project');
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const headers = { 'X-Control-Center': '1' };
  await request.put('/api/settings', { headers, data: { ...initial.settings, roots: [repo] } });
  const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
  const project = workspace.projects.find((item) => item.path === repo)!;
  const mcp = await connectMcp(path.dirname(workspace.storage.databasePath), f.root, true);
  try {
    await page.goto(`/tasks?project=${project.id}`);
    const title = 'Найти обращения и сохранить результат проверки без потери данных';
    await page.getByLabel('Название задачи').fill(title);
    await page.getByRole('combobox', { name: 'Когда', exact: true }).selectOption('now');
    await page.getByLabel('Название задачи').press('Enter');
    await expect(page.getByRole('status')).toContainText('Задача сохранена');
    const found = (await mcp.call('task_list', { projectId: project.id, query: title })).value
      .items[0];
    expect(found.code).toMatch(/^CC-\d+$/);
    const card = page
      .locator('.task-card')
      .filter({ has: page.getByRole('heading', { name: title }) });
    await expect(card.getByText(found.code, { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Изменить', exact: true }).click();
    await expect(page.getByLabel('Название задачи')).toBeFocused();
    await page.getByLabel('Название задачи').fill('Мой несохранённый текст');
    const changed = await mcp.call('task_update', {
      identifier: found.code,
      revision: found.revision,
      change: {
        description: 'Изменено другим агентом',
        expectedResult: 'Найденное обращение доступно по запросу',
        acceptance: 'Проверены пустой запрос и найденный результат',
        links: ['D-0001'],
      },
    });
    expect(changed.isError).toBe(false);
    await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('уже изменена');
    await expect(page.getByLabel('Название задачи')).toHaveValue('Мой несохранённый текст');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(card.getByText('Изменено другим агентом', { exact: true })).toBeVisible();
    const completed = await mcp.call('task_complete', {
      identifier: found.code,
      revision: changed.value.revision,
      result: {
        summary: 'Добавлен поиск обращений',
        verified: 'Пустой запрос и совпадения',
        unverified: 'Рабочая база владельца',
      },
    });
    expect(completed.isError).toBe(false);
    await expect(card).toHaveCount(0);
    await page.getByLabel('Завершённые', { exact: true }).check();
    await expect(card).toBeVisible();
    await card.locator('summary').click();
    await expect(card.getByText(/Добавлен поиск обращений/)).toBeVisible();
    await expect(card.getByText(/Рабочая база владельца/)).toBeVisible();
    await expect(card.getByText(/Завершена:/)).toBeVisible();
    await card.getByRole('button', { name: 'Вернуть', exact: true }).click();
    await page.getByLabel('Завершённые', { exact: true }).uncheck();
    await page.getByLabel('Поиск задач', { exact: true }).fill(found.code);
    await expect(card).toBeVisible();
    await page.getByRole('combobox', { name: 'Состояние', exact: true }).selectOption('later');
    await expect(card).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Состояние', exact: true }).selectOption('');
    await expect(card).toBeVisible();
    const general = await mcp.call('task_create', {
      title: 'Общая задача из Codex',
      projectId: null,
      requestKey: 'browser-general-create',
    });
    expect(general.isError).toBe(false);
    await page.getByLabel('Показать проект').selectOption('__general__');
    await page.getByLabel('Поиск задач').fill('Общая задача из Codex');
    await expect(page.getByRole('heading', { name: 'Общая задача из Codex' })).toBeVisible();
    expect(
      (await mcp.call('task_list', { projectId: project.id })).value.items.some(
        (item: { id: string }) => item.id === general.value.id,
      ),
    ).toBe(false);
    await page.getByLabel('Показать проект').selectOption(project.id);
    await page.getByLabel('Поиск задач').fill(found.code);
    await mkdir('.local/tasks-mcp-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(card).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await card.getByRole('button', { name: 'Изменить', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Название задачи')).toBeFocused();
      await page.locator('form').getByText('Условия и результат работы', { exact: true }).click();
      await expect(page.getByLabel('Что сделано', { exact: true })).toHaveValue(
        'Добавлен поиск обращений',
      );
      await page.screenshot({ path: `.local/tasks-mcp-review/board-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page
        .locator('form details')
        .evaluate((element) => ((element as HTMLDetailsElement).open = false));
    }
    // Explicit migration leaves metadata intact and does not duplicate tasks on repeat.
    await request.put(`/api/projects/${project.id}`, {
      headers,
      data: {
        metadata: { ...project.metadata, next: ['Сохранённый шаг', 'Сохранённый шаг'] },
        notes: project.notes,
      },
    });
    const first = await (
      await request.post(`/api/projects/${project.id}/import-plan`, { headers, data: {} })
    ).json();
    const second = await (
      await request.post(`/api/projects/${project.id}/import-plan`, { headers, data: {} })
    ).json();
    expect(first[0].id).toBe(second[0].id);
    expect(first[0].id).toBe(first[1].id);
    const after = (await (await request.get('/api/workspace')).json()) as Workspace;
    expect(after.projects.find((item) => item.id === project.id)!.metadata.next).toEqual([
      'Сохранённый шаг',
      'Сохранённый шаг',
    ]);
  } finally {
    await mcp.close();
    await f.cleanup();
  }
});
