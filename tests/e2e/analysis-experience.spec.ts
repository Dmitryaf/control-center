import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import express from 'express';
import { fixture } from '../fixtures';
import { Store } from '../../server/db';
import { Projects } from '../../server/projects/projects';
import { Tasks } from '../../server/tasks';
import { History } from '../../server/history';
import { PeriodAnalysis } from '../../server/analysis/period-analysis';
import { CodexAnalysis } from '../../server/codex/analysis';
import { CodexAnalysisFixture } from '../codex-analysis-fixture';
import { createApp } from '../../server/app';
import { Reviews } from '../../server/reviews';
import { CodexContext } from '../../server/codex/context';
import { codexFixture } from '../codex-fixture';
import { coreSelection, emptySelection } from '../../src/features/period-analysis/SourceSelection';

test('readable request, visible waiting, retained follow-up and explicit period change', async ({
  page,
}) => {
  const f = await fixture();
  const store = new Store(':memory:');
  await f.repo('equipment-catalogue');
  await f.repo('shift-planner');
  store.saveSettings({
    ...store.settings(),
    roots: [f.root],
    timezone: 'UTC',
    autoRefreshMinutes: 0,
  });
  const projects = new Projects(store);
  await projects.scan();
  const selected = projects.list();
  const task = new Tasks(store).save({
    projectId: selected[0].id,
    title: 'Search by equipment number',
    completedAt: '2024-03-07T12:00:00Z',
    result: { summary: 'Equipment can be found by its inventory number.' },
  });
  store.db
    .prepare('UPDATE task_history SET recorded_at=? WHERE task_id=?')
    .run('2024-03-07T12:00:00Z', task.id);
  const history = new History(store, projects.decisions);
  const analyses = new PeriodAnalysis(store, history, { key: '', model: '' });
  const executor = new CodexAnalysisFixture();
  executor.mode = 'wait';
  const codex = new CodexAnalysis(store, history, analyses, executor);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const runtime = createApp(store, port, undefined, analyses, undefined, codex);
  runtime.app.use(express.static(path.resolve('dist/client')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')));
  server.on('request', runtime.app);
  const base = `http://127.0.0.1:${port}`;
  await mkdir('.local/work/analysis-ux-2026-11-09', { recursive: true });
  try {
    await page.goto(`${base}/analysis?projects=${selected.map((project) => project.id).join(',')}`);
    await page
      .locator('.analysis-scope summary')
      .filter({ hasText: /^Неделя/ })
      .click();
    await page.getByLabel('Дата внутри периода').fill('2024-03-12');
    await page.getByRole('button', { name: 'Просмотреть запрос', exact: true }).click();
    const preview = page.getByRole('region', { name: 'Просмотр запроса Codex' });
    await expect(preview.getByText('11.03.2024 — 17.03.2024', { exact: false })).toBeVisible();
    await expect(
      preview.getByRole('heading', { name: 'equipment-catalogue', exact: true, level: 4 }),
    ).toBeVisible();
    await expect(preview.locator('.request-chat-state').first()).toContainText(
      'Чаты не подключены',
    );
    await expect(
      preview.getByRole('heading', { name: 'shift-planner', exact: true, level: 4 }),
    ).toBeVisible();
    await expect(preview.getByText('Предыстория · 1', { exact: true })).toBeVisible();
    await preview
      .locator('.request-project')
      .filter({
        has: page.getByRole('heading', {
          name: selected[0].metadata.name,
          exact: true,
          level: 4,
        }),
      })
      .getByText('Прочитать данные проекта')
      .click();
    await expect(
      preview.getByText('Equipment can be found by its inventory number.', { exact: true }),
    ).toBeVisible();
    expect(executor.prompts.length).toBe(0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/work/analysis-ux-2026-11-09/preview-${width}.png`,
        fullPage: true,
      });
    }
    await preview.getByRole('checkbox', { name: /^Я просмотрел контекст/ }).check();
    await preview.getByRole('button', { name: 'Запустить Codex' }).click();
    const progress = page.getByRole('region', { name: 'Ход анализа' });
    await expect(progress.getByRole('progressbar', { name: 'Выполняется анализ' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Codex работает', exact: true })).toHaveCount(1);
    await expect(progress.getByText(/Прошло /)).toBeVisible();
    await expect(progress.getByRole('button', { name: 'Остановить анализ' })).toBeEnabled();
    await expect(progress.locator('.analysis-elapsed')).toHaveText(/Прошло 0:0[1-9]/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/work/analysis-ux-2026-11-09/running-${width}.png`,
        fullPage: true,
      });
    }
    await page.screenshot({
      path: '.local/work/analysis-ux-2026-11-09/running.png',
      fullPage: true,
    });
    executor.release!();
    await expect(page.locator('article.analysis-reading')).toHaveCount(1);
    await expect(progress).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Уточняющий вопрос' }).fill('Какой первый шаг?');
    await page.getByRole('button', { name: 'Подготовить уточнение' }).click();
    await preview.getByRole('checkbox', { name: /^Я просмотрел контекст/ }).check();
    await preview.getByRole('button', { name: 'Запустить Codex' }).click();
    await expect(progress).toBeVisible();
    await expect(page.locator('article.analysis-reading')).toHaveCount(1);
    await expect(page.locator('article.analysis-reading').first()).toBeVisible();
    executor.release!();
    await expect(page.locator('article.analysis-reading')).toHaveCount(2);
    await expect(page.locator('article.analysis-reading').first()).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page
        .locator('.analysis-result')
        .last()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe('none');
    await page.getByRole('link', { name: 'Изменить период или проекты' }).click();
    await expect(page).toHaveURL(/\/analysis\?/);
    await expect(
      page.getByRole('textbox', { name: 'Что хотите обсудить?', exact: true }),
    ).toHaveValue('Какой первый шаг?');
    await page
      .locator('.analysis-scope summary')
      .filter({ hasText: /^Неделя/ })
      .click();
    await page.getByRole('combobox', { name: /^Период обзора/ }).selectOption('month');
    await page.getByRole('button', { name: 'Просмотреть запрос', exact: true }).click();
    await expect(page).toHaveURL(/\/codex-analysis\?.*run=/);
    const runId = new URL(page.url()).searchParams.get('run')!;
    expect(analyses.read(runId).payload.period.kind).toBe('month');
    expect(analyses.read(runId).selection.projectIds).toEqual(
      selected.map((project) => project.id).sort(),
    );
    expect(executor.prompts.length).toBe(2);
    await expect(
      preview.getByRole('checkbox', { name: /^Я просмотрел контекст/ }),
    ).not.toBeChecked();
  } finally {
    executor.release?.();
    await runtime.codex.stop();
    await codex.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  }
});

test('adding chat excerpts rebuilds the frozen preview and requires new send approval', async ({
  page,
}) => {
  const f = await fixture();
  const repo = await f.repo('demo-notes');
  const store = new Store(':memory:');
  store.saveSettings({
    ...store.settings(),
    roots: [repo],
    timezone: 'UTC',
    autoRefreshMinutes: 0,
  });
  const projects = new Projects(store);
  await projects.scan();
  const project = projects.list()[0];
  store.saveMetadata(
    project.id,
    { ...project.metadata, goal: 'Keep a useful record.\n\nReturn to it later.' },
    '',
  );
  const review = new Reviews(store).create({
    projectId: project.id,
    kind: 'week',
    anchorDate: '2024-03-06',
  });
  const history = new History(store, projects.decisions);
  const analyses = new PeriodAnalysis(store, history, { key: '', model: '' });
  const executor = new CodexAnalysisFixture();
  const codex = new CodexAnalysis(store, history, analyses, executor);
  const fake = codexFixture(repo);
  fake.state.updatedAt = Date.parse('2024-03-08T12:00:00Z') / 1000;
  const context = new CodexContext(store, fake.transport);
  const run = await codex.prepare({
    reviewId: review.id,
    requestKey: crypto.randomUUID(),
    selection: coreSelection(emptySelection(project.id)),
    readConsent: true,
  });
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const runtime = createApp(store, port, undefined, analyses, context, codex);
  runtime.app.use(express.static(path.resolve('dist/client')));
  runtime.app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/client/index.html')));
  server.on('request', runtime.app);
  try {
    await page.goto(`http://127.0.0.1:${port}/codex-analysis?review=${review.id}&run=${run.id}`);
    const preview = page.getByRole('region', { name: 'Просмотр запроса Codex' });
    const consent = preview.getByRole('checkbox', { name: /^Я просмотрел контекст/ });
    await consent.check();
    await preview.getByText('Добавить выдержки чатов проектов', { exact: true }).click();
    await preview.getByRole('checkbox', { name: /^Разрешаю читать диалоги/ }).check();
    await preview.getByRole('button', { name: 'Подготовить контекст выбранных проектов' }).click();
    await expect(
      preview.getByRole('button', { name: 'Обновить запрос', exact: true }),
    ).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Запустить Codex' })).toBeDisabled();
    await expect(consent).not.toBeChecked();
    await preview.getByRole('button', { name: 'Обновить запрос', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`run=${run.id}`));
    await expect(preview.locator('.request-chat-state')).toContainText('Чаты в запросе · 1');
    await expect(consent).not.toBeChecked();
    await preview.getByText('Прочитать данные проекта', { exact: true }).click();
    await expect(preview.getByText(`Вы: ${fake.state.text}`, { exact: false })).toBeVisible();
    await expect(preview).not.toContainText('[object Object]');
    expect(analyses.read(run.id).status).toBe('cancelled');
    expect(context.grant(project.id).enabled).toBe(true);
    expect(executor.prompts.length).toBe(0);
  } finally {
    await context.stop();
    await runtime.codex.stop();
    await codex.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await f.cleanup();
  }
});
