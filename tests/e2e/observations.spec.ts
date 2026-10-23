import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import type { Observation } from '../../shared/observations';
import type { HistoryPage } from '../../shared/history';

test('observation capture → history → revision conflict → retained project → edit/delete on wide and narrow screens', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  try {
    const repo = await f.repo('observation-project');
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: { ...initial.settings, roots: [repo], autoRefreshMinutes: 0 },
        })
      ).ok(),
    ).toBe(true);
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const project = workspace.projects.find((p) => p.path === repo)!;
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('link', { name: 'Записать наблюдение →', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Проект наблюдения' })).toHaveValue(project.id);
    await page.getByLabel('Дата наблюдения').fill('2020-02-29');
    await page
      .getByLabel('Текст наблюдения')
      .fill('Обнаружено препятствие <img src=x onerror=alert(1)>');
    await page.getByRole('button', { name: 'Сохранить наблюдение', exact: true }).click();
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue('');
    await page.getByRole('link', { name: 'Открыть сохранённую запись →' }).click();
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue(
      'Обнаружено препятствие <img src=x onerror=alert(1)>',
    );
    const id = new URL(page.url()).searchParams.get('id')!;
    const saved = (await (await request.get(`/api/observations/${id}`)).json()) as Observation;
    await page.goto(`/timeline?project=${project.id}&kind=observation`);
    await expect(page.locator('.history-record')).toContainText(
      'Обнаружено препятствие <img src=x onerror=alert(1)>',
    );
    await expect(page.locator('.unified-history img')).toHaveCount(0);
    await page.locator('.history-record').getByRole('link', { name: 'Открыть источник →' }).click();
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue(saved.body);
    await page.getByLabel('Текст наблюдения').fill('Мой несохранённый черновик');
    expect(
      (
        await request.patch(`/api/observations/${id}`, {
          headers,
          data: { revision: saved.revision, body: 'Изменение из другого окна' },
        })
      ).ok(),
    ).toBe(true);
    const refreshed = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/observations/${id}`) && response.request().method() === 'GET',
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue('Мой несохранённый черновик');
    await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия' })).toContainText(
      'Наблюдение уже изменено',
    );
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue('Мой несохранённый черновик');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Загрузить сохранённую запись', exact: true }).click();
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue('Изменение из другого окна');
    await page.getByLabel('Текст наблюдения').fill('Согласованное наблюдение');
    await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Наблюдение сохранено' }),
    ).toBeVisible();
    await mkdir('.local/observations-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(
        `/timeline?project=${project.id}&kind=observation&from=2020-02-29&to=2020-02-29`,
      );
      await expect(page.locator('.history-record')).toHaveCount(1);
      await expect(page.locator('.history-record')).toContainText('Согласованное наблюдение');
      await page
        .locator('.history-record')
        .getByRole('link', { name: 'Открыть источник →' })
        .click();
      await expect(page.getByLabel('Дата наблюдения')).toHaveValue('2020-02-29');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/observations-review/editor-${width}.png`,
        fullPage: true,
      });
    }
    expect((await request.delete(`/api/projects/${project.id}`, { headers, data: {} })).ok()).toBe(
      true,
    );
    const detached = (await (await request.get(`/api/observations/${id}`)).json()) as Observation;
    expect(detached.scopeProjectId).toBe(project.id);
    expect(detached.projectId).toBeNull();
    expect(detached.projectName).toBe(project.metadata.name);
    await page.goto(`/timeline?project=${project.id}&kind=observation`);
    await expect(page.locator('.history-record')).toHaveCount(1);
    await expect(page.locator('.history-record')).toContainText('связь с проектом снята');
    await page.locator('.history-record').getByRole('link', { name: 'Открыть источник →' }).click();
    await expect(page.getByRole('combobox', { name: 'Проект наблюдения' })).toHaveValue(
      '__retained__',
    );
    await page.getByLabel('Текст наблюдения').fill('Уточнение после удаления проекта');
    await page.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Наблюдение сохранено' }),
    ).toBeVisible();
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Удалить наблюдение', exact: true }).click();
    await expect(page.getByLabel('Текст наблюдения')).toHaveValue(
      'Уточнение после удаления проекта',
    );
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Удалить наблюдение', exact: true }).click();
    await expect(page.getByText('Наблюдение удалено.', { exact: true })).toBeVisible();
    expect((await request.get(`/api/observations/${id}`)).status()).toBe(404);
    await page.goto(`/timeline?project=${project.id}&kind=observation`);
    await expect(page.locator('.history-record')).toHaveCount(0);
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});

test('lost observation create response keeps draft, guards navigation and repeats the same request key once', async ({
  page,
  request,
}) => {
  let posts = 0;
  const keys: string[] = [];
  let id = '';
  await page.route('**/api/observations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    keys.push(route.request().postDataJSON().requestKey);
    const response = await route.fetch();
    id = (await response.json()).id;
    if (posts === 1)
      await route.fulfill({ status: 503, json: { error: 'Ответ о сохранении потерян' } });
    else await route.fulfill({ response });
  });
  await page.goto('/observations');
  await page.getByLabel('Дата наблюдения').fill('2020-03-01');
  await page.getByLabel('Текст наблюдения').fill('Общее наблюдение с повтором запроса');
  await page.getByRole('button', { name: 'Сохранить наблюдение', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Ошибка действия' })).toContainText(
    'Ответ о сохранении потерян',
  );
  await expect(page.getByLabel('Текст наблюдения')).toHaveValue(
    'Общее наблюдение с повтором запроса',
  );
  expect(posts).toBe(1);
  await page.getByRole('navigation').getByRole('link', { name: 'Проекты', exact: true }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
  await expect(page).toHaveURL(/\/observations$/);
  await page.getByRole('button', { name: 'Сохранить наблюдение', exact: true }).click();
  await expect(page.getByLabel('Текст наблюдения')).toHaveValue('');
  expect(posts).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  const history = (await (
    await request.get('/api/history?kind=observation&projectId=__unlinked__')
  ).json()) as HistoryPage;
  expect(history.items.filter((entry) => entry.sourceId === id)).toHaveLength(1);
  expect(history.items.find((entry) => entry.sourceId === id)?.scopeProjectId).toBeNull();
  await page.getByRole('link', { name: 'Наблюдения в истории →' }).click();
  await expect(
    page.locator('.history-record').filter({ hasText: 'Общее наблюдение с повтором запроса' }),
  ).toHaveCount(1);
});
