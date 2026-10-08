import { test, expect } from '@playwright/test';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import { designFixture } from './design-fixture';

test('failed automatic reads identify saved snapshots and recover on wide and narrow screens', async ({
  page,
}) => {
  const data = designFixture();
  const project = data.projects[0]!;
  project.available = false;
  data.refresh = {
    running: false,
    lastAttemptAt: '2026-10-08T10:00:00Z',
    errors: ['Не все данные проекта удалось прочитать. Показаны доступные данные.'],
  };
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/projects');
    await expect(page.getByRole('alert', { name: 'Обновление проектов' })).toContainText(
      'При автоматическом обновлении',
    );
    const row = page.locator('.project-row').first();
    await expect(row.getByText('Последний доступный снимок:', { exact: false })).toBeVisible();
    await expect(row.locator('time')).toHaveAttribute('datetime', project.snapshot.scannedAt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.route('**/api/scan', (route) =>
    route.fulfill({ status: 409, json: { error: 'Не удалось выполнить ручное обновление.' } }),
  );
  await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Ошибка действия' })).toContainText(
    'Не удалось выполнить ручное обновление',
  );
  await expect(page.getByRole('alert', { name: 'Обновление проектов' })).toBeVisible();
  await page.unroute('**/api/scan');
  project.available = true;
  data.refresh.errors = [];
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.locator('.project-row').first().getByText('Снимок файлов:', { exact: false }),
  ).toBeVisible();
});

test('production timer → saved snapshot → open draft, YAML conflict, freshness and keyboard settings on wide/narrow screens', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const repo = await f.repo('auto-refresh');
  const yaml = path.join(repo, 'PROJECT.yaml');
  await writeFile(yaml, 'name: Состояние проекта\n');
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  await request.put('/api/settings', {
    headers,
    data: { ...initial.settings, roots: [f.root], autoRefreshMinutes: 1 },
  });
  const readWorkspace = async () =>
    (await (await request.get('/api/workspace')).json()) as Workspace;
  const workspace = await readWorkspace();
  const project = workspace.projects.find((p) => p.path === repo)!;
  await request.put(`/api/projects/${project.id}`, {
    headers,
    data: {
      metadata: { ...project.metadata, current_focus: 'Сохранённый фокус' },
      notes: 'Сохранённые заметки',
    },
  });
  try {
    await page.goto(`/projects/${project.id}`);
    await expect(
      page.getByRole('heading', { name: 'Состояние проекта', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Интервал обновления проектов: 1 мин.')).toBeVisible();
    await page.getByRole('button', { name: 'Изменить сводку' }).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Зачем существует', { exact: true }).fill('Мой несохранённый черновик');
    const prior = (await readWorkspace()).projects.find((p) => p.id === project.id)!;
    const lastSnapshot = prior.snapshot.scannedAt;
    const undiscovered = await f.repo('not-discovered-by-timer');
    await writeFile(yaml, 'name: Изменено вне приложения\n');
    await writeFile(path.join(repo, 'update.txt'), 'Updated locally');
    f.git(repo, 'add', 'update.txt');
    f.git(
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Background fixture update',
    );
    // No scan/project GET is used here: only the real production timer may inspect the repository.
    await expect
      .poll(
        async () => {
          const value = (await readWorkspace()).projects.find((p) => p.id === project.id)!;
          return value.snapshot.git.commits[0]?.subject;
        },
        { timeout: 80000, intervals: [1000] },
      )
      .toBe('Background fixture update');
    const latest = await readWorkspace();
    const updated = latest.projects.find((p) => p.id === project.id)!;
    expect(updated.snapshot.scannedAt > lastSnapshot).toBe(true);
    expect(updated.yamlConflict).toBe(true);
    expect(updated.notes).toBe('Сохранённые заметки');
    expect(updated.metadata.current_focus).toBe('Сохранённый фокус');
    expect(latest.projects.some((p) => p.path === undiscovered)).toBe(false);
    await expect(page.locator('.page-heading time')).toHaveAttribute(
      'datetime',
      updated.snapshot.scannedAt,
    );
    await expect(page.getByLabel('Зачем существует', { exact: true })).toHaveValue(
      'Мой несохранённый черновик',
    );
    await page.getByRole('button', { name: 'Сохранить сводку', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия' })).toContainText(
      'PROJECT.yaml изменился',
    );
    await expect(page.getByLabel('Зачем существует', { exact: true })).toHaveValue(
      'Мой несохранённый черновик',
    );
    expect(await readFile(yaml, 'utf8')).toBe('name: Изменено вне приложения\n');
    await mkdir('.local/project-refresh-review', { recursive: true });
    await page.screenshot({
      path: '.local/project-refresh-review/project-1440.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.page-heading time')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: '.local/project-refresh-review/project-390.png',
      fullPage: true,
    });

    await page.getByRole('navigation').getByRole('link', { name: 'Настройки' }).click();
    const interval = page.getByLabel('Интервал обновления, минут');
    await interval.fill('0');
    await interval.press('Enter');
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    await expect(page.getByText('Автоматическое обновление проектов отключено.')).toBeVisible();
    expect((await readWorkspace()).settings.autoRefreshMinutes).toBe(0);
    await page.route('**/api/workspace', (route) => route.abort());
    await expect(page.getByRole('alert', { name: 'Связь с сервером' })).toContainText(
      'Нет связи с локальным сервером',
    );
    await expect(interval).toHaveValue('0');
    await page.unroute('**/api/workspace');
    await expect(page.getByText('Нет связи с локальным сервером.', { exact: false })).toHaveCount(
      0,
    );
    await page.screenshot({
      path: '.local/project-refresh-review/settings-390.png',
      fullPage: true,
    });
  } finally {
    const current = await readWorkspace();
    await request.put('/api/settings', {
      headers,
      data: { ...current.settings, roots: [], autoRefreshMinutes: 0 },
    });
    await f.cleanup();
  }
});
