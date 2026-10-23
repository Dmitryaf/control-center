import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import { designFixture } from './design-fixture';
import type { Workspace } from '../../shared/contracts';
import type { HistoryPage } from '../../shared/history';

test('real common/project history pages results, checks and decisions, preserves old task links and opens original sources', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const initial = (await (await request.get('/api/workspace')).json()) as Workspace;
  try {
    const repo = await f.repo('unified-history');
    await mkdir(path.join(repo, 'decisions'));
    await writeFile(
      path.join(repo, 'decisions/D-0001.md'),
      '---\nschema_version: 1\nid: D-0001\ntitle: Dated source\ndate: 2020-01-02\nstatus: accepted\narea: product\nimplementation: implemented\nvisibility: repository\n---\nOriginal file body',
    );
    await writeFile(path.join(repo, 'decisions/notes.md'), '# Undated source');
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
    for (let i = 0; i < 31; i++)
      expect(
        (
          await request.post('/api/tasks', {
            headers,
            data: {
              title: `History work ${i}`,
              projectId: project.id,
              result: { summary: `Reported result ${i}` },
            },
          })
        ).ok(),
      ).toBe(true);
    const check = await (
      await request.post('/api/checks', {
        headers,
        data: {
          check: {
            title: 'History check',
            projectId: project.id,
            question: 'Does it help?',
            assumption: 'Yes',
            expectedExternalResult: 'A reply',
            startedAt: '2020-01-01',
            continueIf: 'Reply',
            stopIf: 'No reply',
            nextExternalAction: 'Ask',
          },
        },
      })
    ).json();
    expect(
      (
        await request.post(`/api/checks/${check.id}/entries`, {
          headers,
          data: { kind: 'action', occurredAt: '2020-01-02', text: 'A real external step' },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.post('/api/decisions', {
          headers,
          data: {
            title: 'History choice',
            decision: 'Keep original source',
            projectId: project.id,
            date: '2020-01-02',
          },
        })
      ).ok(),
    ).toBe(true);
    await mkdir('.local/history-review', { recursive: true });
    for (const width of [1440, 1100, 800, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`/timeline?project=${project.id}`);
      await expect(page.locator('.history-record')).toHaveCount(30);
      await expect(
        page.getByRole('status', { name: 'Ограничения файловых источников' }),
      ).toContainText('Файлов без известной даты: 1');
      const first = await page.locator('.history-record h2').allTextContents();
      await page.getByRole('button', { name: 'Далее', exact: true }).click();
      await expect(page.locator('.history-record')).toHaveCount(5);
      const second = await page.locator('.history-record h2').allTextContents();
      expect(new Set([...first, ...second]).size).toBe(34); // A check start and its action share a title, but are separate source events.
      await expect(page.locator('.unified-history')).toContainText('A real external step');
      await expect(page.getByRole('button', { name: 'Далее', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Назад', exact: true }).click();
      await expect(page.locator('.history-record h2')).toHaveText(first);
      await page
        .getByRole('combobox', { name: 'Источник', exact: true })
        .selectOption('file_decision');
      await page.getByRole('button', { name: 'Показать', exact: true }).click();
      await expect(page.locator('.history-record')).toHaveCount(1);
      await expect(page.locator('.history-record')).toContainText('Указана дата, время неизвестно');
      await expect(page.locator('.unified-history')).not.toContainText('Original file body');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `.local/history-review/history-${width}.png`, fullPage: true });
    }
    await page.locator('.history-record').getByRole('link', { name: 'Открыть источник →' }).click();
    await expect(page).toHaveURL(/#file-decisions$/);
    await expect(page.locator('#file-decisions')).toContainText('Dated source');
    await page.getByRole('link', { name: 'История проекта →' }).click();
    await page.getByRole('combobox', { name: 'Источник', exact: true }).selectOption('decision');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.locator('.history-record[data-source="decision"]')).toHaveCount(1);
    await page.locator('.history-record').getByRole('link', { name: 'Открыть источник →' }).click();
    await expect(page.locator('article[data-history-target]')).toContainText(
      'Keep original source',
    );
    await expect(page.locator('article[data-history-target]')).toBeFocused();
    await page.goto(`/timeline?project=${project.id}&kind=check&from=2020-01-02&to=2020-01-02`);
    await expect(page.locator('.history-record')).toHaveCount(1);
    await page.locator('.history-record').getByRole('link', { name: 'Открыть источник →' }).click();
    await expect(page.locator('article[data-history-target]')).toContainText(
      'A real external step',
    );
    await expect(page.locator('article[data-history-target]')).toBeFocused();
    await page.goto('/timeline?project=__unlinked__&kind=file_decision');
    await expect(
      page.getByText('В доступных источниках за выбранный период записей нет.', { exact: true }),
    ).toBeVisible();
  } finally {
    await request.put('/api/settings', { headers, data: initial.settings });
    await f.cleanup();
  }
});

test('history read errors keep known entries, retry without losing filters, and scope changes clear the previous page', async ({
  page,
}) => {
  const workspace = designFixture();
  let fail = true;
  const data: HistoryPage = {
    items: [
      {
        key: 'task:1',
        kind: 'task',
        event: 'task_baseline',
        sourceId: '1',
        day: '2020-01-01',
        recordedAt: '2020-01-01T10:00:00.000Z',
        dateQuality: 'baseline',
        projectId: null,
        projectName: null,
        title: 'Saved reported work',
        excerpt: 'Known result',
        truncated: false,
        href: '/history?task=CC-1',
      },
    ],
    nextCursor: null,
    files: { undated: 0, unavailable: 0, notLoadedProjects: 0 },
  };
  await page.route('**/api/workspace', (route) => route.fulfill({ json: workspace }));
  await page.route('**/api/history?**', (route) => {
    if (fail) return route.fulfill({ status: 503, json: { error: 'История временно недоступна' } });
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: params.has('from') ? { ...data, items: [] } : data });
  });
  await page.goto('/timeline');
  await expect(page.getByRole('alert', { name: 'Единая история' })).toContainText(
    'История временно недоступна',
  );
  fail = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.locator('.history-record')).toContainText('Known result');
  fail = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert', { name: 'Единая история' })).toBeVisible();
  await expect(page.locator('.history-record')).toContainText('Known result');
  fail = false;
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await page.getByLabel('С даты (UTC)').fill('2025-01-01');
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await expect(page.locator('.history-record')).toHaveCount(0);
  await expect(page.getByLabel('С даты (UTC)')).toHaveValue('2025-01-01');
  await expect(
    page.getByText('В доступных источниках за выбранный период записей нет.', { exact: true }),
  ).toBeVisible();
});
