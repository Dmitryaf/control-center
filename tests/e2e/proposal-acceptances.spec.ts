import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Store } from '../../server/db';
import { Projects } from '../../server/projects/projects';
import { History } from '../../server/history';
import { Reviews } from '../../server/reviews';
import { PeriodAnalysis } from '../../server/analysis/period-analysis';
import type { Workspace } from '../../shared/contracts';
import type { ProposalApproval, ProposalAcceptance } from '../../shared/proposal-acceptances';

test('persisted AI proposal → protected human draft → real atomic task/idea acceptance; lost response, reload and retained evidence', async ({
  page,
  request,
}) => {
  const headers = { 'X-Control-Center': '1' };
  const workspace = (await (await request.get('/api/workspace')).json()) as Workspace;
  const file = path.resolve(workspace.storage.databasePath);
  expect(file.startsWith(path.resolve('.local/e2e-data-'))).toBe(true);
  expect(path.basename(file)).toBe('control-center.sqlite');
  // Seed through the real owner on the isolated Playwright database. Only the
  // provider transport is substituted; browser reads and acceptance writes use HTTP.
  const store = new Store(file);
  let runId = '',
    reviewId = '',
    reviewRevision = 1;
  try {
    const reviews = new Reviews(store);
    let review = reviews.create({ projectId: null, kind: 'week', anchorDate: '2012-02-01' });
    review = reviews.patch(review.id, {
      revision: review.revision,
      userText: '<b>Наблюдение как текст</b>',
    });
    reviewId = review.id;
    reviewRevision = review.revision;
    const proposal = {
      kind: 'idea',
      projectIds: [],
      title: 'Исходное AI предложение',
      description: 'Проверить гипотезу',
      reason: 'Есть наблюдение',
      uncertainty: 'Нет независимого свидетельства',
      cheapCheck: 'Один пример',
      sources: [`review:${review.id}`],
    };
    const service = new PeriodAnalysis(
      store,
      new History(store, new Projects(store).decisions),
      { key: 'fixture', model: 'fixture-model' },
      async () =>
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    narrative: 'Нужно проверить гипотезу.',
                    findings: [],
                    uncertainties: [],
                    proposals: [proposal, { ...proposal, title: 'Вторая AI идея' }],
                  }),
                },
              ],
            },
          ],
        }),
    );
    const prepared = service.prepare({
      reviewId: review.id,
      requestKey: randomUUID(),
      selection: {
        projectIds: [],
        includeGeneral: true,
        sourceKinds: [],
        includeMetadata: false,
        includeOpenTasks: false,
        includeUserText: true,
        includeRelatedReviews: false,
      },
      readConsent: true,
    });
    const run = await service.run(prepared.id, { packetHash: prepared.packetHash, consent: true });
    expect(run.status).toBe('succeeded');
    runId = run.id;
  } finally {
    store.close();
  }
  let approval: ProposalApproval | undefined,
    lost = false;
  await page.route(`**/api/period-analysis/${runId}/proposals/0/accept`, async (route) => {
    approval = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    lost = true;
    await route.fulfill({ status: 503, json: { error: 'Fixture lost response after commit' } });
  });
  await page.goto(`/period-analysis?review=${reviewId}&run=${runId}`);
  await page.getByRole('link', { name: 'Проверить и принять предложение →' }).first().click();
  await expect(page.getByRole('heading', { name: 'Принять предложение' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Создать', exact: true }).selectOption('task');
  await page.getByLabel('Название', { exact: true }).fill('Моя редакция для задачи');
  await page.getByLabel('Основание', { exact: true }).fill('Я уточнил основание.');
  let failRead = true;
  await page.route(`**/api/period-analysis/${runId}`, (route) => {
    if (failRead) {
      failRead = false;
      return route.fulfill({ status: 503, json: { error: 'Fixture read failure' } });
    }
    return route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Fixture read failure', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue('Моя редакция для задачи');
  await page
    .getByRole('navigation', { name: 'Основная навигация' })
    .getByRole('link', { name: 'История', exact: true })
    .click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
  await expect(page.getByLabel('Название', { exact: true })).toHaveValue('Моя редакция для задачи');
  const create = page.getByRole('button', { name: 'Создать задачу', exact: true });
  await expect(create).toBeDisabled();
  await page.getByLabel('Я проверил редакцию и разрешаю создать выбранную запись').check();
  await create.click();
  await expect.poll(() => lost).toBe(true);
  await expect(page.getByRole('region', { name: 'Принятое предложение' })).toContainText(
    'Моя редакция для задачи',
  );
  await expect(page.getByRole('button', { name: 'Создать задачу', exact: true })).toHaveCount(0);
  const repeated = await request.post(`/api/period-analysis/${runId}/proposals/0/accept`, {
    headers,
    data: approval,
  });
  expect(repeated.status()).toBe(201);
  const taskAccepted = (await repeated.json()) as ProposalAcceptance;
  const current = (await (await request.get('/api/workspace')).json()) as Workspace;
  expect(current.tasks.filter((t) => t.title === 'Моя редакция для задачи')).toHaveLength(1);
  expect(
    (await (await request.get(`/api/period-analysis/${runId}`)).json()).report.proposals[0].title,
  ).toBe('Исходное AI предложение');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Принятое предложение' })).toBeVisible();
  await page.getByRole('link', { name: 'Открыть задачу →' }).click();
  await page.getByRole('link', { name: 'Основания принятого предложения →' }).click();
  await expect(page.getByRole('region', { name: 'Принятое предложение' })).toContainText(
    'Моя редакция для задачи',
  );
  await page.goto(`/period-proposal?run=${runId}&index=1`);
  await page.getByLabel('Название', { exact: true }).fill('Моя редакция для идеи');
  await page.getByLabel('Я проверил редакцию и разрешаю создать выбранную запись').check();
  await page.getByRole('button', { name: 'Создать идею', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Принятое предложение' })).toContainText(
    'Моя редакция для идеи',
  );
  expect(
    (
      await request.delete(`/api/period-analysis/${runId}`, { headers, data: { confirm: true } })
    ).ok(),
  ).toBe(true);
  await page.goto('/proposal-acceptances');
  await expect(
    page.getByText('Анализ удалён; редакция и основания принятого предложения сохранены.'),
  ).toHaveCount(2);
  await page
    .getByRole('region', { name: 'Принятое предложение' })
    .filter({ has: page.getByRole('heading', { name: 'Моя редакция для задачи', exact: true }) })
    .getByText('Исходное предложение AI и сохранённые источники', { exact: true })
    .click();
  await expect(page.getByText('Исходное AI предложение', { exact: true })).toBeVisible();
  const taskCard = page
    .getByRole('region', { name: 'Принятое предложение' })
    .filter({ has: page.getByRole('heading', { name: 'Моя редакция для задачи', exact: true }) });
  await taskCard.locator('details details summary').click();
  await expect(taskCard.getByText('<b>Наблюдение как текст</b>', { exact: true })).toBeVisible();
  await expect(taskCard.locator('b')).toHaveCount(0);
  await mkdir('.local/proposals-review', { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `.local/proposals-review/accepted-${width}.png`,
      fullPage: true,
    });
  }
  expect(
    (await request.delete(`/api/tasks/${taskAccepted.resultId}`, { headers, data: {} })).ok(),
  ).toBe(true);
  await page.reload();
  await expect(
    page.getByText('Созданная запись удалена. Автоматического восстановления нет.'),
  ).toBeVisible();
  await request.delete(`/api/reviews/${reviewId}`, { headers, data: { revision: reviewRevision } });
});
