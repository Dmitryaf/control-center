import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace, Task } from '../../shared/contracts';
import { dateInZone } from '../../shared/periods';

test('shared task edits, project filters, one overview result and explicit description review', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const workspace = async (): Promise<Workspace> => (await request.get('/api/workspace')).json();
  const initial = await workspace();
  const projectIds: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const repos = [await f.repo('shared-alpha'), await f.repo('shared-beta')];
    for (const [index, repo] of repos.entries())
      await writeFile(
        path.join(repo, 'PROJECT.yaml'),
        `name: ${index ? 'Бета' : 'Альфа'}\nstatus: active\ngoal: Проверить сохранность общих задач\nlast_reviewed: 2020-01-01\n`,
      );
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: { ...initial.settings, roots: repos, autoRefreshMinutes: 0 },
        })
      ).ok(),
    ).toBe(true);
    const projects = (await workspace()).projects.filter((project) => repos.includes(project.path));
    projectIds.push(...projects.map((project) => project.id));
    const alpha = projects.find((project) => project.metadata.name === 'Альфа')!;
    await page.goto(`/tasks?project=${alpha.id}&new=1`);
    await page.getByLabel('Название задачи', { exact: true }).fill('Одна задача для двух проектов');
    await page.getByRole('button', { name: 'Параметры задачи' }).click();
    await page.getByRole('checkbox', { name: 'Бета', exact: true }).check();
    await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Одна задача для двух проектов', exact: true }),
    ).toBeVisible();
    const task = (await workspace()).tasks.find(
      (task) => task.title === 'Одна задача для двух проектов',
    )!;
    expect(task.projectIds?.slice().sort()).toEqual(projectIds.slice().sort());
    for (const id of projectIds) {
      await page.getByLabel('Показать проект').selectOption(id);
      await expect(page.locator('.task-card').filter({ hasText: task.code })).toHaveCount(1);
    }
    await page.getByLabel('Показать проект').selectOption('');
    await expect(page.locator('.task-card').filter({ hasText: task.code })).toHaveCount(1);
    await page.getByRole('button', { name: task.title, exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Подробности задачи' });
    await expect(panel).toContainText('Альфа');
    await expect(panel).toContainText('Бета');
    await panel.getByRole('button', { name: 'Изменить задачу', exact: true }).click();
    await panel
      .getByLabel('Название задачи', { exact: true })
      .fill('Общая задача: проверка сохранена');
    await page.getByLabel('Показать проект').selectOption(alpha.id);
    await expect(panel.getByLabel('Название задачи', { exact: true })).toHaveValue(
      'Общая задача: проверка сохранена',
    );
    await panel.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
    await expect(
      panel.getByRole('heading', { name: 'Общая задача: проверка сохранена' }),
    ).toBeVisible();
    let saved = (await workspace()).tasks.find((item) => item.id === task.id)!;
    expect(saved.projectIds?.slice().sort()).toEqual(projectIds.slice().sort());
    const result = {
      summary: 'Общий результат сохранён. '.repeat(30),
      verified: 'Проверено на тестовых данных',
    };
    expect(
      (
        await request.post(`/api/tasks/${saved.id}/complete`, {
          headers,
          data: { revision: saved.revision, result },
        })
      ).ok(),
    ).toBe(true);
    saved = (await workspace()).tasks.find((item) => item.id === task.id)!;
    expect(
      (
        await request.put(`/api/tasks/${saved.id}`, {
          headers,
          data: { ...saved, result: { ...saved.result, summary: result.summary + ' Уточнение.' } },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/');
    await expect(page.locator('#attention')).not.toContainText('Проверьте описание');
    await expect(page.locator('#recent-work .activity').filter({ hasText: task.code })).toHaveCount(
      1,
    );
    await page.getByText(/Проверить описание проектов ·/).click();
    await page.getByRole('link', { name: 'Альфа · Проверить описание →', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Сводка проекта', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Всё актуально — сохранить', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Сводка проекта', exact: true })).toHaveCount(0);
    const reviewed = (await workspace()).projects.find((p) => p.id === alpha.id)!;
    expect(reviewed.metadata.last_reviewed).toBe(dateInZone(new Date(), initial.settings.timezone));
    expect(reviewed.metadata.goal).toBe(alpha.metadata.goal);
    expect(reviewed.signals.some((s) => s.code === 'review')).toBe(false);
    await page.goto('/');
    const tasksY = (await page.locator('.current-work').boundingBox())!.y;
    expect(tasksY).toBeLessThan((await page.locator('#recent-work').boundingBox())!.y);
    await mkdir('.local/work/shared-tasks', { recursive: true });
    await page.screenshot({
      path: '.local/work/shared-tasks/overview-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.local/work/shared-tasks/overview-mobile.png', fullPage: true });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.goto(`/tasks?task=${task.code}`);
    await expect(panel).toContainText('Бета');
    await page.screenshot({ path: '.local/work/shared-tasks/task-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    const tasks: Task[] = (await workspace()).tasks.filter((task) =>
      task.projectIds?.some((id) => projectIds.includes(id)),
    );
    for (const task of tasks) await request.delete(`/api/tasks/${task.id}`, { headers });
    for (const id of projectIds) await request.delete(`/api/projects/${id}`, { headers });
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
