import { test, expect } from '@playwright/test';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from '../fixtures';

test('complete personal workspace workflow from an empty database', async ({ page }) => {
  const f = await fixture();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400)
      errors.push(`${response.status()} ${response.url()}`);
  });
  try {
    const product = await f.repo('local-product');
    await writeFile(
      path.join(product, 'PROJECT.yaml'),
      'current_focus: Проверить первый выпуск\nnext:\n  - Пройти основной сценарий\n',
    );
    await f.repo('local-tool');
    await writeFile(path.join(product, 'work.txt'), 'dirty working tree');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Начните с каталога проектов' })).toBeVisible();
    await page.getByRole('link', { name: 'Добавить каталог →' }).click();
    await page.getByLabel('Полные пути').fill(f.root);
    await page.getByRole('button', { name: 'Сохранить и сканировать' }).click();
    await expect(page.getByRole('status')).toContainText('Настройки сохранены');
    await page
      .getByRole('navigation')
      .getByRole('link', { name: /Проекты/ })
      .click();
    await expect(page.getByRole('heading', { name: 'local-product', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'local-product', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'local-product', exact: true })).toBeVisible();
    await expect(page.getByText('Есть незакоммиченные изменения', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'local-product', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Изменить сводку' }).click();
    await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('active');
    await page.getByRole('combobox', { name: 'Тип', exact: true }).selectOption('product');
    await page.getByRole('combobox', { name: 'Приоритет', exact: true }).selectOption('high');
    await page
      .getByLabel('Зачем существует', { exact: true })
      .fill('Локальный продукт для проверки рабочего сценария.');
    await expect(page.getByLabel('Текущий фокус')).toHaveCount(0);
    await expect(page.getByLabel('Следующие шаги')).toHaveCount(0);
    await page.getByRole('button', { name: 'Пересмотрено сегодня' }).click();
    await page.getByRole('button', { name: 'Сохранить сводку', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Сводка сохранена');
    await page.getByRole('button', { name: 'Обновить PROJECT.yaml' }).click();
    await expect(page.getByRole('status')).toContainText('PROJECT.yaml записан');
    expect(await readFile(path.join(product, 'PROJECT.yaml'), 'utf8')).toContain(
      'Проверить первый выпуск',
    );
    await page
      .getByRole('combobox', { name: 'Связанный проект', exact: true })
      .selectOption({ label: 'local-tool' });
    await page.getByRole('button', { name: 'Добавить связь' }).click();
    await expect(page.getByRole('status')).toContainText('Связь добавлена');
    await page.getByRole('link', { name: 'Добавить задачу →' }).click();
    await page.getByLabel('Название задачи').fill('Проверить выпуск');
    await page.getByRole('combobox', { name: 'Когда', exact: true }).selectOption('now');
    await page.getByLabel('Название задачи').press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Проверить выпуск', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Состояние: Проверить выпуск').selectOption('later');
    await expect(page.getByRole('status')).toContainText('Задача обновлена');
    await page.getByLabel('Состояние: Проверить выпуск').selectOption('now');
    await page.getByRole('button', { name: 'Завершить', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Проверить выпуск', exact: true })).toHaveCount(
      0,
    );
    await page.getByLabel('Завершённые', { exact: true }).check();
    await page.getByRole('button', { name: 'Вернуть', exact: true }).click();
    await page.getByLabel('Завершённые', { exact: true }).uncheck();
    await expect(
      page.getByRole('heading', { name: 'Проверить выпуск', exact: true }),
    ).toBeVisible();
    await page.getByRole('navigation').getByRole('link', { name: /Идеи/ }).click();
    await page.getByLabel('Название идеи').fill('Общий инструмент');
    await page.getByLabel('Описание', { exact: true }).fill('Сначала проверить потребность.');
    await page.getByRole('button', { name: 'Добавить идею' }).click();
    await expect(
      page.getByRole('heading', { name: 'Общий инструмент', exact: true }),
    ).toBeVisible();
    await page.getByLabel('Состояние: Общий инструмент').selectOption('consider');
    await expect(page.getByRole('status')).toContainText('Состояние идеи обновлено');
    await page
      .getByRole('navigation')
      .getByRole('link', { name: /Решения/ })
      .click();
    await page.getByLabel('Название решения').fill('Хранить данные локально');
    await page.getByLabel('Решение', { exact: true }).fill('Использовать SQLite');
    await page.getByLabel('Почему', { exact: true }).fill('Не нужен отдельный сервер');
    await page.getByRole('button', { name: 'Добавить решение' }).click();
    await expect(
      page.getByRole('heading', { name: 'Хранить данные локально', exact: true }),
    ).toBeVisible();
    await page.getByRole('navigation').getByRole('link', { name: /Обзор/ }).click();
    await page.locator('.overview-details > summary').click();
    await expect(page.getByRole('heading', { name: 'Активные проекты 1' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Задачи · 1 →' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Идеи · 1 →' })).toBeVisible();
    await expect(page.locator('.current-work')).toContainText('Проверить выпуск');
    await page.screenshot({ path: '.local/overview-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'Сейчас', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: '.local/overview-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
