import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';
import type { PeriodRun } from '../../shared/period-analysis';

test('primary analysis route keeps selected projects, prepares useful local context in one choice and never reads chats or sends automatically', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  const headers = { 'X-Control-Center': '1' };
  let externalActions = 0;
  page.on('request', (req) => {
    if (
      req.method() === 'POST' &&
      (/\/run$/.test(req.url()) || /codex-context\/(prepare|threads|preview)/.test(req.url()))
    )
      externalActions++;
  });
  try {
    const roots = [];
    for (const name of ['Personal journal', 'Research comparisons', 'Unselected canary']) {
      const root = await f.repo(name.replaceAll(' ', '-'));
      await writeFile(
        path.join(root, 'PROJECT.yaml'),
        `name: ${name}\ntype: tool\ngoal: Understand observations before choosing a direction\n`,
      );
      roots.push(root);
    }
    expect(
      (
        await request.put('/api/settings', {
          headers,
          data: { ...initial.settings, roots, autoRefreshMinutes: 0, timezone: 'UTC' },
        })
      ).ok(),
    ).toBe(true);
    const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
    const projects = roots.map((root) => workspace.projects.find((item) => item.path === root)!);
    for (const project of projects) {
      const review = await (
        await request.post('/api/reviews', {
          headers,
          data: { projectId: project.id, kind: 'month', anchorDate: '2024-02-10' },
        })
      ).json();
      await request.patch(`/api/reviews/${review.id}`, {
        headers,
        data: {
          revision: review.revision,
          userText: `Earlier direction of ${project.metadata.name}`,
        },
      });
      expect(
        (
          await request.post('/api/observations', {
            headers,
            data: {
              projectId: project.id,
              occurredOn: '2024-03-06',
              body: `Observed result of ${project.metadata.name}`,
            },
          })
        ).ok(),
      ).toBe(true);
    }
    await page.goto('/analysis');
    for (const project of projects.slice(0, 2))
      await page.getByRole('checkbox', { name: project.metadata.name, exact: true }).check();
    await page.getByRole('combobox', { name: 'Период обзора', exact: true }).selectOption('month');
    await page.getByLabel('Дата внутри периода').fill('2024-03-06');
    await mkdir('.local/readiness-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole('button', { name: 'Просмотреть данные', exact: true }),
      ).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/readiness-review/analysis-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Подготовить обзор периода' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/period-analysis\?review=/);
    const reviewId = new URL(page.url()).searchParams.get('review')!;
    const currentReview = await (await request.get(`/api/reviews/${reviewId}`)).json();
    expect(
      (
        await request.patch(`/api/reviews/${reviewId}`, {
          headers,
          data: {
            revision: currentReview.revision,
            userText:
              'Я переключился с журнала на сравнение результатов: сначала хочу проверить, какие наблюдения полезны.',
          },
        })
      ).ok(),
    ).toBe(true);
    const form = page.getByRole('form', { name: 'Подготовка ручного анализа' });
    await page
      .getByRole('link', {
        name: 'Выбрать отдельный диалог, исправить итог или отключить чтение →',
      })
      .click();
    await page.getByRole('link', { name: 'К ручному AI-анализу →' }).click();
    for (const project of projects.slice(0, 2))
      await expect(
        form.getByRole('checkbox', { name: project.metadata.name, exact: true }),
      ).toBeChecked();
    await expect(
      form.getByRole('checkbox', { name: projects[2].metadata.name, exact: true }),
    ).not.toBeChecked();
    await form.getByRole('button', { name: 'Выбрать основной набор' }).click();
    await expect(form.getByRole('button', { name: 'Подготовить точный пакет' })).toBeDisabled();
    await form.getByLabel('Разрешаю прочитать выбранные источники', { exact: false }).check();
    const prepared = page.waitForResponse(
      (r) => r.url().endsWith('/api/period-analysis/prepare') && r.request().method() === 'POST',
    );
    await form.getByRole('button', { name: 'Подготовить точный пакет' }).click();
    const response = await prepared;
    expect(response.status()).toBe(201);
    const run = (await response.json()) as PeriodRun;
    expect(run.payload.sources.find((s) => s.id === `review:${reviewId}`)?.text).toContain(
      'Я переключился',
    );
    expect(run.payload.scope.projectIds.sort()).toEqual(
      projects
        .slice(0, 2)
        .map((p) => p.id)
        .sort(),
    );
    for (const project of projects.slice(0, 2)) {
      expect(
        run.payload.sources.some((s) => s.projectId === project.id && s.kind === 'project'),
      ).toBe(true);
      expect(
        run.payload.sources.some(
          (s) => s.projectId === project.id && s.dateQuality === 'background',
        ),
      ).toBe(true);
      expect(JSON.stringify(run.payload)).toContain(`Observed result of ${project.metadata.name}`);
    }
    expect(JSON.stringify(run.payload)).not.toContain('Unselected canary');
    expect(run.selection.codexDigestIds).toEqual([]);
    expect(run.selection.sourceKinds).not.toContain('file_decision');
    expect(run.selection.includeRelatedAnalyses).toBe(false);
    expect(externalActions).toBe(0);
    expect(run.approvedAt).toBeNull();
    // Reopening a saved report from history has no explicit projects query parameter.
    await page.goto(`/period-analysis?review=${reviewId}&run=${run.id}`);
    for (const project of projects.slice(0, 2))
      await expect(
        form.getByRole('checkbox', { name: project.metadata.name, exact: true }),
      ).toBeChecked();
    await expect(page.getByRole('region', { name: 'Сохранённый анализ' })).toContainText(
      'Ожидает подтверждения',
    );
    await expect(page.getByRole('button', { name: 'Отправить пакет в OpenAI' })).toBeDisabled();
    const details = form.getByText('Настроить источники', { exact: true });
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(form.getByLabel('Наблюдения', { exact: true })).toBeVisible();
    expect(externalActions).toBe(0);
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
