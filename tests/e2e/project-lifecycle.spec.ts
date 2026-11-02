import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { fixture } from '../fixtures';
import { Store } from '../../server/db';
import { Projects } from '../../server/projects/projects';
import { Tasks } from '../../server/tasks';
import { createApp } from '../../server/app';

test('project closure: explanation, open tasks, retry, restart, history and reopening on desktop/mobile', async ({
  page,
}) => {
  const f = await fixture();
  const repo = await f.repo('garden-experiment');
  const database = path.join(f.root, 'workspace.sqlite');
  const seed = new Store(database);
  seed.saveSettings({ ...seed.settings(), roots: [repo], autoRefreshMinutes: 0 });
  const projects = new Projects(seed);
  await projects.scan();
  const project = projects.list()[0];
  seed.saveMetadata(project.id, { ...project.metadata, status: 'active' }, '');
  const task = new Tasks(seed).save({
    title: 'Проверить всходы',
    projectId: project.id,
    result: { summary: 'Первый этап проверки сохранён', remaining: 'Проверить ещё один образец' },
  });
  seed.close();
  let server: Server,
    store: Store,
    runtime: ReturnType<typeof createApp>,
    base = '',
    port = 0;
  async function start() {
    server = createServer();
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    port = address.port;
    base = `http://127.0.0.1:${port}`;
    store = new Store(database);
    runtime = createApp(store, port);
    runtime.app.use(express.static(path.resolve('dist/client')));
    runtime.app.get('/{*path}', (_req, res) =>
      res.sendFile(path.resolve('dist/client/index.html')),
    );
    server.on('request', runtime.app);
  }
  async function stop() {
    await runtime.codexAnalysis.stop();
    await runtime.codex.stop();
    await runtime.periodAnalysis.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
  await start();
  try {
    await page.goto(`${base}/projects/${project.id}`);
    await page.getByRole('button', { name: 'Закрыть проект', exact: true }).click();
    const form = page.getByRole('form', { name: 'Закрытие проекта', exact: true });
    await form.getByRole('button', { name: 'Отмена', exact: true }).click();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM project_lifecycle_events').get()?.n).toBe(0);
    await page.getByRole('button', { name: 'Закрыть проект', exact: true }).click();
    await expect(form).toContainText('Проверить всходы');
    await expect(form).toContainText('будут отменены');
    await form.getByLabel('Больше не развиваю', { exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(form.getByLabel('Больше не развиваю', { exact: true })).toBeChecked();
    const reason =
      'Проверка помогла выбрать другой способ. Продолжать этот эксперимент не планирую.';
    await form.getByLabel('Пояснение', { exact: true }).fill(reason);
    page.once('dialog', (dialog) => dialog.dismiss());
    await form.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(form.getByLabel('Пояснение', { exact: true })).toHaveValue(reason);
    await page
      .getByRole('navigation', { name: 'Основная навигация' })
      .getByRole('link', { name: 'Проекты', exact: true })
      .click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
    await expect(form.getByLabel('Пояснение', { exact: true })).toHaveValue(reason);
    let fail = true;
    await page.route('**/api/projects/*/close', async (route) => {
      if (fail) {
        fail = false;
        await route.fulfill({ status: 503, json: { error: 'Временная ошибка сохранения' } });
      } else await route.continue();
    });
    await form.getByRole('button', { name: 'Подтвердить закрытие', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Временная ошибка сохранения');
    await expect(form.getByLabel('Пояснение', { exact: true })).toHaveValue(reason);
    await mkdir('.local/project-closure/screenshots', {
      recursive: true,
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/project-closure/screenshots/form-${width}.png`,
        fullPage: true,
      });
    }
    await form.getByRole('button', { name: 'Подтвердить закрытие', exact: true }).click();
    const outcome = page.getByRole('region', { name: 'Итог проекта', exact: true });
    await expect(outcome).toContainText(reason);
    await expect(outcome).toContainText('Больше не развиваю');
    await expect(form).toHaveCount(0);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM project_lifecycle_events').get()?.n).toBe(1);
    await stop();
    await start();
    await page.reload();
    await expect(outcome).toContainText(reason);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/project-closure/screenshots/closed-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Вернуть в работу', exact: true }).click();
    await page.getByRole('button', { name: 'Подтвердить возврат', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Закрыть проект', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Закрыть проект', exact: true }).click();
    await form.getByLabel('Завершён', { exact: true }).check();
    await form
      .getByLabel('Пояснение', { exact: true })
      .fill('Цель достигнута после повторной проверки.');
    await form.getByRole('button', { name: 'Подтвердить закрытие', exact: true }).click();
    await expect(outcome).toContainText('Цель достигнута');
    await page.goto(`${base}/projects`);
    await page.getByRole('button', { name: 'Закрытые', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: project.metadata.name, exact: true }),
    ).toBeVisible();
    await page.goto(`${base}/timeline?project=${project.id}&kind=project`);
    await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(
      page.getByText('Цель достигнута после повторной проверки.', { exact: true }),
    ).toBeVisible();
    await page
      .locator('.history-record')
      .filter({ hasText: reason })
      .getByRole('link', { name: 'Открыть источник →', exact: true })
      .click();
    await expect(page.getByRole('article', { name: 'Сохранённое событие проекта' })).toContainText(
      reason,
    );
    await expect(
      page
        .getByRole('navigation', { name: 'Основная навигация' })
        .getByRole('link', { name: 'История', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    const saved = new Tasks(store).read(task.id);
    expect(saved.completedAt).toBe(null);
    expect(saved.cancellation?.projectEventId).toBeTruthy();
    expect(saved.revision).toBe(task.revision + 1);
    await page.goto(`${base}/tasks?project=${project.id}`);
    await expect(page.getByRole('region', { name: 'Список задач' })).not.toContainText(task.title);
    await page
      .getByRole('combobox', { name: 'Состояние задач', exact: true })
      .selectOption('cancelled');
    const card = page.getByRole('article').filter({ hasText: task.title });
    await expect(card).toContainText('Отменена при закрытии проекта');
    await card.getByText('Условия и результат', { exact: true }).click();
    await expect(card).toContainText(task.result!.summary);
    await expect(card).toContainText(task.result!.remaining);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/project-closure/screenshots/cancelled-tasks-${width}.png`,
        fullPage: true,
      });
    }
    await card.getByRole('button', { name: 'Вернуть', exact: true }).click();
    await page.getByRole('combobox', { name: 'Состояние задач', exact: true }).selectOption('open');
    await expect(card).toBeVisible();
    await page.goto(`${base}/history?task=${task.code}`);
    await expect(page.getByText('Задача отменена', { exact: true })).toBeVisible();
    await expect(page.getByText('Возвращена в работу', { exact: true })).toBeVisible();
    // Refetch must not replace the revision captured by an already open summary form.
    await page.goto(`${base}/projects/${project.id}`);
    await page.getByRole('button', { name: 'Изменить сводку', exact: true }).click();
    await page.getByLabel('Зачем существует', { exact: true }).fill('Несохранённое пояснение');
    const reopened = await page.request.post(`${base}/api/projects/${project.id}/reopen`, {
      headers: { 'X-Control-Center': '1' },
      data: { revision: 3, requestKey: randomUUID() },
    });
    expect(reopened.ok()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button', { name: 'Закрыть проект', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Сохранить сводку', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Состояние проекта изменилось');
    await expect(page.getByLabel('Зачем существует', { exact: true })).toHaveValue(
      'Несохранённое пояснение',
    );
    expect(new Projects(store).list()[0].metadata.status).toBe('active');
  } finally {
    await stop();
    await f.cleanup();
  }
});
