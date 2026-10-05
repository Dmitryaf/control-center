import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import type { Workspace } from '../../shared/contracts';

test('public audit → allowlist → private context → combined decisions → lost source → safe disconnect', async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });
  const state = async () => (await (await page.request.get('/api/workspace')).json()) as Workspace;
  const originalSettings = (await state()).settings;
  let projectId: string | undefined;
  const text = (id: string, title: string) =>
    `---\nschema_version: 1\nid: ${id}\ntitle: ${title}\ndate: "2026-10-05"\nstatus: accepted\narea: data\nimplementation: implemented\nvisibility: repository\n---\nCanonical body of ${title}`;
  try {
    const repo = await f.repo('context-product');
    const privateRoot = path.join(f.root, 'private-context');
    await mkdir(path.join(privateRoot, 'decisions'), { recursive: true });
    await mkdir(path.join(repo, '.ai-rules'));
    await mkdir(path.join(repo, 'decisions'));
    await writeFile(path.join(repo, '.ai-rules', 'RULESET.md'), '# Runtime');
    await writeFile(path.join(repo, 'AGENTS.md'), '# Runtime routing');
    await writeFile(path.join(repo, 'DECISIONS.md'), '# Public decisions');
    await writeFile(path.join(repo, 'decisions', 'D-0001.md'), text('D-0001', 'Public choice'));
    await writeFile(
      path.join(privateRoot, 'decisions', 'D-0002.md'),
      text('D-0002', 'Private choice'),
    );
    await writeFile(path.join(privateRoot, 'PROJECT_MAP.md'), '# Internal map');
    f.git(repo, 'add', '.ai-rules', 'AGENTS.md', 'DECISIONS.md', 'decisions');
    await page.goto('/settings');
    await page.getByLabel('Полные пути').fill(repo);
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    const project = (await state()).projects.find((item) => item.path === repo)!;
    projectId = project.id;
    await page.goto(`/projects/${project.id}`);
    const panel = page.locator('.context-panel');
    await expect(panel).toContainText('Не указано');
    await panel.getByText('Настройки контекста', { exact: true }).click();
    await panel.getByLabel('Видимость репозитория').selectOption('public');
    await panel.getByRole('button', { name: 'Сохранить контекст', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Настройки контекста сохранены');
    await expect(panel).toContainText('Внутренние файлы отслеживаются Git');
    await panel.getByText(/Проверка публикации ·/).click();
    const finding = panel
      .locator('article')
      .filter({ has: page.locator('strong').filter({ hasText: /^DECISIONS\.md$/ }) });
    await finding.getByRole('button', { name: 'Этот путь намеренно публичный' }).click();
    await expect(finding).toHaveCount(0);
    await expect(panel.getByText('DECISIONS.md', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Убрать из списка' }).click();
    await expect(finding).toBeVisible();
    await finding.getByRole('button', { name: 'Этот путь намеренно публичный' }).click();
    await panel.getByLabel('Каталог приватного контекста').fill(privateRoot);
    await panel.getByLabel('Каталог приватного контекста').press('Enter');
    await expect(page.getByRole('heading', { name: 'D-0002 Private choice' })).toBeVisible();
    await expect(panel).toContainText('Приватная карта проекта найдена');
    await expect(panel).toContainText('1 repository · 1 private · 0 local');
    const privateCard = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'D-0002 Private choice' }) });
    await expect(privateCard).toContainText('Проектное решение · private context');
    await privateCard.getByText('Читать решение', { exact: true }).click();
    await expect(privateCard.locator('pre')).toContainText('Canonical body of Private choice');
    await page.getByRole('button', { name: 'Создать PROJECT.yaml' }).click();
    await expect(page.getByRole('status')).toContainText('PROJECT.yaml записан');
    const yaml = await readFile(path.join(repo, 'PROJECT.yaml'), 'utf8');
    expect(yaml).not.toContain(privateRoot);
    expect(yaml).not.toContain('Private choice');
    await writeFile(
      path.join(privateRoot, 'decisions', 'duplicate.md'),
      text('D-0001', 'Conflicting private'),
    );
    await page.reload();
    await expect(page.getByText(/Конфликт ID решений: D-0001/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'D-0001 Public choice' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'D-0001 Conflicting private' })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.local/context-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.local/context-desktop.png', fullPage: true });
    const moved = path.join(f.root, 'private-moved');
    await rename(privateRoot, moved);
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Данные обновлены');
    await expect(panel).toContainText('Приватный контекст недоступен');
    await page.goto('/');
    await expect(
      page.getByText('Не найден ранее подключённый приватный контекст', { exact: true }),
    ).toBeVisible();
    await page.goto(`/projects/${project.id}`);
    await panel.getByText('Настройки контекста', { exact: true }).click();
    await panel.getByRole('button', { name: 'Отключить приватный контекст' }).click();
    await expect(panel).toContainText('Не подключён');
    expect(dialogs).toContain(
      'Файлы не будут удалены. Control Center перестанет их индексировать.',
    );
    await access(path.join(moved, 'decisions', 'D-0002.md'));
    await expect(page.getByRole('heading', { name: 'D-0002 Private choice' })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await f.cleanup();
    const headers = { 'Content-Type': 'application/json', 'X-Control-Center': '1' };
    await page.request.put('/api/settings', { headers, data: originalSettings });
    if (projectId) await page.request.delete(`/api/projects/${projectId}`, { headers, data: {} });
  }
});
