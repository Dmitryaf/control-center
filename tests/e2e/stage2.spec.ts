import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';
import { calendarDate } from '../../shared/time';
import type { Workspace } from '../../shared/contracts';

test('idea → check → external action/evidence → archive; canonical sources, conflict, rebind and safe cleanup', async ({
  page,
}) => {
  test.setTimeout(120000);
  const f = await fixture();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  page.on('dialog', (dialog) => dialog.accept());
  const ago = (days: number) => {
    const now = new Date();
    now.setDate(now.getDate() - days);
    return calendarDate(now);
  };
  const state = async () => (await (await page.request.get('/api/workspace')).json()) as Workspace;
  try {
    const repo = await f.repo('hypothesis-product');
    const privateDir = path.join(f.root, 'private-decisions');
    await mkdir(path.join(repo, 'decisions'));
    await mkdir(privateDir);
    await writeFile(
      path.join(repo, 'decisions', 'D-0001.md'),
      `---\nschema_version: 1\nid: D-0001\ntitle: File choice\ndate: ${ago(20)}\nstatus: accepted\narea: data\nimplementation: not_implemented\nreview_after: ${ago(1)}\nvisibility: repository\n---\nPublic rationale`,
    );
    await writeFile(path.join(privateDir, 'legacy.md'), '# Private rationale\nPreserve this text.');
    await page.goto('/settings');
    await page.getByLabel('Полные пути').fill(f.root);
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    const project = (await state()).projects.find((p) => p.path === repo)!;
    await page.goto(`/projects/${project.id}`);
    await expect(page.getByRole('heading', { name: 'D-0001 File choice' })).toBeVisible();
    await expect(
      page.getByText('Пора пересмотреть решение D-0001', { exact: true }).last(),
    ).toBeVisible();
    await page.getByText('Дополнительные каталоги решений', { exact: true }).click();
    await page.getByLabel('Каталоги решений, каждый с новой строки').fill(privateDir);
    await page.getByRole('button', { name: 'Сохранить источники решений' }).click();
    await expect(page.getByRole('heading', { name: 'Private rationale' })).toBeVisible();
    await page.getByRole('button', { name: 'Изменить сводку' }).click();
    await page.getByLabel('Текущий фокус').fill('Keep local focus');
    await page.getByRole('button', { name: 'Сохранить сводку', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Сводка сохранена');
    await page.getByRole('button', { name: 'Создать PROJECT.yaml' }).click();
    await expect(page.getByRole('status')).toContainText('PROJECT.yaml записан');
    const yamlFile = path.join(repo, 'PROJECT.yaml');
    expect(await readFile(yamlFile, 'utf8')).not.toContain(privateDir);
    await writeFile(yamlFile, 'name: External name\ncurrent_focus: External focus\n');
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'PROJECT.yaml изменился после локального редактирования' }),
    ).toBeVisible();
    await page.getByText('Посмотреть различия', { exact: true }).click();
    await expect(page.getByRole('cell', { name: 'External focus', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Оставить версию Control Center' }).click();
    await expect(page.getByRole('status')).toContainText('Оставлена версия');
    expect(await readFile(yamlFile, 'utf8')).toContain('External focus');
    await page.goto('/ideas');
    await page.getByLabel('Название идеи').fill('Validate demand');
    await page.getByLabel('Описание', { exact: true }).fill('People need this workflow');
    await page.getByRole('combobox', { name: 'Проект', exact: true }).selectOption(project.id);
    await page.getByRole('button', { name: 'Добавить идею' }).click();
    const ideaCard = page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Validate demand', exact: true }) });
    await expect(ideaCard).toContainText('Идея существует');
    await ideaCard.getByRole('link', { name: 'Начать проверку' }).click();
    await page.getByLabel('Ожидаемый внешний результат').fill('Two participants agree to a pilot');
    await page.getByLabel('Продолжаем, если').fill('Two agree');
    await page.getByLabel('Останавливаемся, если').fill('Nobody agrees');
    await page.getByLabel('Следующий внешний шаг').fill('Ask three people');
    await page.getByLabel('Дата запуска').fill(ago(20));
    await page.getByLabel('Дата пересмотра').fill(ago(1));
    await page.getByRole('button', { name: 'Запустить проверку' }).click();
    await expect(page.getByRole('heading', { name: 'Validate demand', level: 1 })).toBeVisible();
    const checkId = page.url().split('/').pop()!;
    await expect(page.locator('.check-card')).toContainText('20 дн. с запуска');
    await page.getByLabel('Дата события').fill(ago(11));
    await page.getByLabel('Что произошло').fill('Contacted three people');
    await page.getByRole('button', { name: 'Сохранить запись' }).click();
    await expect(page.getByRole('status')).toContainText('Запись сохранена');
    await page.getByLabel('Вид записи').selectOption('evidence');
    await page.getByLabel('Дата события').fill(ago(10));
    await page.getByLabel('Что произошло').fill('Two agreed to a pilot');
    await page.getByLabel('Тип свидетельства').selectOption('fact');
    await page.getByLabel('Числовое значение').fill('2');
    await page.getByRole('button', { name: 'Сохранить запись' }).click();
    await expect(page.locator('.timeline')).toContainText('Two agreed');
    await expect(page.locator('.check-card')).toContainText('11 дн. назад');
    await expect(page.locator('.check-card')).toContainText('Проект активно меняется');
    const evidence = page.locator('.timeline article').filter({ hasText: 'Two agreed' });
    await evidence.getByRole('button', { name: 'Изменить', exact: true }).click();
    await page.getByLabel('Что произошло').fill('Two confirmed the pilot');
    await page.getByRole('button', { name: 'Сохранить запись' }).click();
    await expect(page.locator('.timeline')).toContainText('Two confirmed');
    await page.getByLabel('Вид записи').selectOption('action');
    await page.getByLabel('Дата события').fill(ago(0));
    await page.getByLabel('Что произошло').fill('Temporary entry');
    await page.getByRole('button', { name: 'Сохранить запись' }).click();
    await page
      .locator('.timeline article')
      .filter({ hasText: 'Temporary entry' })
      .getByRole('button', { name: 'Удалить запись' })
      .click();
    await expect(page.locator('.check-card')).toContainText('11 дн. назад');
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Validate demand' }).first()).toBeVisible();
    await expect(page.getByText(/Проект активно меняется/).first()).toBeVisible();
    await page.screenshot({ path: '.local/checks-overview-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '.local/checks-overview-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/checks/${checkId}`);
    await page.getByRole('button', { name: 'Завершить проверку', exact: true }).click();
    await page.getByLabel('Фактический результат').fill('Two pilot participants');
    await page
      .getByLabel('Что подтвердилось / не подтвердилось')
      .fill('Demand exists; retention unknown');
    await page.getByLabel('Почему', { exact: true }).fill('Recorded agreement');
    await page.getByLabel('Следующий вопрос').fill('Will they use it twice?');
    await page.getByRole('button', { name: 'Сохранить итог и завершить' }).click();
    await expect(page.getByRole('heading', { name: 'Итог · Продолжить' })).toBeVisible();
    await page.getByRole('link', { name: '← Все проверки' }).click();
    await page.getByRole('button', { name: /Архив/ }).click();
    await expect(page.getByRole('link', { name: 'Validate demand', exact: true })).toBeVisible();
    const moved = path.join(f.root, 'moved-product');
    await rename(repo, moved);
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Данные обновлены');
    await page.goto(`/projects/${project.id}`);
    await page.getByLabel('Новый найденный каталог').selectOption({ label: moved });
    await page.getByRole('button', { name: 'Перепривязать', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('история сохранена');
    expect((await state()).checks.find((c) => c.id === checkId)?.projectId).toBe(project.id);
    expect((await state()).projects.find((p) => p.id === project.id)?.path).toBe(moved);
    await expect(page.getByRole('heading', { name: 'Private rationale' })).toBeVisible();
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Создать резервную копию' }).click();
    await expect(page.getByRole('status').first()).toContainText('копия');
    await page.getByLabel('Полные пути').fill('');
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    await page.goto(`/projects/${project.id}`);
    await page.getByRole('button', { name: 'Забыть проект' }).click();
    await expect(page.getByRole('status')).toContainText('Проект забыт');
    expect((await state()).checks.find((c) => c.id === checkId)?.projectId).toBe(null);
    await page.goto('/ideas');
    await page
      .locator('article')
      .filter({ has: page.getByRole('heading', { name: 'Validate demand', exact: true }) })
      .getByRole('button', { name: 'Удалить', exact: true })
      .click();
    await expect(page.getByRole('heading', { name: 'Validate demand', exact: true })).toHaveCount(
      0,
    );
    expect((await state()).checks.find((c) => c.id === checkId)?.ideaId).toBe(null);
    expect(errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
