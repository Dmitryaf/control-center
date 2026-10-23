import { test, expect } from '@playwright/test';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import { codexFixture } from '../codex-fixture';
import { Store } from '../../server/db';
import { CodexContext } from '../../server/codex/context';
import type { Workspace } from '../../shared/contracts';
import type { Review } from '../../shared/reviews';
import type { PeriodRun } from '../../shared/period-analysis';
import { HttpError } from '../../server/errors';

test('project opt-in → selected dialog → protected summary/excerpts → real saved AI packet; unavailable CLI and stale source stay explicit', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  let store: Store | undefined, context: CodexContext | undefined;
  try {
    const repo = await f.repo('dialog-context-project');
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
    const file = path.resolve(workspace.storage.databasePath);
    expect(file.startsWith(path.resolve('.local/e2e-data-'))).toBe(true);
    store = new Store(file);
    const fake = codexFixture(repo);
    fake.state.text =
      '<b>Намерение, не результат</b> ' + 'Длинная проверяемая формулировка. '.repeat(60);
    context = new CodexContext(store, fake.transport);
    const reader = context;
    await page.goto(`/codex-context?review=${review.id}&project=${project.id}`);
    await expect(page.getByRole('button', { name: 'Показать диалоги проекта' })).toBeDisabled();
    expect(fake.calls).toHaveLength(0);
    await page
      .getByLabel('Разрешаю чтение списка и выбранных диалогов только этого проекта', {
        exact: false,
      })
      .check();
    await page.getByRole('button', { name: 'Разрешить чтение проекта' }).click();
    expect(fake.calls).toHaveLength(0);
    await page.getByRole('button', { name: 'Проверить CLI без чтения диалогов' }).click();
    await expect(
      page.getByText('Codex недоступен, ответ слишком велик или протокол не поддерживается.', {
        exact: false,
      }),
    ).toBeVisible();
    // Browser source operations use the same owner with a substituted RPC boundary.
    // Grant, SQLite reads/deletion and AI preparation still use the real HTTP server.
    const fulfill = async (
      route: Parameters<Parameters<typeof page.route>[1]>[0],
      action: () => Promise<unknown>,
    ) => {
      try {
        await route.fulfill({ json: await action() });
      } catch (error) {
        await route.fulfill({
          status: error instanceof HttpError ? error.status : 500,
          json: { error: error instanceof Error ? error.message : 'fixture error' },
        });
      }
    };
    await page.route(`**/api/projects/${project.id}/codex-context/probe`, (route) =>
      fulfill(route, () => reader.probe(project.id, route.request().postDataJSON().revision)),
    );
    await page.route(`**/api/projects/${project.id}/codex-context/threads`, (route) =>
      fulfill(route, () => reader.threads(project.id, route.request().postDataJSON())),
    );
    await page.route(`**/api/projects/${project.id}/codex-context/preview`, (route) =>
      fulfill(route, () => reader.preview(project.id, route.request().postDataJSON())),
    );
    let lose = true;
    await page.route(`**/api/projects/${project.id}/codex-context/digests`, (route) =>
      fulfill(route, async () => {
        const saved = await reader.save(project.id, route.request().postDataJSON());
        if (lose) {
          lose = false;
          throw new HttpError(503, 'Fixture lost digest response');
        }
        return saved;
      }),
    );
    await page.route('**/api/codex-context/digests/*/check', (route) =>
      fulfill(route, () =>
        reader.check(route.request().url().split('/').at(-2)!, route.request().postDataJSON()),
      ),
    );
    await page.getByRole('button', { name: 'Проверить CLI без чтения диалогов' }).click();
    await expect(page.getByText('Версия CLI: 0.158.0.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Показать диалоги проекта' }).click();
    await expect(page.getByRole('heading', { name: 'Содержательный диалог' })).toBeVisible();
    await page.getByRole('button', { name: 'Просмотреть текст за период' }).click();
    await page
      .getByLabel('Мой краткий итог', { exact: true })
      .fill('Сформулировано намерение; результат требует отдельной проверки.');
    await page
      .getByRole('navigation', { name: 'Основная навигация' })
      .getByRole('link', { name: 'История', exact: true })
      .click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
    await expect(page.getByLabel('Мой краткий итог')).toHaveValue(
      'Сформулировано намерение; результат требует отдельной проверки.',
    );
    await expect(page.getByRole('button', { name: 'Сохранить итог диалога' })).toBeDisabled();
    await page.getByRole('checkbox', { name: /Пользователь ·/ }).check();
    await page
      .getByLabel('Я просмотрел текст и разрешаю сохранить мой итог', { exact: false })
      .check();
    await mkdir('.local/codex-context-review', { recursive: true });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/codex-context-review/capture-${width}.png`,
        fullPage: true,
      });
    }
    await expect(page.locator('b')).toHaveCount(0);
    await page.getByRole('button', { name: 'Сохранить итог диалога' }).click();
    await expect(page.getByText('Fixture lost digest response')).toBeVisible();
    await expect(page.getByLabel('Мой краткий итог')).toHaveValue(
      'Сформулировано намерение; результат требует отдельной проверки.',
    );
    const calls = fake.calls.length;
    await page.getByRole('button', { name: 'Сохранить итог диалога' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByText('Краткий итог сохранён.', { exact: false })).toBeVisible();
    expect(fake.calls.length).toBe(calls);
    const saved = reader.list({ reviewId: review.id }).items[0];
    expect(saved.excerpts).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('DO_NOT_PERSIST');
    await page.getByRole('link', { name: 'К ручному AI-анализу →' }).click();
    await page
      .getByRole('checkbox', { name: /dialog-context-project · Содержательный диалог/ })
      .check();
    await page.getByLabel('Разрешаю прочитать выбранные источники', { exact: false }).check();
    await page.getByRole('button', { name: 'Подготовить точный пакет' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('run')).toBeTruthy();
    const runId = new URL(page.url()).searchParams.get('run')!;
    const run = (await (await request.get(`/api/period-analysis/${runId}`)).json()) as PeriodRun;
    expect(run.payload.sources).toHaveLength(1);
    expect(run.payload.sources[0].kind).toBe('codex_digest');
    expect(run.payload.sources[0].text).toContain(saved.summary);
    expect(run.payload.sources[0].text).not.toContain('Предложение: сначала');
    await page.goto(`/codex-context?review=${review.id}&project=${project.id}`);
    fake.state.text = 'Изменённый текст';
    fake.state.updatedAt++;
    await page.getByRole('button', { name: 'Проверить изменения диалога' }).click();
    await expect(
      page.getByText('Диалог изменён или не удалось проверить источник.', { exact: false }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Отключить чтение', exact: true }).click();
    expect(reader.read(saved.id).eligible).toBe(false);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Удалить итог диалога', exact: true }).click();
    await expect(page.getByText('Сохранённых итогов диалогов пока нет.')).toBeVisible();
    const retained = (await (
      await request.get(`/api/period-analysis/${runId}`)
    ).json()) as PeriodRun;
    expect(retained.payload.sources[0].text).toContain(saved.summary);
  } finally {
    await context?.stop();
    store?.close();
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});
