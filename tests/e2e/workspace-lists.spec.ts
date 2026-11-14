import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fixture } from '../fixtures';
import type { Idea, Task, Workspace } from '../../shared/contracts';

test('compact task overview and idea cards preserve full records, navigation and drafts', async ({
  page,
  request,
}) => {
  const f = await fixture();
  const headers = { 'X-Control-Center': '1' };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const workspace = async () => (await (await request.get('/api/workspace')).json()) as Workspace;
  try {
    const repo = await f.repo('list-review-project');
    await request.put('/api/settings', {
      headers,
      data: { ...(await workspace()).settings, roots: [repo], autoRefreshMinutes: 0 },
    });
    const project = (await workspace()).projects.find((p) => p.path === repo)!;
    const tasks: Task[] = [];
    for (let i = 1; i <= 7; i++) {
      tasks.push(
        await (
          await request.post('/api/tasks', {
            headers,
            data: {
              projectId: project.id,
              title: `Проверка списка ${i}: сохранить результат и восстановить контекст после повторного открытия`,
              description: `Подробное описание ${i}\n${'Синтетическая запись для проверки переноса длинного текста. '.repeat(12)}`,
              expectedResult: 'Результат доступен после перезапуска',
              acceptance: 'Повторное открытие сохраняет данные',
              result: {
                summary: 'Подготовлена тестовая запись',
                verified: 'Временная база',
                unverified: 'Внешние устройства',
                remaining: '',
              },
            },
          })
        ).json(),
      );
    }
    await page.goto('/tasks');
    const group = page
      .locator('.task-group')
      .filter({ has: page.getByRole('link', { name: project.metadata.name, exact: true }) });
    await expect(group.locator('.task-card')).toHaveCount(4);
    await expect(group.getByRole('button', { name: 'Все задачи проекта (7) →' })).toBeVisible();
    await page.getByLabel('Поиск задач', { exact: true }).fill(tasks[0].code);
    await expect(group.locator('.task-card')).toHaveCount(1);
    await expect(group.getByRole('button', { name: tasks[0].title, exact: true })).toBeVisible();
    await page.getByLabel('Поиск задач', { exact: true }).fill('');
    await group.getByRole('button', { name: 'Все задачи проекта (7) →' }).click();
    await expect(group.locator('.task-card')).toHaveCount(7);
    await page.getByLabel('Показать проект').selectOption('');
    await group.getByRole('button', { name: tasks[6].title, exact: true }).click();
    const composer = page.getByRole('form', { name: 'Новая задача', exact: true });
    await composer.getByLabel('Название задачи').fill('Новая задача вне первых четырёх');
    await composer.getByRole('button', { name: 'Параметры задачи' }).click();
    await composer.getByRole('combobox', { name: 'Проект', exact: true }).selectOption(project.id);
    await composer.getByRole('combobox', { name: 'Приоритет', exact: true }).selectOption('low');
    await composer.getByRole('button', { name: 'Создать задачу' }).click();
    await expect(page.getByLabel('Показать проект')).toHaveValue(project.id);
    await expect(page.getByRole('complementary', { name: 'Подробности задачи' })).toHaveCount(0);
    await expect(
      group.getByRole('button', { name: 'Новая задача вне первых четырёх', exact: true }),
    ).toBeVisible();
    const firstRow = group.locator('.task-card').filter({ hasText: tasks[0].code });
    await firstRow.getByRole('button', { name: `Действия ${tasks[0].code}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Изменить итог', exact: true }).click();
    await expect(page.getByLabel('Итог работы', { exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('button', { name: '← К списку задач' }).click();
    const opener = group.getByRole('button', { name: tasks[0].title, exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByRole('complementary', { name: 'Подробности задачи' });
    await expect(panel.getByRole('heading', { name: tasks[0].title, exact: true })).toBeFocused();
    await expect(panel).toContainText(tasks[0].description);
    await panel.getByRole('button', { name: 'Изменить задачу', exact: true }).click();
    const title = panel.getByLabel('Название задачи');
    await title.fill('Несохранённое название');
    page.once('dialog', (d) => d.dismiss());
    await group.getByRole('button', { name: tasks[1].title, exact: true }).click();
    await expect(title).toHaveValue('Несохранённое название');
    await page.getByLabel('Показать проект').selectOption('__general__');
    await expect(title).toHaveValue('Несохранённое название');
    page.once('dialog', (d) => d.dismiss());
    await panel.getByRole('button', { name: '← К списку задач' }).click();
    await expect(title).toHaveValue('Несохранённое название');
    await page.getByRole('navigation').getByRole('link', { name: 'Проекты', exact: true }).click();
    await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
    await expect(title).toHaveValue('Несохранённое название');
    page.once('dialog', (d) => d.accept());
    await panel.getByRole('button', { name: 'Отмена', exact: true }).click();
    await panel.getByRole('button', { name: 'Изменить итог', exact: true }).click();
    const summary = panel.getByLabel('Итог работы');
    await summary.fill('Несохранённый итог');
    await request.put(`/api/tasks/${tasks[0].id}`, {
      headers,
      data: { ...tasks[0], completedAt: new Date().toISOString() },
    });
    await page.getByRole('button', { name: '↻ Обновить', exact: true }).click();
    await expect(summary).toHaveValue('Несохранённый итог');
    await panel.getByRole('button', { name: 'Сохранить итог', exact: true }).click();
    await expect(page.getByRole('alert', { name: 'Ошибка действия', exact: true })).toContainText(
      'уже изменена',
    );
    await expect(summary).toHaveValue('Несохранённый итог');
    page.once('dialog', (d) => d.accept());
    await panel.getByRole('button', { name: '← К списку задач' }).click();
    await expect(page.locator('#task-list-heading')).toBeFocused();

    await mkdir('.local/work/compact-lists', { recursive: true });
    await page.goto(`/tasks?task=${tasks[1].code}`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(tasks[1].expectedResult);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 390)
        await expect(page.getByRole('region', { name: 'Список задач' })).toBeHidden();
      await page.screenshot({
        path: `.local/work/compact-lists/task-detail-${width}.png`,
        fullPage: true,
      });
    }
    page.once('dialog', (d) => d.accept());
    await panel.getByRole('button', { name: 'Удалить', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('#task-list-heading')).toBeFocused();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('Показать проект').selectOption(project.id);
    await page.screenshot({ path: '.local/work/compact-lists/tasks.png', fullPage: true });

    const ideas: Idea[] = [];
    for (let i = 1; i <= 6; i++) {
      ideas.push(
        await (
          await request.post('/api/ideas', {
            headers,
            data: {
              projectId: project.id,
              title: `Идея для обзора ${i}: проверить новый сценарий продукта`,
              state: i === 1 ? 'accepted' : 'new',
              description: `Контекст идеи ${i}\n\n${'Длинный исходный текст должен оставаться доступным целиком. '.repeat(35)}\n\nКонец записи ${i}\n<script>dangerous()</script>`,
            },
          })
        ).json(),
      );
    }
    await page.goto(`/ideas?project=${project.id}&q=обзора`);
    await expect(page.locator('.idea-card')).toHaveCount(6);
    const heights = await page
      .locator('.idea-card')
      .evaluateAll((cards) => cards.map((c) => c.getBoundingClientRect().height));
    expect(Math.max(...heights)).toBeLessThan(380);
    await page.screenshot({ path: '.local/work/compact-lists/ideas.png', fullPage: true });
    const ideaLink = page.getByRole('link', { name: ideas[0].title, exact: true });
    await ideaLink.scrollIntoViewIfNeeded();
    const scroll = await page.evaluate(() => window.scrollY);
    await ideaLink.click();
    await expect(page.getByRole('heading', { name: ideas[0].title, level: 1 })).toBeFocused();
    await expect(page.locator('.idea-full-text')).toHaveText(ideas[0].description);
    await expect(page.locator('.idea-full-text script')).toHaveCount(0);
    await page.getByRole('button', { name: 'Изменить', exact: true }).click();
    await page.getByLabel('Описание', { exact: true }).fill('Черновик длинной идеи');
    await page.getByRole('link', { name: '← Все идеи' }).click();
    await page.getByRole('button', { name: 'Продолжить редактирование' }).click();
    await expect(page.getByLabel('Описание', { exact: true })).toHaveValue('Черновик длинной идеи');
    await page.getByRole('button', { name: 'Сохранить идею' }).click();
    await expect(page.locator('.idea-full-text')).toHaveText('Черновик длинной идеи');
    await page.getByRole('link', { name: '← Все идеи' }).click();
    await expect(page.getByLabel('Поиск идей')).toHaveValue('обзора');
    await expect(page.getByLabel('Проект идей')).toHaveValue(project.id);
    await expect(ideaLink).toBeFocused();
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - scroll)).toBeLessThan(5);
    await ideaLink.click();
    await page.goBack();
    await expect(ideaLink).toBeFocused();
    await page.goto(`/ideas#idea-${ideas[1].id}`);
    await expect(page).toHaveURL(new RegExp(`/ideas/${ideas[1].id}$`));
    await expect(page.locator('.idea-full-text')).toHaveText(ideas[1].description);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: `.local/work/compact-lists/idea-detail-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole('link', { name: '← Все идеи' }).click();
    await page.getByLabel('Проект идей').selectOption(project.id);
    await expect(page.locator('.idea-card')).toHaveCount(6);
    await page.screenshot({ path: '.local/work/compact-lists/ideas-390.png', fullPage: true });
    await page.getByRole('button', { name: 'Новая идея', exact: true }).click();
    await page.getByLabel('Название идеи').fill('Новая идея из карточного списка');
    await page.getByLabel('Описание', { exact: true }).fill('Сохраняем через прежний API');
    await page.getByRole('button', { name: 'Добавить идею' }).click();
    await expect(
      page.getByRole('link', { name: 'Новая идея из карточного списка', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Новая идея из карточного списка', exact: true }).click();
    await page.getByLabel('Состояние: Новая идея из карточного списка').selectOption('consider');
    await expect(page.getByRole('status')).toContainText('Состояние идеи обновлено');
    expect(errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
