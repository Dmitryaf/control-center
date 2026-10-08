<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { TaskHistoryPage } from '../../../shared/contracts';
import { api, workspace } from '../../shared/api';
const route = useRoute();
const project = ref('');
const identifier = ref('');
const from = ref('');
const to = ref('');
const offset = ref(0);
const applied = ref<Record<string, string>>({});
const result = ref<TaskHistoryPage | null>(null);
const loading = ref(false);
const failure = ref('');
let version = 0;
const labels = {
  baseline: 'Сохранённая запись при переходе',
  result: 'Результат сохранён',
  completed: 'Задача завершена',
  reopened: 'Возвращена в работу',
};
const liveTasks = computed(() => new Set(workspace.value!.tasks.map((task) => task.id)));
const timestamp = (value: string) => new Date(value).toLocaleString('ru');
async function load() {
  const current = ++version;
  loading.value = true;
  try {
    const query = new URLSearchParams({
      ...applied.value,
      offset: String(offset.value),
      limit: '50',
    });
    const response = await api<TaskHistoryPage>('/task-history?' + query);
    if (current === version) {
      result.value = response;
      failure.value = '';
    }
  } catch (cause) {
    if (current === version)
      failure.value = cause instanceof Error ? cause.message : 'Не удалось загрузить историю.';
  } finally {
    if (current === version) loading.value = false;
  }
}
function apply() {
  applied.value = Object.fromEntries(
    Object.entries({
      projectId: project.value,
      identifier: identifier.value.trim(),
      from: from.value,
      to: to.value,
    }).filter(([, value]) => value),
  );
  offset.value = 0;
  result.value = null;
  void load();
}
function page(delta: number) {
  offset.value += delta;
  void load();
}
watch(
  () => route.query,
  (query) => {
    project.value = String(query.project ?? '');
    identifier.value = String(query.task ?? '');
    apply();
  },
  { immediate: true },
);
watch(workspace, () => {
  void load();
});
onUnmounted(() => {
  version++;
});
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">Результаты работы</p>
      <h1>История работы</h1>
      <p class="subtitle">
        Прежние результаты сохраняются при изменении, возврате и удалении задачи.
      </p>
    </div>
    <RouterLink
      class="button"
      :to="project && project !== '__general__' ? `/tasks?project=${project}` : '/tasks'"
      >К задачам →</RouterLink
    >
  </div>
  <form class="toolbar" @submit.prevent="apply">
    <label
      >История проекта<select v-model="project">
        <option value="">Все проекты и общие задачи</option>
        <option value="__general__">Только общие задачи</option>
        <option v-for="item in workspace!.projects" :key="item.id" :value="item.id">
          {{ item.metadata.name }}
        </option>
      </select></label
    >
    <label
      >Номер задачи<input v-model="identifier" placeholder="CC-42 или UUID" maxlength="240"
    /></label>
    <label>С даты (UTC)<input v-model="from" type="date" /></label>
    <label>По дату (UTC)<input v-model="to" type="date" :min="from || undefined" /></label>
    <button :disabled="loading">Показать</button>
  </form>
  <p class="help section-space">
    Даты фильтра включают весь день по UTC. Время записей показано по местному времени. Сведения о
    проверках сохранены со слов пользователя или агента.
  </p>
  <div v-if="failure" class="message error" role="alert" aria-label="История работы">
    {{ failure }} Проверьте фильтры и повторите загрузку.
    <button :disabled="loading" @click="load">Повторить</button>
  </div>
  <p role="status" class="help section-space">
    {{
      loading
        ? 'Загружаем историю…'
        : result
          ? `Записей: ${result.total}`
          : 'История ещё не загружена.'
    }}
  </p>
  <ol v-if="result?.items.length" class="history-list">
    <li v-for="entry in result.items" :key="entry.id" class="panel history-entry">
      <div class="row between">
        <strong>{{ labels[entry.kind] }}</strong
        ><time :datetime="entry.recordedAt">{{ timestamp(entry.recordedAt) }}</time>
      </div>
      <h2>{{ entry.task.code }} · {{ entry.task.title }}</h2>
      <p class="muted">
        {{ entry.projectName ?? 'Общая задача'
        }}<span v-if="entry.projectName && !entry.projectId"> · Проект удалён из списка</span>
      </p>
      <p v-if="entry.kind === 'baseline'" class="help">
        Это известное состояние при переходе. Более ранняя история недоступна; время записи взято из
        последнего сохранения задачи.
      </p>
      <template v-if="entry.task.result">
        <p class="preserve"><strong>Что сделано:</strong> {{ entry.task.result.summary }}</p>
        <p class="preserve">
          <strong>Проверено:</strong> {{ entry.task.result.verified || 'Не указано' }}
        </p>
        <p class="preserve">
          <strong>Не проверено:</strong> {{ entry.task.result.unverified || 'Не указано' }}
        </p>
        <p v-if="entry.task.result.remaining" class="preserve">
          <strong>Осталось:</strong> {{ entry.task.result.remaining }}
        </p>
      </template>
      <p v-else class="muted">Результат не указан.</p>
      <RouterLink
        v-if="entry.taskExists && liveTasks.has(entry.task.id)"
        :to="`/tasks?task=${entry.task.code}`"
        >Открыть текущую задачу →</RouterLink
      >
      <p v-else class="help">Задача удалена. Сохранённый результат доступен в истории.</p>
    </li>
  </ol>
  <p v-else-if="result && !loading" class="empty">
    За этот период записей нет. Результаты появятся после сохранения или завершения задачи.
  </p>
  <div
    v-if="result && (offset || result.total > 50)"
    class="row section-space"
    aria-label="Страницы истории"
  >
    <button :disabled="loading || !offset" @click="page(-50)">Назад</button>
    <span>{{ offset + 1 }}–{{ offset + result.items.length }} из {{ result.total }}</span>
    <button :disabled="loading || offset + 50 >= result.total" @click="page(50)">Далее</button>
  </div>
</template>
<style scoped>
.history-list {
  list-style: none;
  padding: 0;
  margin-block: 18px;
}
.history-entry {
  padding: 20px;
  margin-bottom: 14px;
}
.history-entry h2 {
  margin-block: 10px 4px;
}
.history-entry p {
  margin-bottom: 10px;
  overflow-wrap: anywhere;
}
time {
  color: var(--muted);
  font-size: 12px;
}
</style>
