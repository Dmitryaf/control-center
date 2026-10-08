<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import type { TaskHistoryPage } from '../../../shared/contracts';
import { api, workspace } from '../../shared/api';
const result = ref<TaskHistoryPage | null>(null);
const loading = ref(false);
const failure = ref('');
let version = 0;
const labels = {
  baseline: 'Запись при переходе',
  result: 'Результат сохранён',
  completed: 'Задача завершена',
  reopened: 'Возвращена в работу',
};
async function load() {
  const current = ++version;
  loading.value = true;
  try {
    const response = await api<TaskHistoryPage>('/task-history?limit=5');
    if (current === version) {
      result.value = response;
      failure.value = '';
    }
  } catch (cause) {
    if (current === version)
      failure.value = cause instanceof Error ? cause.message : 'Не удалось загрузить результаты.';
  } finally {
    if (current === version) loading.value = false;
  }
}
watch(
  workspace,
  () => {
    void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  version++;
});
</script>
<template>
  <section class="recent-work section-space" aria-labelledby="recent-work-heading">
    <div class="section-heading">
      <h2 id="recent-work-heading">Последние результаты</h2>
      <RouterLink to="/history">Вся история →</RouterLink>
    </div>
    <p class="help">
      Последние пять записей работы. Сведения о проверках сохранены со слов пользователя или агента.
    </p>
    <p v-if="loading && !result" role="status" class="empty">Загружаем результаты…</p>
    <div v-if="failure" class="message warning" role="alert" aria-label="Последние результаты">
      {{ failure }} <span v-if="result">Показаны ранее загруженные записи.</span
      ><button :disabled="loading" @click="load">Повторить</button>
    </div>
    <ol v-if="result?.items.length" class="recent-work-list">
      <li v-for="entry in result.items" :key="entry.id" class="activity">
        <time :datetime="entry.recordedAt">{{
          new Date(entry.recordedAt).toLocaleString('ru')
        }}</time>
        <div>
          <RouterLink :to="`/history?task=${entry.task.code}`"
            >{{ entry.task.code }} · {{ entry.task.title }}</RouterLink
          >
          <p class="help">{{ entry.projectName ?? 'Общая задача' }} · {{ labels[entry.kind] }}</p>
          <p class="preserve">{{ entry.task.result?.summary ?? 'Результат не указан.' }}</p>
          <p v-if="entry.task.result?.remaining" class="help">
            Осталось: {{ entry.task.result.remaining }}
          </p>
          <p v-if="entry.kind === 'baseline'" class="help">
            Известная запись при переходе; время последнего сохранения, более ранняя история
            недоступна.
          </p>
        </div>
      </li>
    </ol>
    <p v-else-if="result && !failure" class="empty">
      Сохранённых результатов пока нет. Они появятся после записи результата или завершения задачи.
    </p>
  </section>
</template>
<style scoped>
.recent-work-list {
  list-style: none;
  padding: 0;
  margin-block: 12px 0;
}
.activity time {
  flex-shrink: 0;
  width: 140px;
}
@media (max-width: 600px) {
  .activity {
    flex-direction: column;
    gap: 6px;
  }
  .activity time {
    width: auto;
  }
}
</style>
