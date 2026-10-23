import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import type { Review } from '../../shared/reviews';
import type { PeriodRun } from '../../shared/period-analysis';

test('real HTTP Codex import is visible from project analysis, persists on reload and retains manual provenance on desktop/mobile', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    const repo = await f.repo('codex-manual-analysis');
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
        data: { projectId: project.id, kind: 'week', anchorDate: '2024-03-06' },
      })
    ).json()) as Review;
    const requestKey = randomUUID();
    const response = await request.post('/api/period-analysis/import-codex', {
      headers,
      data: {
        purpose: 'project_review',
        projectId: project.id,
        reviewId: review.id,
        requestKey,
        confirm: true,
        context: 'Codex read the synthetic project records. No independent live check took place.',
        report: {
          narrative:
            'Ручной анализ Codex: <b>одна проверка не доказывает надёжность</b>.\n\nРекомендация: проверить совместимость отдельно.',
          findings: [
            {
              statement: 'Остаётся неизвестная совместимость.',
              sources: [`codex_context:${requestKey}`],
            },
          ],
          uncertainties: ['Рабочие данные не проверены.'],
          proposals: [],
        },
      },
    });
    expect(response.status()).toBe(201);
    const run = (await response.json()) as PeriodRun;
    expect(run.origin).toBe('codex_manual');
    expect(run.approvedAt).toBeNull();
    expect(run.usage).toBeNull();
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('link', { name: 'Анализы проекта →', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Анализ проектов', exact: true })).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: project.metadata.name, exact: true }),
    ).toBeChecked();
    const saved = page.getByRole('region', { name: 'Сохранённые анализы проектов' });
    await expect(saved).toContainText(project.metadata.name);
    await expect(saved).toContainText('Codex · внесён вручную');
    await mkdir('.local/codex-import-review', { recursive: true });
    await page.screenshot({ path: '.local/codex-import-review/saved-1440.png', fullPage: true });
    let failRead = true;
    await page.route('**/api/period-analysis/recent*', (route) => {
      if (failRead) {
        failRead = false;
        return route.fulfill({ status: 503, json: { error: 'Synthetic recent read failure' } });
      }
      return route.continue();
    });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(saved.getByRole('alert')).toContainText('Synthetic recent read failure');
    await expect(saved).toContainText('Codex · внесён вручную');
    await saved.getByRole('link', { name: 'Открыть анализ →', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Анализ Codex', exact: true })).toBeVisible();
    const result = page.getByRole('region', { name: 'Сохранённый анализ' });
    await expect(result).toContainText(run.report!.narrative);
    await expect(result).toContainText('API-запрос не выполнялся');
    const grounds = result
      .locator('details')
      .filter({
        has: page.locator('summary', { hasText: 'Основания и существенные ограничения' }),
      });
    await expect(grounds).not.toHaveAttribute('open');
    await expect(
      result.getByText('Остаётся неизвестная совместимость.', { exact: true }),
    ).not.toBeVisible();
    await grounds.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(
      result.getByText('Остаётся неизвестная совместимость.', { exact: true }),
    ).toBeVisible();
    await expect(grounds).toContainText(`codex_context:${requestKey}`);
    await grounds.locator('summary').click();
    const narrativeBox = await result.locator('p.preserve').boundingBox();
    const packetBox = await result
      .getByText('Сохранённые основания и ограничения', { exact: true })
      .boundingBox();
    expect(narrativeBox!.y).toBeLessThan(packetBox!.y);
    await expect(result.locator('p.preserve')).toHaveCSS('white-space', 'pre-wrap');
    await expect(result.locator('b')).toHaveCount(0);
    await expect(
      result.getByRole('button', { name: 'Отправить пакет в OpenAI', exact: true }),
    ).toHaveCount(0);
    await page.reload();
    await expect(result).toContainText(run.report!.narrative);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Анализ Codex', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.local/codex-import-review/report-390.png', fullPage: true });
    await page.route(`**/api/period-analysis/${run.id}`, (route) =>
      route.fulfill({
        json: { ...run, payload: { ...run.payload, origin: { kind: 'codex_manual' } } },
      }),
    );
    await page.reload();
    await expect(result).toContainText('Старый ручной импорт');
    await expect(result.locator('p.preserve')).toHaveText(run.report!.narrative);
    expect((await (await request.get(`/api/reviews/${review.id}`)).json()).userText).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
