import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace, Task } from '../../shared/contracts';

test('simple project and task list expose useful work without legacy scheduling controls or technical panels', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const headers = { 'X-Control-Center': '1' };
  try {
    const repo = await f.repo('garden-notes');
    await writeFile(
      path.join(repo, 'PROJECT.yaml'),
      'name: Садовый дневник\nstatus: active\ngoal: Записывать уход за растениями и понимать, что помогает им расти.\nstage: Проверяем первый сценарий\n',
    );
    await request.put('/api/settings', {
      headers,
      data: { ...initial.settings, roots: [repo], autoRefreshMinutes: 0 },
    });
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const project = workspace.projects.find((p) => p.path === repo)!;
    const tasks: Task[] = [];
    for (const index of [0, 1, 2]) {
      const response = await request.post('/api/tasks', {
        headers,
        data: {
          projectId: project.id,
          title: [
            'Записать первый полив',
            'Проверить запись без интернета',
            'Обсудить дневник с садоводом',
          ][index],
        },
      });
      expect(response.ok()).toBe(true);
      tasks.push(await response.json());
    }
    await request.post('/api/observations', {
      headers,
      data: {
        projectId: project.id,
        occurredOn: '2026-10-25',
        body: 'Первую запись удалось сделать на телефоне. Дальше проверим работу без интернета.',
      },
    });
    await mkdir('.local/simplify-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/projects/${project.id}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Садовый дневник' })).toBeVisible();
      await expect(page.locator('.overview-shortcuts')).toHaveCount(0);
      await expect(page.locator('.project-settings')).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Источники контекста' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Удалить из Control Center' })).toBeHidden();
      await expect(
        page.getByText('Метаданные ещё не пересматривались', { exact: true }),
      ).toBeHidden();
      for (const task of tasks)
        await expect(
          page.getByRole('link', { name: `${task.code} · ${task.title}`, exact: true }),
        ).toHaveCount(1);
      await expect(page.getByRole('region', { name: 'Последние записи проекта' })).toContainText(
        'Первую запись',
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/simplify-review/project-${width}.png`,
        fullPage: true,
      });
      await page.getByText('Настройки проекта', { exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Источники контекста' })).toBeVisible();
      await expect(page.getByText('Дополнительные каталоги решений', { exact: true })).toHaveCount(
        0,
      );
      await page.goto(`/tasks?project=${project.id}`);
      await expect(page.locator('.task-card')).toHaveCount(3);
      await expect(page.getByRole('combobox', { name: 'Когда', exact: true })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Состояние', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: /Следом|Позже|Сейчас/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.local/simplify-review/tasks-${width}.png`, fullPage: true });
    }
    const later = tasks[2];
    await page.goto(`/tasks?task=${later.code}`);
    await page
      .getByLabel('Название задачи', { exact: true })
      .fill('Обсудить первый опыт использования');
    await page.getByRole('button', { name: 'Сохранить задачу', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Задача сохранена');
    const after = (await (await request.get('/api/workspace')).json()) as Workspace;
    expect(
      Object.hasOwn(
        after.tasks.find((t) => t.id === later.id)!,
        'state',
      ),
    ).toBe(false);
    expect(after.tasks.find((t) => t.id === later.id)?.title).toBe(
      'Обсудить первый опыт использования',
    );
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
