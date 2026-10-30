import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { Store } from '../../server/db';
import { createApp } from '../../server/app';
import { fixture } from '../fixtures';
import type { Workspace, Task } from '../../shared/contracts';

test('short task form and separate result preserve existing conditions, links, structured evidence and revision guards', async ({
  page,
  playwright,
}) => {
  const f = await fixture();
  const repo = await f.repo('compact-task-project');
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  const store = new Store(path.join(f.root, 'tasks.sqlite'));
  const runtime = createApp(store, address.port);
  runtime.app.use(express.static(path.resolve('dist/client')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')));
  server.on('request', runtime.app);
  const request = await playwright.request.newContext({ baseURL: base });
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  try {
    await request.put('/api/settings', {
      headers,
      data: { ...initial.settings, roots: [repo], autoRefreshMinutes: 0 },
    });
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const project = workspace.projects.find((p) => p.path === repo)!;
    const saved = (await (
      await request.post('/api/tasks', {
        headers,
        data: {
          title: 'Сохранить подробный результат проверки синхронизации',
          projectId: project.id,
          expectedResult: 'Запись доступна после перезапуска',
          acceptance: 'Проверены повторное открытие и отсутствие дубликатов',
          links: ['D-0001'],
          result: {
            summary: 'Добавлена проверка сохранности',
            verified: 'Синтетическая база и повторное открытие',
            unverified: 'Поведение при отключении диска',
            remaining: '',
          },
        },
      })
    ).json()) as Task;
    await page.goto(`${base}/tasks?project=${project.id}`);
    const form = page.locator('form').first();
    await expect(form.getByRole('textbox')).toHaveCount(2);
    await expect(form.getByLabel('Ожидаемый результат')).toHaveCount(0);
    await page.getByLabel('Название задачи', { exact: true }).fill('Короткая задача без отчёта');
    await page.getByLabel('Название задачи', { exact: true }).press('Enter');
    const quick = page.locator('.task-card').filter({
      has: page.getByRole('heading', { name: 'Короткая задача без отчёта', exact: true }),
    });
    await expect(quick).toBeVisible();
    await quick.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(quick).toHaveCount(0);
    const card = page.locator('.task-card').filter({ hasText: saved.code });
    const resultForm = page.getByRole('form', { name: `Итог ${saved.code}`, exact: true });
    await card.getByRole('button', { name: 'Изменить', exact: true }).click();
    await page
      .getByLabel('Описание', { exact: true })
      .fill('Уточнение постановки без изменения отчёта');
    await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
    const afterEdit = (
      (await (await request.get('/api/workspace')).json()) as Workspace
    ).tasks.find((t) => t.id === saved.id)!;
    expect(afterEdit.expectedResult).toBe(saved.expectedResult);
    expect(afterEdit.acceptance).toBe(saved.acceptance);
    expect(afterEdit.links).toEqual(saved.links);
    expect(afterEdit.result).toEqual(saved.result);
    await card.getByRole('button', { name: 'Изменить итог', exact: true }).click();
    await resultForm
      .getByLabel('Итог работы', { exact: true })
      .fill('Уточнённый итог с прежними основаниями');
    await resultForm.getByRole('button', { name: 'Сохранить итог', exact: true }).click();
    await expect(resultForm.getByLabel('Итог работы', { exact: true })).toHaveCount(0);
    const afterResult = (
      (await (await request.get('/api/workspace')).json()) as Workspace
    ).tasks.find((t) => t.id === saved.id)!;
    expect(afterResult.result).toEqual({
      ...saved.result,
      summary: 'Уточнённый итог с прежними основаниями',
    });
    await card.getByRole('button', { name: 'Изменить итог', exact: true }).click();
    await resultForm.getByLabel('Итог работы', { exact: true }).fill('Мой несохранённый итог');
    await request.put(`/api/tasks/${saved.id}`, {
      headers,
      data: {
        ...afterResult,
        completedAt: new Date().toISOString(),
        result: { ...afterResult.result, verified: 'Более новая проверка другого клиента' },
      },
    });
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(resultForm.getByLabel('Итог работы', { exact: true })).toHaveValue(
      'Мой несохранённый итог',
    );
    await resultForm.getByRole('button', { name: 'Сохранить итог', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия', exact: true })).toContainText(
      'уже изменена',
    );
    await expect(resultForm.getByLabel('Итог работы', { exact: true })).toHaveValue(
      'Мой несохранённый итог',
    );
    await mkdir('.local/work/embedded-codex-ui', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/work/embedded-codex-ui/tasks-${width}.png`,
        fullPage: true,
      });
    }
    page.once('dialog', (dialog) => dialog.accept());
    await resultForm.getByRole('button', { name: 'Отмена', exact: true }).click();
    const partial = (await (
      await request.post('/api/tasks', {
        headers,
        data: {
          title: 'Завершить ранее частично выполненную работу',
          projectId: project.id,
          result: {
            summary: 'Первая часть выполнена',
            verified: 'Первая часть',
            unverified: 'Оставшийся шаг',
            remaining: 'Проверить повторное открытие',
          },
        },
      })
    ).json()) as Task;
    const partialCard = page.locator('.task-card').filter({ hasText: partial.code });
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    page.once('dialog', (dialog) => dialog.dismiss());
    await partialCard.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(partialCard).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await partialCard.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(partialCard).toHaveCount(0);
    const history = await (
      await request.get(`/api/task-history?identifier=${partial.code}`)
    ).json();
    expect(
      history.items.some(
        (entry: { task: Task }) => entry.task.result?.remaining === 'Проверить повторное открытие',
      ),
    ).toBe(true);
  } finally {
    await runtime.codexAnalysis.stop();
    await runtime.codex.stop();
    await request.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  }
});
