import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AnalysisSchedule } from '../../shared/analysis-schedules';
import type { Review } from '../../shared/reviews';

test('schedule consent is separate from manual preview; saved policy can be inspected and disabled on mobile', async ({
  page,
  request,
}) => {
  const headers = { 'X-Control-Center': '1' };
  const review = (await (
    await request.post('/api/reviews', {
      headers,
      data: { projectId: null, kind: 'month', anchorDate: '2011-02-01' },
    })
  ).json()) as Review;
  let policy: AnalysisSchedule | null = null,
    enables = 0;
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
  await page.route(`**/api/reviews/${review.id}/schedule`, (route) =>
    route.fulfill({ json: policy }),
  );
  await page.route('**/api/analysis-schedules', (route) => {
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { items: policy ? [policy] : [], nextCursor: null } });
    const data = route.request().postDataJSON();
    expect(data.readConsent).toBe(true);
    expect(data.sendConsent).toBe(true);
    expect(data.expectedModel).toBe('fixture-model');
    expect(data.selection.includeGeneral).toBe(true);
    expect(data.selection.sourceKinds).toEqual(['observation']);
    expect(data.selection.includeRelatedAnalyses).toBe(false);
    enables++;
    policy = {
      id: randomUUID(),
      scopeKey: 'general',
      projectName: null,
      kind: 'month',
      timezone: review.timezone,
      model: 'fixture-model',
      selection: data.selection,
      revision: 1,
      enabled: true,
      nextPeriodStart: '2026-10-01',
      lastRunId: null,
      lastRunReviewKey: null,
      note: null,
      updatedAt: new Date().toISOString(),
    };
    return route.fulfill({ json: policy });
  });
  await page.route('**/api/analysis-schedules/*/disable', (route) => {
    expect(route.request().postDataJSON().revision).toBe(policy!.revision);
    policy = {
      ...policy!,
      enabled: false,
      revision: policy!.revision + 1,
      note: 'Отключено пользователем.',
    };
    return route.fulfill({ json: policy });
  });
  try {
    await page.goto(`/period-analysis?review=${review.id}`);
    await page.getByText('Автоматический анализ завершённых периодов', { exact: true }).click();
    const form = page
      .locator('details')
      .filter({ has: page.getByRole('button', { name: 'Включить с текущего периода' }) });
    const enable = form.getByRole('button', { name: 'Включить с текущего периода' });
    await expect(enable).toBeDisabled();
    await form.getByLabel('Общие и отвязанные записи без проекта', { exact: true }).check();
    await form.getByText('Настроить источники', { exact: true }).click();
    await form.getByLabel('Наблюдения', { exact: true }).check();
    await form
      .getByLabel('Разрешаю читать и сохранять выбранные источники для каждого нового периода')
      .check();
    await expect(enable).toBeDisabled();
    await form
      .getByLabel('Разрешаю автоматическую отправку выбранных сведений в OpenAI', { exact: false })
      .check();
    await enable.click();
    await expect(form.getByRole('button', { name: 'Отключить', exact: true })).toBeEnabled();
    expect(enables).toBe(1);
    await page.reload();
    await page.getByText('Автоматический анализ завершённых периодов', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Включить с текущего периода' })).toBeDisabled();
    expect(enables).toBe(1);
    await page.getByRole('link', { name: 'Все расписания →' }).click();
    await expect(page.getByRole('heading', { name: 'Расписания AI-анализа' })).toBeVisible();
    await mkdir('.local/schedules-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/schedules-review/schedules-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Отключить', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Отключено пользователем.', { exact: false })).toBeVisible();
    expect(enables).toBe(1);
  } finally {
    await request.delete(`/api/reviews/${review.id}`, {
      headers,
      data: { revision: review.revision },
    });
  }
});
