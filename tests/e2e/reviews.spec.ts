import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import type { Review, RelatedReviews } from '../../shared/reviews';
import type { HistoryPage } from '../../shared/history';

test('project week → conflict/draft recovery → month links → frozen timezone → retained project and deletion', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const repo = await f.repo('review-project');
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: {
            ...initial.settings,
            roots: [repo],
            timezone: 'America/New_York',
            autoRefreshMinutes: 0,
          },
        })
      ).ok(),
    ).toBe(true);
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const project = workspace.projects.find((p) => p.path === repo)!;
    expect(
      (
        await request.post('/api/observations', {
          headers,
          data: {
            projectId: project.id,
            body: 'A dated source for the month',
            occurredOn: '2024-10-02',
          },
        })
      ).ok(),
    ).toBe(true);
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('link', { name: 'Подвести итоги недели', exact: true }).click();
    await expect(page.getByLabel('Проект обзора')).toHaveValue(project.id);
    await page.getByLabel('Дата внутри периода').fill('2024-10-01');
    await page.getByRole('button', { name: 'Открыть обзор', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Обзор недели', exact: true })).toBeVisible();
    const id = new URL(page.url()).searchParams.get('id')!;
    const read = async () => (await (await request.get(`/api/reviews/${id}`)).json()) as Review;
    const created = await read();
    expect(created.periodStart).toBe('2024-09-30');
    expect(created.periodEnd).toBe('2024-10-06');
    expect(created.timezone).toBe('America/New_York');
    await page.getByLabel('Текст обзора').fill('Мой итог <img src=x onerror=alert(1)>');
    await page.getByRole('link', { name: 'Обзоры в истории →', exact: true }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
    await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Обзор сохранён' })).toBeVisible();
    await page.getByLabel('Текст обзора').fill('Мой несохранённый черновик');
    const remote = await read();
    expect(
      (
        await request.patch(`/api/reviews/${id}`, {
          headers,
          data: { revision: remote.revision, userText: 'Изменено во второй вкладке' },
        })
      ).ok(),
    ).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByLabel('Текст обзора')).toHaveValue('Мой несохранённый черновик');
    await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Обзор уже изменён');
    await expect(page.getByLabel('Текст обзора')).toHaveValue('Мой несохранённый черновик');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Загрузить сохранённый обзор' }).click();
    await expect(page.getByLabel('Текст обзора')).toHaveValue('Изменено во второй вкладке');
    await page.getByLabel('Текст обзора').fill('Согласованный недельный итог');
    await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Обзор сохранён');
    const lastWeek = (await (
      await request.post('/api/reviews', {
        headers,
        data: { projectId: project.id, kind: 'week', anchorDate: '2024-10-31' },
      })
    ).json()) as Review;
    const month = (await (
      await request.post('/api/reviews', {
        headers,
        data: { projectId: project.id, kind: 'month', anchorDate: '2024-10-15' },
      })
    ).json()) as Review;
    await page.goto(`/reviews?id=${month.id}`);
    await expect(page.getByRole('heading', { name: 'Обзор месяца', exact: true })).toBeVisible();
    await expect(page.getByLabel('Текст обзора')).toHaveValue('');
    await expect(
      page
        .getByRole('region', { name: 'Связанные обзоры' })
        .getByText('Пересекает границу периода', { exact: false }),
    ).toHaveCount(2);
    await expect(page.getByRole('region', { name: 'События периода' })).toContainText(
      'A dated source for the month',
    );
    const linked = (await (
      await request.get(`/api/reviews/${month.id}/related`)
    ).json()) as RelatedReviews;
    expect(new Set(linked.items.map((r) => r.id))).toEqual(new Set([id, lastWeek.id]));
    await page.getByLabel('Текст обзора').fill('Свободный итог месяца. '.repeat(30));
    await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Обзор сохранён');
    const current = (await (await request.get('/api/workspace')).json()) as Workspace;
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: { ...current.settings, timezone: 'Europe/Berlin' },
        })
      ).ok(),
    ).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('.subtitle')).toContainText('America/New_York');
    const same = (await (
      await request.post('/api/reviews', {
        headers,
        data: { projectId: project.id, kind: 'month', anchorDate: '2024-10-01' },
      })
    ).json()) as Review;
    expect(same.id).toBe(month.id);
    expect(same.timezone).toBe('America/New_York');
    await mkdir('.local/reviews-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      await expect(
        page.getByRole('button', { name: 'Сохранить обзор', exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.local/reviews-review/month-${width}.png`, fullPage: true });
    }
    await page.getByRole('link', { name: 'Открыть историю периода →', exact: true }).click();
    await expect(page.getByText('Часовой пояс: America/New_York.', { exact: false })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Обзор месяца', exact: false }).first(),
    ).toBeVisible();
    const data = (await (
      await request.get(`/api/history?projectId=${project.id}&kind=review`)
    ).json()) as HistoryPage;
    expect(data.items.filter((e) => e.sourceId === month.id)).toHaveLength(1);
    await page.goto(`/reviews?id=${month.id}`);
    expect((await request.delete(`/api/projects/${project.id}`, { headers, data: {} })).ok()).toBe(
      true,
    );
    await page.reload();
    await expect(page.getByText('Живая связь с проектом снята.', { exact: false })).toBeVisible();
    await expect(page.locator('.section-label')).toContainText('review-project');
    await page.getByLabel('Текст обзора').fill('Итог прежнего проекта');
    await page.getByRole('button', { name: 'Сохранить обзор', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Обзор сохранён');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Удалить обзор', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Обзор месяца', exact: true })).toBeVisible();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Удалить обзор', exact: true }).click();
    await expect(page.getByText('Обзор удалён.', { exact: true })).toBeVisible();
    expect((await request.get(`/api/reviews/${month.id}`)).status()).toBe(404);
    expect(errors).toEqual([]);
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});

test('lost create response opens one general document, settings validates zone and current period is incomplete', async ({
  page,
  request,
}) => {
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const day = '2035-05-17';
  try {
    await page.goto('/settings');
    await page.getByLabel('Часовой пояс истории и обзоров').fill('not/a-zone');
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('alert')).toContainText('часовой пояс IANA');
    await page.getByLabel('Часовой пояс истории и обзоров').fill('Asia/Yekaterinburg');
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    await page.goto(`/reviews?day=${day}`);
    await page.route(
      '**/api/reviews',
      async (route) => {
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.fulfill({ status: 503, json: { error: 'Ответ потерян после создания' } });
      },
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Открыть обзор', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Ответ потерян');
    await expect(page.getByLabel('Дата внутри периода')).toHaveValue(day);
    await page.getByRole('button', { name: 'Открыть обзор', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Обзор недели', exact: true })).toBeVisible();
    await expect(page.getByText('Период ещё не начался.', { exact: true })).toBeVisible();
    const id = new URL(page.url()).searchParams.get('id')!;
    const same = (await (
      await request.post('/api/reviews', { headers, data: { kind: 'week', anchorDate: day } })
    ).json()) as Review;
    expect(same.id).toBe(id);
    expect(same.scopeKey).toBe('general');
    const events = (await (
      await request.get('/api/history?kind=review&from=2035-05-14&to=2035-05-20')
    ).json()) as HistoryPage;
    expect(events.items.filter((e) => e.sourceId === id)).toHaveLength(1);
    const currentDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Yekaterinburg',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const current = (await (
      await request.post('/api/reviews', {
        headers,
        data: { kind: 'month', anchorDate: currentDay },
      })
    ).json()) as Review;
    await page.goto(`/reviews?id=${current.id}`);
    await expect(
      page.getByText('Период ещё не закончился. Итог пока неполный.', { exact: true }),
    ).toBeVisible();
    await page.getByLabel('Текст обзора').fill('Draft during source read error');
    await page.route('**/api/reviews/*/history*', (route) =>
      route.fulfill({ status: 503, json: { error: 'Источники недоступны' } }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      page.getByRole('region', { name: 'События периода' }).getByRole('alert'),
    ).toContainText('Источники недоступны');
    await expect(page.getByLabel('Текст обзора')).toHaveValue('Draft during source read error');
    await page.unroute('**/api/reviews/*/history*');
    await page.getByRole('button', { name: 'Повторить загрузку событий' }).click();
    await expect(
      page.getByRole('region', { name: 'События периода' }).getByRole('alert'),
    ).toHaveCount(0);
    await page.getByLabel('Текст обзора').focus();
    await page.getByLabel('Текст обзора').press('Tab');
    await expect(page.getByRole('button', { name: 'Сохранить обзор', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Обзор сохранён' })).toBeVisible();
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
  }
});
