<script setup lang="ts">
import { ref } from 'vue';
import { api, act, busy, workspace } from '../../shared/api';
import { lines } from '../../shared/labels';
const roots = ref(workspace.value!.settings.roots.join('\n'));
const exclusions = ref(workspace.value!.settings.exclusions.join('\n'));
const inactivityDays = ref(workspace.value!.settings.inactivityDays);
const reviewDays = ref(workspace.value!.settings.reviewDays);
function save() {
  return act(async () => {
    await api('/settings', 'PUT', {
      roots: lines(roots.value),
      exclusions: lines(exclusions.value),
      inactivityDays: inactivityDays.value,
      reviewDays: reviewDays.value,
    });
  }, 'Настройки сохранены. Каталоги проверены.');
}
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="eyebrow">ЛОКАЛЬНОЕ ПРОСТРАНСТВО</p>
      <h1>Настройки</h1>
      <p class="subtitle">Откуда читать проекты и когда обращать на них внимание.</p>
    </div>
  </div>
  <form class="panel form settings-form" @submit.prevent="save">
    <h2>Каталоги проектов</h2>
    <label
      >Полные пути, каждый с новой строки<textarea
        v-model="roots"
        rows="4"
        placeholder="C:/Personal&#10;C:/Work"
      />
    </label>
    <p class="help">
      Поиск останавливается внутри найденного проекта. Вложенный проект можно добавить отдельным
      каталогом. Символические ссылки не обходятся.
    </p>
    <label>Исключённые имена каталогов<textarea v-model="exclusions" rows="4" /></label>
    <div class="form-grid">
      <label
        >Нет новых commits, дней<input
          v-model.number="inactivityDays"
          type="number"
          min="1"
          max="3650"
          required /></label
      ><label
        >Пересмотр метаданных, дней<input
          v-model.number="reviewDays"
          type="number"
          min="1"
          max="3650"
          required
      /></label>
    </div>
    <div>
      <button class="primary" :disabled="busy">
        {{ busy ? 'Сканирование…' : 'Сохранить и сканировать' }}
      </button>
    </div>
  </form>
  <div class="panel section-space prose">
    <h2>Как хранятся данные</h2>
    <p>
      Задачи, идеи, решения, связи, настройки и ваши правки сводок хранятся в локальной SQLite.
      Сканирование читает репозитории без изменения файлов.
    </p>
    <p>
      Файл PROJECT.yaml меняется только по кнопке экспорта на странице проекта. Сохранённые в
      Control Center правки имеют приоритет над YAML.
    </p>
  </div>
</template>
