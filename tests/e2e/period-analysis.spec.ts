import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import type { Review } from '../../shared/reviews';
import type { PeriodRun, PeriodRunPage } from '../../shared/period-analysis';

test('saved period AI flow: actual preview → explicit sending → retained result/reload; unknown retry and deletion on desktop/mobile', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const memory = new Map<string, PeriodRun>();
  let sends = 0,
    losePrepare = true;
  try {
    const repo = await f.repo('period-ai-project');
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
    const review = (await (
      await request.post('/api/reviews', {
        headers,
        data: { projectId: project.id, kind: 'week', anchorDate: '2024-03-10' },
      })
    ).json()) as Review;
    expect(
      (
        await request.patch(`/api/reviews/${review.id}`, {
          headers,
          data: { revision: review.revision, userText: 'My own report must survive AI' },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.post('/api/observations', {
          headers,
          data: {
            projectId: project.id,
            occurredOn: '2024-03-10',
            body: 'Observed obstacle for the period',
          },
        })
      ).ok(),
    ).toBe(true);
    await page.route('**/api/period-analysis/status', (route) =>
      route.fulfill({
        json: {
          ready: true,
          model: 'fixture-model',
          maxInputBytes: 80000,
          maxOutputTokens: 3000,
          timeoutSeconds: 60,
        },
      }),
    );
    await page.route('**/api/period-analysis/prepare', async (route) => {
      // The real API persists a whitelisted preview. Fixture model/status and
      // provider receipts are substituted; Node tests cover durable dispatch.
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      const raw = (await response.json()) as PeriodRun;
      const saved = memory.get(raw.id) ?? {
        ...raw,
        model: 'fixture-model',
        packetHash: createHash('sha256')
          .update(
            JSON.stringify({
              payload: raw.payload,
              model: 'fixture-model',
              policy: raw.payload.policyVersion,
            }),
          )
          .digest('hex'),
      };
      memory.set(saved.id, saved);
      if (losePrepare) {
        losePrepare = false;
        await route.fulfill({
          status: 503,
          json: { error: 'Ответ подготовки потерян после сохранения' },
        });
      } else await route.fulfill({ json: saved });
    });
    await page.route('**/api/reviews/*/analyses*', async (route) => {
      const response = await route.fetch();
      const data = (await response.json()) as PeriodRunPage;
      await route.fulfill({
        json: {
          ...data,
          items: data.items.map((item) => ({ ...item, ...(memory.get(item.id) ?? {}) })),
        },
      });
    });
    await page.route(/\/api\/period-analysis\/[a-f0-9-]+$/, async (route) => {
      if (route.request().method() === 'DELETE') {
        const response = await route.fetch();
        if (response.ok())
          memory.delete(new URL(route.request().url()).pathname.split('/').at(-1)!);
        await route.fulfill({ response });
        return;
      }
      const id = new URL(route.request().url()).pathname.split('/').at(-1)!;
      const saved = memory.get(id);
      if (saved) await route.fulfill({ json: saved });
      else await route.continue();
    });
    await page.route('**/api/period-analysis/*/run', async (route) => {
      sends++;
      const id = new URL(route.request().url()).pathname.split('/').at(-2)!;
      const saved = memory.get(id)!;
      const body = route.request().postDataJSON();
      expect(body).toEqual({ packetHash: saved.packetHash, consent: true });
      const next: PeriodRun =
        sends === 1
          ? {
              ...saved,
              status: 'succeeded',
              approvedAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              usage: { inputTokens: 120, outputTokens: 45 },
              responseId: 'resp_fixture',
              report: {
                narrative: 'Содержательный итог <img src=x onerror=alert(1)>',
                findings: [
                  {
                    statement: 'Есть препятствие, требуется проверка.',
                    sources: [saved.payload.sources[0].id],
                  },
                ],
                uncertainties: ['Нет независимого подтверждения.'],
                proposals: [],
              },
              rawOutput: '{"narrative":"Содержательный итог"}',
            }
          : {
              ...saved,
              status: 'unknown',
              approvedAt: new Date().toISOString(),
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              error: 'Ответ потерян. Запрос мог быть оплачен; автоматического повтора нет.',
            };
      memory.set(id, next);
      await route.fulfill({ json: next });
    });
    await page.goto(`/reviews?id=${review.id}`);
    await page.getByRole('link', { name: 'AI-анализ периода →', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'AI-анализ периода', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подготовить точный пакет' })).toBeDisabled();
    await page
      .getByRole('form', { name: 'Подготовка ручного анализа' })
      .getByText('Настроить источники', { exact: true })
      .click();
    await page
      .getByRole('form', { name: 'Подготовка ручного анализа' })
      .getByLabel('Текущая цель и состояние выбранных проектов', { exact: true })
      .check();
    await page
      .getByRole('form', { name: 'Подготовка ручного анализа' })
      .getByLabel('Наблюдения', { exact: true })
      .check();
    await page.getByLabel('Разрешаю прочитать выбранные источники', { exact: false }).check();
    await page.getByRole('button', { name: 'Подготовить точный пакет' }).click();
    await expect(page.getByRole('alert')).toContainText('Ответ подготовки потерян');
    await expect(
      page.getByRole('region', { name: 'История AI-анализов' }).getByRole('link'),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Подготовить точный пакет' })).toBeEnabled();
    await page.getByRole('button', { name: 'Подготовить точный пакет' }).click();
    await expect(
      page.getByRole('region', { name: 'История AI-анализов' }).getByRole('link'),
    ).toHaveCount(1);
    await expect.poll(() => new URL(page.url()).searchParams.get('run')).toMatch(/^[a-f0-9-]{36}$/);
    const first = new URL(page.url()).searchParams.get('run')!;
    await expect(page.locator('.analysis-packet').first()).toContainText(
      'Observed obstacle for the period',
    );
    await expect(page.locator('.analysis-packet').first()).not.toContainText(repo);
    await expect(page.getByRole('button', { name: 'Отправить пакет в OpenAI' })).toBeDisabled();
    await page.getByLabel('Я просмотрел точный пакет', { exact: false }).check();
    await page.getByRole('button', { name: 'Отправить пакет в OpenAI' }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByText('Содержательный итог <img src=x onerror=alert(1)>', { exact: true }),
    ).toBeVisible();
    expect(await page.locator('img').count()).toBe(0);
    expect(sends).toBe(1);
    await page.reload();
    await expect(
      page.getByText('Содержательный итог <img src=x onerror=alert(1)>', { exact: true }),
    ).toBeVisible();
    expect(sends).toBe(1);
    const own = (await (await request.get(`/api/reviews/${review.id}`)).json()) as Review;
    expect(own.userText).toBe('My own report must survive AI');
    await page
      .getByRole('form', { name: 'Подготовка ручного анализа' })
      .getByText('Настроить источники', { exact: true })
      .click();
    await mkdir('.local/period-analysis-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1100 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/period-analysis-review/result-${width}.png`,
        fullPage: true,
      });
    }
    await page
      .getByRole('form', { name: 'Подготовка ручного анализа' })
      .getByLabel('Текущая цель и состояние выбранных проектов', { exact: true })
      .check();
    await page
      .getByRole('form', { name: 'Подготовка ручного анализа' })
      .getByLabel('Наблюдения', { exact: true })
      .check();
    await page.getByLabel('Разрешаю прочитать выбранные источники', { exact: false }).check();
    await expect(page.getByRole('button', { name: 'Подготовить точный пакет' })).toBeDisabled();
    await page.getByLabel('Понимаю, что новый вариант', { exact: false }).check();
    await page.getByRole('button', { name: 'Подготовить точный пакет' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('run')).not.toBe(first);
    const second = new URL(page.url()).searchParams.get('run')!;
    expect(second).not.toBe(first);
    await expect(page.getByLabel('Я просмотрел точный пакет', { exact: false })).not.toBeChecked();
    await page.getByLabel('Я просмотрел точный пакет', { exact: false }).check();
    await page.getByRole('button', { name: 'Отправить пакет в OpenAI' }).click();
    await expect(page.getByRole('region', { name: 'Сохранённый анализ' })).toContainText(
      'Результат неизвестен',
    );
    await page.reload();
    await expect(page.getByRole('region', { name: 'Сохранённый анализ' })).toContainText(
      'Результат неизвестен',
    );
    expect(sends).toBe(2);
    await expect(page.getByRole('button', { name: 'Отправить пакет в OpenAI' })).toHaveCount(0);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Удалить локальный анализ' }).click();
    await expect(
      page.getByText('Локальная запись анализа удалена.', { exact: true }),
    ).toBeVisible();
    expect((await request.get(`/api/period-analysis/${second}`)).status()).toBe(404);
    expect((await request.get(`/api/reviews/${review.id}`)).ok()).toBe(true);
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
