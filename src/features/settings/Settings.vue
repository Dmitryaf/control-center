<script setup lang="ts">
import { ref } from 'vue';
import { api, act, busy, workspace } from '../../shared/api';
import { lines } from '../../shared/labels';
const roots = ref(workspace.value!.settings.roots.join('\n'));
const exclusions = ref(workspace.value!.settings.exclusions.join('\n'));
const inactivityDays = ref(workspace.value!.settings.inactivityDays);
const reviewDays = ref(workspace.value!.settings.reviewDays);
const movementInfoDays = ref(workspace.value!.settings.movementInfoDays);
const movementAttentionDays = ref(workspace.value!.settings.movementAttentionDays);
const movementDecisionDays = ref(workspace.value!.settings.movementDecisionDays);
const backupPath = ref('');
function backup() {
  return act(async () => {
    backupPath.value = (await api<{ path: string }>('/backup', 'POST')).path;
  }, 'Резервная копия создана и проверена');
}
function save() {
  return act(async () => {
    await api('/settings', 'PUT', {
      roots: lines(roots.value),
      exclusions: lines(exclusions.value),
      inactivityDays: inactivityDays.value,
      reviewDays: reviewDays.value,
      movementInfoDays: movementInfoDays.value,
      movementAttentionDays: movementAttentionDays.value,
      movementDecisionDays: movementDecisionDays.value,
    });
  }, 'Настройки сохранены. Каталоги проверены.');
}
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">Локальное пространство</p>
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
      <h2>Время без внешнего движения</h2>
      <p class="help">
        Только для активных проверок. Интервалы должны возрастать. Git не сбрасывает эти сроки.
      </p>
      <div class="form-grid section-space">
        <label
          >Информация, дней<input
            v-model.number="movementInfoDays"
            type="number"
            min="1"
            max="3650"
            required /></label
        ><label
          >Внимание, дней<input
            v-model.number="movementAttentionDays"
            type="number"
            min="1"
            max="3650"
            required /></label
        ><label
          >Нужно решение, дней<input
            v-model.number="movementDecisionDays"
            type="number"
            min="1"
            max="3650"
            required
        /></label>
      </div>
    </div>
    <div>
      <button class="primary" :disabled="busy">
        {{ busy ? 'Сканирование…' : 'Сохранить и сканировать' }}
      </button>
    </div>
  </form>
  <div class="panel section-space prose">
    <h2>Как хранятся данные</h2>
    <p class="source-path">База: {{ workspace!.storage.databasePath }}</p>
    <button :disabled="busy" @click="backup">Создать резервную копию</button>
    <p v-if="backupPath" class="source-path">Копия: {{ backupPath }}</p>
    <p class="help">
      Для восстановления остановите приложение, сохраните текущую базу вместе с -wal/-shm отдельно и
      поместите копию под именем control-center.sqlite в указанный каталог. Подробности — в README.
    </p>
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
