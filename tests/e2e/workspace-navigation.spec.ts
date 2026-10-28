import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';

test('visible project actions and destinations work on desktop and mobile without opening settings', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await f.repo('garden-planner');
    await page.goto('/settings');
    await page.getByLabel('Полные пути').fill(f.root);
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    const w = (await (await page.request.get('/api/workspace')).json()) as Workspace;
    const project = w.projects.find((p) => p.metadata.name === 'garden-planner')!;
    expect(project).toBeTruthy();
    await mkdir('.local/ui-redesign', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/projects');
      await page.getByRole('searchbox', { name: 'Поиск проектов' }).fill('garden-planner');
      const card = page.getByRole('article', { name: 'garden-planner', exact: true });
      await expect(card.getByRole('button', { name: 'Удалить из Control Center' })).toBeVisible();
      page.once('dialog', (d) => d.dismiss());
      await card.getByRole('button', { name: 'Удалить из Control Center' }).click();
      await expect(card).toBeVisible();
      await page.screenshot({ path: `.local/ui-redesign/projects-${width}.png`, fullPage: true });
      await card.getByRole('link', { name: 'Открыть проект →', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'garden-planner' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Удалить из Control Center' })).toBeVisible();
      await expect(page.locator('#project-settings')).toBeHidden();
      await expect(page.getByRole('navigation', { name: 'Разделы проекта' })).toBeVisible();
      await page.screenshot({ path: `.local/ui-redesign/project-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole('link', { name: 'Добавить задачу', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/tasks\\?project=${project.id}`));
      await page.goto(`/projects/${project.id}`);
      await page
        .getByRole('navigation', { name: 'Разделы проекта' })
        .getByRole('link', { name: 'История', exact: true })
        .click();
      await expect(page.locator('#project-history')).toBeInViewport();
      await page.getByRole('button', { name: 'Настройки проекта', exact: true }).click();
      await expect(page.locator('#project-settings')).toBeVisible();
      await expect(page.locator('#project-settings')).toBeInViewport();
      await page.goto('/');
      await page.screenshot({ path: `.local/ui-redesign/overview-${width}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    await page.goto('/projects');
    await page.getByRole('searchbox', { name: 'Поиск проектов' }).fill('garden-planner');
    const card = page.getByRole('article', { name: 'garden-planner', exact: true });
    page.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: 'Удалить из Control Center' }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Данные обновлены');
    await expect(card).toHaveCount(0);
    expect(await readFile(path.join(project.path, 'README.md'), 'utf8')).toBe('# Fixture\n');
  } finally {
    await f.cleanup();
  }
});
