import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import { connectMcp } from '../mcp-client';
import type { Workspace } from '../../shared/contracts';

test('work history preserves repeated results from production MCP, filters, deletion and recoverable read failures on wide/narrow screens', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const repo = await f.repo('history-project');
  const otherRepo = await f.repo('unrelated-history-project');
  const headers = { 'X-Control-Center': '1' };
  const original = (await (await request.get('/api/workspace')).json()) as Workspace;
  await request.put('/api/settings', {
    headers,
    data: { ...original.settings, roots: [repo, otherRepo], autoRefreshMinutes: 0 },
  });
  const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
  const project = workspace.projects.find((item) => item.path === repo)!;
  const other = workspace.projects.find((item) => item.path === otherRepo)!;
  const mcp = await connectMcp(path.dirname(workspace.storage.databasePath), f.root, true);
  try {
    await page.goto(`/tasks?project=${project.id}`);
    const title =
      'Сохранить прежние результаты проверки поиска после возврата задачи в работу и повторного завершения';
    await page.getByLabel('Название задачи').fill(title);
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Задача сохранена');
    const task = (await mcp.call('task_list', { projectId: project.id, query: title })).value
      .items[0];
    const first = await mcp.call('task_complete', {
      identifier: task.code,
      revision: task.revision,
      result: {
        summary: 'Первый результат: поиск по названию',
        verified: 'Совпадения и пустой запрос',
        unverified: 'Рабочая база владельца',
      },
    });
    expect(first.isError).toBe(false);
    await page.getByRole('link', { name: 'История работы →' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('История работы');
    await expect(
      page.getByRole('navigation').getByRole('link', { name: 'Задачи', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('.history-entry')).toHaveCount(1);
    await expect(page.getByText(/Первый результат: поиск по названию/)).toBeVisible();
    const reopened = await mcp.call('task_update', {
      identifier: task.code,
      revision: first.value.revision,
      change: { completedAt: null },
    });
    const partial = await mcp.call('task_update', {
      identifier: task.code,
      revision: reopened.value.revision,
      change: { result: { summary: 'Добавлена фильтрация', remaining: 'Проверить клавиатуру' } },
    });
    const second = await mcp.call('task_complete', {
      identifier: task.code,
      revision: partial.value.revision,
      result: {
        summary: 'Второй результат: фильтрация и поиск',
        verified: 'Клавиатура, длинный текст и узкий экран',
        unverified: 'Рабочая база владельца',
      },
    });
    expect(second.isError).toBe(false);
    await expect(page.locator('.history-entry')).toHaveCount(4);
    await expect(page.locator('.history-entry').first()).toContainText('Второй результат');
    await expect(page.locator('.history-entry').last()).toContainText('Первый результат');
    const otherTask = await mcp.call('task_create', {
      title: 'Другой проект',
      projectId: other.id,
      requestKey: 'history-other',
    });
    await mcp.call('task_complete', {
      identifier: otherTask.value.code,
      revision: otherTask.value.revision,
      result: { summary: 'Не входит в выбранный проект' },
    });
    const general = await mcp.call('task_create', {
      title: 'Общий результат',
      projectId: null,
      requestKey: 'history-general',
    });
    await mcp.call('task_complete', {
      identifier: general.value.code,
      revision: general.value.revision,
      result: { summary: 'Общая работа' },
    });
    await page.getByLabel('Номер задачи').fill(task.code);
    await page.getByLabel('Номер задачи').press('Enter');
    await expect(page.locator('.history-entry')).toHaveCount(4);
    const today = first.value.updatedAt.slice(0, 10);
    await page.getByLabel('С даты (UTC)').fill(today);
    await page.getByLabel('По дату (UTC)').fill(today);
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.locator('.history-entry')).toHaveCount(4);
    await page.getByLabel('По дату (UTC)').fill('2000-01-01');
    await page.getByLabel('С даты (UTC)').fill('2000-01-01');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.getByText('За этот период записей нет.', { exact: false })).toBeVisible();
    await page.getByLabel('С даты (UTC)').fill('');
    await page.getByLabel('По дату (UTC)').fill('');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.locator('.history-entry')).toHaveCount(4);
    await page.route('**/api/task-history?**', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'История временно недоступна' }),
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('alert', { name: 'История работы', exact: true })).toContainText(
      'История временно недоступна',
    );
    await expect(page.locator('.history-entry')).toHaveCount(4);
    await page.unroute('**/api/task-history?**');
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'История работы', exact: true })).toHaveCount(0);
    const screenshotDir = path.resolve('.local/work-history-review');
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: path.join(screenshotDir, 'history-1440.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Показать', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: path.join(screenshotDir, 'history-390.png'), fullPage: true });
    await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const number = page.getByLabel('Номер задачи');
    await number.focus();
    await number.press('Tab');
    await expect(page.getByLabel('С даты (UTC)')).toBeFocused();
    await page
      .locator('.history-entry')
      .first()
      .getByRole('link', { name: 'Открыть текущую задачу →' })
      .click();
    await expect(page.getByLabel('Название задачи')).toHaveValue(title);
    page.once('dialog', (dialog) => dialog.accept());
    await page
      .locator('.task-card')
      .filter({ hasText: task.code })
      .getByRole('button', { name: 'Удалить', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('Запись удалена');
    await page.goto(`/history?task=${task.code}`);
    await expect(page.locator('.history-entry')).toHaveCount(4);
    await expect(page.getByRole('link', { name: 'Открыть текущую задачу →' })).toHaveCount(0);
    await expect(page.locator('.history-entry').first()).toContainText('Задача удалена');
    const deleted = (await mcp.call('task_history', { identifier: task.code })).value;
    expect(deleted.total).toBe(4);
    expect(deleted.items.every((entry: { taskExists: boolean }) => !entry.taskExists)).toBe(true);
    await page.getByLabel('Номер задачи').fill('');
    await page.getByLabel('История проекта').selectOption('__general__');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.locator('.history-entry')).toHaveCount(1);
    await expect(page.locator('.history-entry')).toContainText('Общая работа');
    for (let i = 0; i < 50; i++) {
      const created = await request.post('/api/tasks', {
        headers,
        data: { title: `History pagination ${i}`, result: { summary: `Page result ${i}` } },
      });
      expect(created.status()).toBe(201);
    }
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.locator('.history-entry')).toHaveCount(50);
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(page.locator('.history-entry')).toHaveCount(1);
    await expect(page.locator('.history-entry')).toContainText('Общая работа');
    await expect(page.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Назад', exact: true }).click();
    await expect(page.locator('.history-entry')).toHaveCount(50);
  } finally {
    await mcp.close();
    await request.put('/api/settings', {
      headers,
      data: { ...workspace.settings, roots: [], autoRefreshMinutes: 0 },
    });
    await f.cleanup();
  }
});
