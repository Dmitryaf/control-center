import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';

test('remove an available project, cancel, recover from failure, rescan and restore discovery', async ({
  page,
}) => {
  const f = await fixture();
  try {
    const repo = await f.repo('removable-product');
    await f.repo('retained-tool');
    const state = async () =>
      (await (await page.request.get('/api/workspace')).json()) as Workspace;
    await page.goto('/settings');
    await page.getByLabel('Полные пути').fill(f.root);
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    const project = (await state()).projects.find((p) => p.path === repo)!;
    await page.goto(`/projects/${project.id}`);
    const remove = page.getByRole('button', { name: 'Удалить из Control Center' });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(remove).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.local/project-removal-${width}.png` });
    }
    page.once('dialog', (dialog) => dialog.dismiss());
    await remove.click();
    expect((await state()).projects.some((p) => p.id === project.id)).toBe(true);
    await page.route(`**/api/projects/${project.id}`, (route) => {
      if (route.request().method() === 'DELETE')
        return route.fulfill({ status: 409, json: { error: 'Дождитесь сканирования.' } });
      return route.continue();
    });
    page.once('dialog', (dialog) => dialog.accept());
    await remove.click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия' })).toContainText(
      'Дождитесь сканирования',
    );
    await expect(remove).toBeEnabled();
    expect((await state()).projects.some((p) => p.id === project.id)).toBe(true);
    await page.unroute(`**/api/projects/${project.id}`);
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Каталог и файлы останутся на диске');
      return dialog.accept();
    });
    await remove.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('link', { name: 'removable-product', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Данные обновлены');
    expect((await state()).projects.map((p) => p.path)).not.toContain(repo);
    const legacySettings = { ...(await state()).settings };
    Reflect.deleteProperty(legacySettings, 'excludedProjectPaths');
    const saved = await page.request.put('/api/settings', {
      headers: { 'X-Control-Center': '1' },
      data: legacySettings,
    });
    expect(saved.ok()).toBe(true);
    expect((await state()).settings.excludedProjectPaths).toContain(repo);
    expect((await state()).projects.map((p) => p.path)).not.toContain(repo);
    expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('# Fixture\n');
    await page.goto('/settings');
    await page.getByText('Проекты, удалённые из Control Center', { exact: true }).click();
    await page.getByLabel('Исключённые пути проектов, каждый с новой строки').fill('');
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    expect((await state()).projects.map((p) => p.path)).toContain(repo);
  } finally {
    await f.cleanup();
  }
});
