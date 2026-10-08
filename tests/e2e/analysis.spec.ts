import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import { designFixture } from './design-fixture';
import type { AnalysisPreview, AnalysisResult } from '../../shared/analysis';
import type { Workspace } from '../../shared/contracts';

test('selected saved payload → explicit approval → proposals → one edited task; keyboard and wide/narrow layouts', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const repo = await f.repo('analysis-project');
  await writeFile(
    path.join(repo, 'PROJECT.yaml'),
    'name: Проект с длинным названием для проверки переноса и выбора следующего шага\ngoal: Проверить поиск и понять, что мешает основному пользовательскому сценарию\n',
  );
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  await request.put('/api/settings', {
    headers,
    data: { ...initial.settings, roots: [repo], autoRefreshMinutes: 0 },
  });
  const data = (await (await request.get('/api/workspace')).json()) as Workspace;
  const project = data.projects.find((item) => item.path === repo)!;
  const status = {
    ready: true,
    model: 'test-model',
    maxInputBytes: 80000,
    maxOutputTokens: 3000,
    timeoutSeconds: 60,
  };
  let prepared: AnalysisPreview | null = null;
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/analysis/status', (route) => route.fulfill({ json: status }));
  await page.route('**/api/analysis/prepare', async (route) => {
    // Real server constructs the packet from real isolated project/task producers.
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    prepared = { ...(await response.json()), config: status };
    await route.fulfill({ json: prepared });
  });
  await page.route('**/api/analysis/run', async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({ previewId: prepared!.id, consent: true });
    await gate;
    const result: AnalysisResult = {
      previewId: prepared!.id,
      model: 'test-model',
      generatedAt: new Date().toISOString(),
      usage: { inputTokens: 120, outputTokens: 80 },
      report: {
        summary: 'Предложение на основе сохранённой цели. Проверка ещё не выполнялась.',
        proposals: [
          {
            projectId: project.id,
            title: 'Проверить поиск по длинным обращениям',
            description:
              'Проверить понятность выдачи поиска и сохранение выбранных фильтров при повторном открытии списка.',
            expectedResult: 'Человек находит нужное обращение',
            acceptance: 'Поиск и возврат к выдаче проходят',
            priority: 'high',
            reason:
              'В сводке есть цель, но подтверждённый результат отсутствует. <img src=x onerror="window.analysisInjected=true">',
            sources: [`project:${project.id}`],
          },
        ],
      },
    };
    await route.fulfill({ json: result });
  });
  try {
    await page.goto('/');
    await page.getByRole('link', { name: 'Анализ проектов →', exact: true }).click();
    await expect(page).toHaveURL(/\/analysis$/);
    await expect(
      page.getByRole('navigation').getByRole('link', { name: 'Проекты', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(
      page.getByRole('button', { name: 'Просмотреть данные', exact: true }),
    ).toBeDisabled();
    const choice = page.getByRole('checkbox', { name: project.metadata.name });
    await choice.focus();
    await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Просмотреть данные', exact: true }).click();
    const payload = page.getByLabel('Полный пакет данных', { exact: true });
    await expect(payload).toContainText(project.metadata.goal);
    await expect(payload).not.toContainText(repo);
    expect(prepared!.payload.projects.map((item) => item.id)).toEqual([project.id]);
    const send = page.getByRole('button', { name: 'Отправить в OpenAI', exact: true });
    await expect(send).toBeDisabled();
    expect(calls).toBe(0);
    await mkdir('.local/analysis-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(payload).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/analysis-review/preview-${width}.png`,
        fullPage: true,
      });
    }
    const consent = page.getByRole('checkbox', { name: /Я просмотрел данные/ });
    await consent.focus();
    await page.keyboard.press('Space');
    await send.click();
    await expect(send).toBeDisabled();
    await expect(choice).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('Выполняем запрос');
    expect(calls).toBe(1);
    release();
    await expect(page.locator('.proposal')).toHaveCount(1);
    await expect(page.locator('.proposal img')).toHaveCount(0);
    expect(await page.evaluate(() => 'analysisInjected' in window)).toBe(false);
    const before = ((await (await request.get('/api/workspace')).json()) as Workspace).tasks.length;
    const draft = page.locator('.proposal');
    await draft.getByLabel('Название', { exact: true }).fill('Проверить поиск — выбранная задача');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.local/analysis-review/result-${width}.png`, fullPage: true });
    }
    await page.evaluate(() => (document.documentElement.style.fontSize = '20px'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await draft.getByRole('button', { name: 'Создать задачу «Следом»', exact: true }).click();
    const link = draft.getByRole('link', { name: /Открыть CC-/ });
    await expect(link).toBeVisible();
    const after = (await (await request.get('/api/workspace')).json()) as Workspace;
    const created = after.tasks.find(
      (item) => item.title === 'Проверить поиск — выбранная задача',
    )!;
    expect(after.tasks.length).toBe(before + 1);
    expect(created.projectId).toBe(project.id);
    expect(created.state).toBe('next');
    expect(created.priority).toBe('high');
    await expect(draft.getByRole('button')).toHaveCount(0);
    expect(calls).toBe(1);
    await link.click();
    await expect(page.getByLabel('Название задачи')).toHaveValue(created.title);
  } finally {
    release();
    await request.put('/api/settings', {
      headers,
      data: { ...data.settings, roots: [], autoRefreshMinutes: 0 },
    });
    await f.cleanup();
  }
});

test('unconfigured provider, preview failure, lost response and expired consent are visible without silently creating tasks', async ({
  page,
}) => {
  const data = designFixture();
  await page.route('**/api/workspace', (route) => route.fulfill({ json: data }));
  const status = {
    ready: false,
    model: null,
    maxInputBytes: 80000,
    maxOutputTokens: 3000,
    timeoutSeconds: 60,
  };
  await page.route('**/api/analysis/status', (route) => route.fulfill({ json: status }));
  let failPreview = true;
  let runCalls = 0;
  const packet: AnalysisPreview = {
    id: '11111111-1111-4111-8111-111111111111',
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    config: { ...status, ready: true, model: 'test-model' },
    payload: { preparedAt: new Date().toISOString(), projects: [] },
  };
  await page.route('**/api/analysis/prepare', (route) =>
    route.fulfill(
      failPreview
        ? { status: 400, json: { error: 'Уберите секрет из выбранных текстов' } }
        : { json: packet },
    ),
  );
  await page.route('**/api/analysis/run', (route) => {
    runCalls++;
    return route.fulfill({
      status: 502,
      json: { error: 'Ответ не получен. Запрос мог быть оплачен; автоматического повтора нет.' },
    });
  });
  await page.goto('/analysis');
  await expect(page.getByText('OpenAI не настроен', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: new RegExp(data.projects[0].metadata.name) }).check();
  await page.getByRole('button', { name: 'Просмотреть данные', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Анализ проектов', exact: true })).toContainText(
    'Уберите секрет',
  );
  await expect(page.locator('.analysis-preview')).toHaveCount(0);
  failPreview = false;
  await page.getByRole('button', { name: 'Просмотреть данные', exact: true }).click();
  await page.getByRole('checkbox', { name: /Я просмотрел данные/ }).check();
  await page.getByRole('button', { name: 'Отправить в OpenAI', exact: true }).click();
  await expect(page.getByRole('alert', { name: 'Анализ проектов', exact: true })).toContainText(
    'мог быть оплачен',
  );
  expect(runCalls).toBe(1);
  await expect(page.locator('.proposal')).toHaveCount(0);
  packet.expiresAt = new Date(Date.now() - 1000).toISOString();
  await page.getByRole('button', { name: 'Просмотреть данные', exact: true }).click();
  await expect(
    page.getByText('Срок пакета истёк. Подготовьте данные заново.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Я просмотрел данные/ })).not.toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Отправить в OpenAI', exact: true }),
  ).toBeDisabled();
  expect(runCalls).toBe(1);
});
