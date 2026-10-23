import { test, expect } from '@playwright/test';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import path from 'node:path';
import { connectMcp } from '../mcp-client';

test('React settings → real scan → tasks → immutable history → backup; drafts survive refresh and errors', async ({
  page,
  request,
}) => {
  const f = await fixture();
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const repo = await f.repo('react-product');
    await page.goto('/settings');
    await page.getByLabel('Полные пути, каждый с новой строки').fill(repo);
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    await page.getByRole('navigation').getByRole('link', { name: 'Проекты', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'react-product', exact: true })).toBeVisible();
    await page.getByRole('navigation').getByRole('link', { name: 'Задачи', exact: true }).click();
    await page
      .getByRole('combobox', { name: 'Показать проект', exact: true })
      .selectOption({ label: 'react-product' });
    await page.getByLabel('Название задачи').fill('React contract task');
    await page
      .getByRole('combobox', { name: 'Проект', exact: true })
      .selectOption({ label: 'react-product' });
    await page.getByRole('combobox', { name: 'Когда', exact: true }).selectOption('now');
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'React contract task', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Изменить', exact: true }).click();
    await page.getByLabel('Название задачи').fill('Retained draft');
    const current = (await (await request.get('/api/workspace')).json()) as Workspace;
    const task = current.tasks.find((t) => t.title === 'React contract task')!;
    const mcp = await connectMcp(path.dirname(current.storage.databasePath), f.root, true);
    try {
      expect(
        (
          await mcp.call('task_update', {
            identifier: task.code,
            revision: task.revision,
            change: { description: 'Concurrent MCP edit' },
          })
        ).isError,
      ).toBe(false);
    } finally {
      await mcp.close();
    }
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(page.getByLabel('Название задачи')).toHaveValue('Retained draft');
    await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия', exact: true })).toBeVisible();
    await expect(page.getByLabel('Название задачи')).toHaveValue('Retained draft');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'React contract task', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('link', { name: 'История работы →', exact: true }).click();
    await expect(page.locator('.history-entry')).toContainText(
      'Владелец отметил задачу выполненной.',
    );
    await page.getByText('Ещё', { exact: true }).click();
    await page
      .getByRole('navigation')
      .getByRole('link', { name: 'Настройки', exact: true })
      .click();
    await page.getByLabel('Полные пути, каждый с новой строки').fill('C:/unsaved');
    await page.getByRole('navigation').getByRole('link', { name: 'Проекты', exact: true }).click();
    await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
    await expect(page.getByLabel('Полные пути, каждый с новой строки')).toHaveValue('C:/unsaved');
    await page.getByRole('button', { name: 'Создать резервную копию' }).click();
    await expect(page.getByRole('status')).toContainText('Резервная копия создана и проверена');
    await page.route('**/api/settings', (route) =>
      route.fulfill({ status: 409, json: { error: 'Settings conflict' } }),
    );
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия', exact: true })).toContainText(
      'Settings conflict',
    );
    await expect(page.getByLabel('Полные пути, каждый с новой строки')).toHaveValue('C:/unsaved');
    await page.unroute('**/api/settings');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    const w = (await (await request.get('/api/workspace')).json()) as Workspace;
    expect(w.tasks.find((t) => t.title === 'React contract task')!.completedAt).not.toBeNull();
    expect(w.projects.some((p) => p.path === repo)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
