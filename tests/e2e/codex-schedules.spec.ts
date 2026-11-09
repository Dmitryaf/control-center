import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { fixture } from '../fixtures';
import { Store } from '../../server/db';
import { createApp } from '../../server/app';
import { Projects } from '../../server/projects/projects';
import { History } from '../../server/history';
import { Observations } from '../../server/observations';
import { PeriodAnalysis } from '../../server/analysis/period-analysis';
import { AnalysisSchedules } from '../../server/analysis/schedules';
import { CodexAnalysis } from '../../server/codex/analysis';
import { CodexAnalysisFixture } from '../codex-analysis-fixture';
import { dateInZone, periodBounds } from '../../shared/periods';

test('default review and explicit Codex schedule work without API keys on desktop/mobile and retain a follow-up', async ({
  page,
}) => {
  const f = await fixture();
  const repo = await f.repo('fictional-neighborhood');
  const store = new Store(path.join(f.root, 'browser.sqlite'));
  store.saveSettings({
    ...store.settings(),
    roots: [repo],
    timezone: 'UTC',
    autoRefreshMinutes: 0,
  });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  let now = Date.now();
  new Observations(store).create({
    projectId: project.id,
    occurredOn: dateInZone(new Date(now), 'UTC'),
    body: 'Сохранили список договорённостей перед встречей.',
  });
  const history = new History(store, projects.decisions);
  const analyses = new PeriodAnalysis(store, history, { key: '', model: '' }, fetch, () => now);
  const executor = new CodexAnalysisFixture();
  const codex = new CodexAnalysis(store, history, analyses, executor, () => now);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const runtime = createApp(store, port, undefined, analyses, undefined, codex);
  const scheduler = new AnalysisSchedules(store, analyses, () => now, undefined, codex);
  runtime.app.use(express.static(path.resolve('dist/client')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')));
  server.on('request', runtime.app);
  const base = `http://127.0.0.1:${port}`;
  try {
    await mkdir('.local/work/codex-periodic-ui', { recursive: true });
    await page.goto(`${base}/analysis?project=${project.id}`);
    const question = page.getByRole('textbox', { name: 'Что хотите обсудить?', exact: true });
    await expect(question).toHaveValue('');
    await question.fill('Как развивается идея?');
    await page
      .locator('.analysis-scope summary')
      .filter({ hasText: /^Неделя/ })
      .click();
    await page.getByLabel('Дата внутри периода').fill('2024-03-06');
    await expect(question).toHaveValue('Как развивается идея?');
    await question.fill('');
    await page.getByText('Промпт анализа по умолчанию', { exact: true }).click();
    await expect(
      page.getByText('Помоги осмыслить развитие выбранных проектов за этот период.', {
        exact: false,
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Просмотреть запрос', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Просмотр запроса Codex' })).toBeVisible();
    expect(executor.prompts.length).toBe(0);
    await expect(
      page.getByRole('heading', { name: 'Разбор проектов за период', exact: true }),
    ).toBeVisible();
    await page.goto(`${base}/analysis?project=${project.id}`);
    await page.getByRole('button', { name: 'Настроить разбор по расписанию' }).click();
    const form = page.locator('#schedule');
    await expect(form).toHaveAttribute('open', '');
    await form.getByRole('combobox', { name: 'Исполнитель анализа' }).selectOption('codex');
    const enable = form.getByRole('button', { name: 'Включить с текущего периода' });
    await expect(enable).toBeDisabled();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await form.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `.local/work/codex-periodic-ui/schedule-${width}.png`,
        fullPage: true,
      });
    }
    await form
      .getByLabel('Разрешаю читать и сохранять выбранные источники для каждого нового периода')
      .check();
    await expect(enable).toBeDisabled();
    await form
      .getByLabel('Разрешаю автоматическую отправку выбранных сведений в Codex', { exact: false })
      .check();
    await enable.focus();
    await page.keyboard.press('Enter');
    await expect(form.getByRole('button', { name: 'Отключить', exact: true })).toBeEnabled();
    expect(executor.prompts.length).toBe(0);
    const grant = runtime.schedules.list().items[0];
    expect(grant.provider).toBe('codex');
    expect(grant.selection.projectIds).toEqual([project.id]);
    await scheduler.tick();
    expect(executor.prompts.length).toBe(0);
    now =
      Date.parse(periodBounds('week', dateInZone(new Date(now), 'UTC'), 'UTC').nextStartAt) + 1000;
    await scheduler.tick();
    await expect
      .poll(() => analyses.recent().items.filter((item) => item.status === 'succeeded').length)
      .toBe(1);
    await scheduler.tick();
    const runId = runtime.schedules.list().items[0].lastRunId!;
    const run = analyses.read(runId);
    expect(run.trigger).toBe('scheduled');
    await page.goto(`${base}/codex-analysis?review=${run.reviewKey}&run=${run.id}`);
    await expect(
      page
        .locator('article.analysis-reading')
        .getByText('Я бы сначала проверил, легко ли вернуться к прошлой записи.', {
          exact: false,
        }),
    ).toBeVisible();
    await page.reload();
    const followup = page.getByRole('textbox', { name: 'Уточняющий вопрос' });
    await followup.fill('Как проверить это одним действием?');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await followup.focus();
      expect(await followup.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
        'none',
      );
      expect(
        await page
          .locator('.analysis-follow-form')
          .evaluate((element) => getComputedStyle(element).outlineStyle),
      ).toBe('solid');
      await page.screenshot({
        path: `.local/work/codex-periodic-ui/report-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('button', { name: 'Подготовить уточнение' }).click();
    expect(executor.prompts.length).toBe(1);
    const preview = page.getByRole('region', { name: 'Просмотр запроса Codex' });
    await preview.getByRole('checkbox').check();
    await preview.getByRole('button', { name: 'Запустить Codex' }).click();
    await expect.poll(() => executor.prompts.length).toBe(2);
    await expect(
      page
        .locator('article.analysis-reading')
        .getByText('Попроси одного человека записать наблюдение', { exact: false }),
    ).toBeVisible();
    expect(executor.loginCalls).toBe(0);
    await page.goto(
      `${base}/analysis-schedules?review=${run.reviewKey}&projects=${project.id}&provider=codex`,
    );
    const settings = page.locator('#schedule');
    await expect(settings.getByRole('button', { name: 'Отключить', exact: true })).toBeEnabled();
    await settings.getByRole('textbox', { name: 'Модель Codex' }).fill('synthetic-model-choice');
    await page.getByRole('link', { name: 'К выбору проектов и периода →' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Продолжить редактирование' })
      .click();
    await expect(page).toHaveURL(/analysis-schedules/);
    await expect(settings.getByRole('textbox', { name: 'Модель Codex' })).toHaveValue(
      'synthetic-model-choice',
    );
    const save = settings.getByRole('button', { name: 'Включить с текущего периода' });
    await expect(save).toBeDisabled();
    await settings
      .getByLabel('Разрешаю читать и сохранять выбранные источники для каждого нового периода')
      .check();
    await settings
      .getByLabel('Разрешаю автоматическую отправку выбранных сведений в Codex', { exact: false })
      .check();
    await save.click();
    await expect.poll(() => runtime.schedules.list().items[0].revision).toBe(2);
    expect(runtime.schedules.list().items[0].model).toBe('synthetic-model-choice');
    const stale = await page.request.post(`${base}/api/analysis-schedules/${grant.id}/disable`, {
      headers: { 'X-Control-Center': '1' },
      data: { revision: 1 },
    });
    expect(stale.status()).toBe(409);
    expect(runtime.schedules.list().items[0].enabled).toBe(true);
    await settings.getByRole('button', { name: 'Отключить', exact: true }).click();
    await expect.poll(() => runtime.schedules.list().items[0].enabled).toBe(false);
    expect(executor.prompts.length).toBe(2);
  } finally {
    await scheduler.stop();
    await runtime.codex.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  }
});
