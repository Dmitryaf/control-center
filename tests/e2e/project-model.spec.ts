import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace, Task } from '../../shared/contracts';

test('new, active, busy and paused projects explain work with bounded lists and real actions on desktop/mobile', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const original = (await (await request.get('/api/workspace')).json()) as Workspace;
  const names = ['Первый сад', 'Дневник растений', 'Большой сад', 'Зимняя пауза'];
  const paths: string[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const repo = path.join(f.root, 'garden-' + i);
      await mkdir(repo); // Ordinary directories without Git or PROJECT.yaml are supported.
      await writeFile(path.join(repo, 'package.json'), '{"name":"garden-notes"}');
      paths.push(repo);
    }
    await request.put('/api/settings', {
      headers,
      data: { ...original.settings, roots: paths, autoRefreshMinutes: 0 },
    });
    const w = (await (await request.get('/api/workspace')).json()) as Workspace;
    const projects = paths.map((p) => w.projects.find((item) => item.path === p)!);
    const allTasks: Task[][] = [[], [], [], []];
    for (const [index, project] of projects.entries()) {
      expect(project).toBeTruthy();
      await request.put(`/api/projects/${project.id}`, {
        headers,
        data: {
          metadata: {
            ...project.metadata,
            name: names[index],
            goal: 'Понимать, как условия ухода влияют на растения.',
            status: index === 3 ? 'paused' : 'active',
          },
          notes: '',
        },
      });
      for (let n = 0; n < [0, 3, 25, 0][index]; n++) {
        const response = await request.post('/api/tasks', {
          headers,
          data: {
            projectId: project.id,
            title: `Проверить условие ухода ${n + 1}`,
            priority: n % 3 === 0 ? 'high' : 'normal',
          },
        });
        expect(response.ok()).toBe(true);
        allTasks[index].push(await response.json());
      }
      if (index > 0) {
        const result = await request.post('/api/tasks', {
          headers,
          data: {
            projectId: project.id,
            title: 'Сравнить записи полива',
            completedAt: '2026-10-20T10:00:00Z',
            result: {
              summary: 'Проверили записи за неделю: пропуски стали заметны.',
              verified: 'Сопоставили журнал и фотографии.',
            },
          },
        });
        expect(result.ok()).toBe(true);
        const decision = await request.post('/api/decisions', {
          headers,
          data: {
            projectId: project.id,
            title: 'Сохранить простой дневник',
            decision: 'Записывать наблюдения вручную, без автоматизации.',
            reason: 'Пока достаточно коротких записей.',
            date: '2026-10-19',
            status: 'active',
          },
        });
        expect(decision.ok()).toBe(true);
        for (let n = 0; n < (index === 2 ? 30 : 2); n++)
          await request.post('/api/observations', {
            headers,
            data: {
              projectId: project.id,
              occurredOn: '2026-10-20',
              body: `Наблюдение ${n + 1}: после изменения полива листья стали плотнее. Проверим это ещё на двух растениях.`,
            },
          });
        const r = await (
          await request.post('/api/reviews', {
            headers,
            data: { projectId: project.id, kind: 'week', anchorDate: '2026-10-20' },
          })
        ).json();
        await request.patch(`/api/reviews/${r.id}`, {
          headers,
          data: {
            revision: r.revision,
            userText:
              index === 3
                ? 'Работу отложили до весны. Сохранили результаты прошлого сезона.'
                : 'Удалось наладить запись наблюдений. Дальше сравним два режима полива.',
          },
        });
        // An empty newer draft must not replace the latest meaningful review.
        await request.post('/api/reviews', {
          headers,
          data: { projectId: project.id, kind: 'week', anchorDate: '2026-10-26' },
        });
      }
    }
    await mkdir('.local/product-model-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [index, project] of projects.entries()) {
        await page.goto('/projects');
        await page.getByRole('searchbox', { name: 'Поиск проектов' }).fill(names[index]);
        await page.getByRole('link', { name: names[index], exact: true }).click();
        await expect(page.getByRole('heading', { level: 1, name: names[index] })).toBeVisible();
        for (const name of ['О проекте', 'Что происходило', 'Итоги и развитие'])
          await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
        const taskList = page.locator('.project-simple .compact-list').first();
        await expect(taskList.getByRole('link')).toHaveCount(Math.min(5, allTasks[index].length));
        if (index === 2) {
          const expected = allTasks[index].filter((t) => t.priority === 'high').slice(0, 5);
          expect(await taskList.getByRole('link').allTextContents()).toEqual(
            expected.map((t) => `${t.code} · ${t.title}`),
          );
        }
        if (index === 0)
          await expect(page.getByText('Итогов пока нет.', { exact: false })).toBeVisible();
        else
          await expect(page.locator('.latest-review')).toContainText(
            index === 3 ? 'Работу отложили' : 'Удалось наладить',
          );
        if (index === 3)
          await expect(
            page.getByRole('heading', { name: 'Требуют внимания', exact: true }),
          ).toHaveCount(0);
        await expect(page.locator('.recent-work-list > li')).toHaveCount(index === 0 ? 0 : 5);
        await expect(
          page.getByRole('button', { name: 'Настройки проекта', exact: true }),
        ).toHaveAttribute('aria-expanded', 'false');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: `.local/product-model-review/project-${index}-${width}.png`,
          fullPage: true,
        });
      }
    }
    const project = projects[0];
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Изменить сводку' }).click();
    await expect(page.getByLabel('Связанные имена для PROJECT.yaml')).toBeHidden();
    await page
      .getByLabel('Зачем существует', { exact: true })
      .fill('Сравнивать результаты ухода без сложных таблиц.');
    await page.getByRole('button', { name: 'Сохранить сводку', exact: true }).click();
    await page.reload();
    await expect(
      page.getByText('Сравнивать результаты ухода без сложных таблиц.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Добавить задачу →' }).focus();
    await page.keyboard.press('Enter');
    await page.getByLabel('Название задачи', { exact: true }).fill('Записать полив');
    await page.getByLabel('Название задачи', { exact: true }).press('Enter');
    await expect(page.getByRole('status')).toContainText('Задача');
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('link', { name: /CC-\d+ · Записать полив/ })).toBeVisible();
    await page.getByRole('link', { name: 'Записать наблюдение', exact: true }).click();
    await page.getByLabel('Текст наблюдения').fill('Почва высыхает быстрее возле окна.');
    await page.getByRole('button', { name: 'Сохранить наблюдение', exact: true }).click();
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('region', { name: 'Последние записи проекта' })).toContainText(
      'Почва высыхает',
    );
    await page.getByRole('link', { name: 'Подвести итоги недели', exact: true }).click();
    await expect(page.getByLabel('Проект обзора')).toHaveValue(project.id);
  } finally {
    await request.put('/api/settings', { headers, data: original.settings });
    await f.cleanup();
  }
});
