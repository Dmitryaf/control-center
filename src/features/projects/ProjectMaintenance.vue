<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Project } from '../../../shared/contracts';
import { act, api, busy, workspace } from '../../shared/api';
import { lines } from '../../shared/labels';
const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ updated: [project: Project] }>();
const router = useRouter();
const candidate = ref('');
const sources = ref(props.project.decisionSources.join('\n'));
const candidates = computed(() =>
  workspace.value!.projects.filter((p) => p.id !== props.project.id && p.available),
);
const fields = {
  name: 'Название',
  type: 'Тип',
  status: 'Статус',
  stage: 'Этап',
  priority: 'Приоритет',
  goal: 'Цель',
  current_focus: 'Фокус',
  next: 'Следующие шаги',
  blocked_by: 'Блокировки',
  related: 'Связанные имена',
  last_reviewed: 'Дата пересмотра',
};
async function rebind() {
  if (
    !confirm(
      'Перепривязать к выбранному каталогу? Старый ID, записи и локальная сводка сохранятся. Новый обнаруженный элемент будет заменён.',
    )
  )
    return;
  await act(async () => {
    emit(
      'updated',
      await api<Project>(`/projects/${props.project.id}/rebind`, 'POST', {
        targetId: candidate.value,
      }),
    );
  }, 'Проект перепривязан, история сохранена');
}
async function forget() {
  if (
    !confirm(
      'Забыть недоступный проект? Задачи, идеи, локальные решения и проверки останутся общими. Связи, заметки и локальная сводка проекта будут удалены. Файлы не изменятся.',
    )
  )
    return;
  const ok = await act(async () => {
    await api(`/projects/${props.project.id}`, 'DELETE');
  }, 'Проект забыт. Связанные записи сохранены как общие.');
  if (ok) await router.push('/projects');
}
function keepLocal() {
  return act(async () => {
    emit(
      'updated',
      await api<Project>(`/projects/${props.project.id}/keep-local`, 'POST', {
        expectedHash: props.project.snapshot.yaml.hash,
      }),
    );
  }, 'Оставлена версия Control Center. Файл не изменён.');
}
function useYaml() {
  if (!confirm('Заменить локальную сводку текущими данными PROJECT.yaml? Заметки сохранятся.'))
    return;
  return act(async () => {
    emit(
      'updated',
      await api<Project>(`/projects/${props.project.id}/use-yaml`, 'POST', {
        expectedHash: props.project.snapshot.yaml.hash,
      }),
    );
  }, 'Используется PROJECT.yaml');
}
function saveSources() {
  return act(async () => {
    emit(
      'updated',
      await api<Project>(`/projects/${props.project.id}/decision-sources`, 'PUT', {
        paths: lines(sources.value),
      }),
    );
  }, 'Источники решений сохранены и прочитаны');
}
</script>
<template>
  <section v-if="!project.available" class="panel form section-space">
    <h2>Каталог проекта недоступен</h2>
    <p>
      После переноса обновите список проектов и выберите обнаруженный каталог. Совпадение remote —
      подсказка, не автоматическая привязка.
    </p>
    <form class="form" @submit.prevent="rebind">
      <label
        >Новый найденный каталог<select v-model="candidate" required>
          <option value="" disabled>Выберите каталог</option>
          <option v-for="item in candidates" :key="item.id" :value="item.id">
            {{ item.path
            }}{{
              item.snapshot.git.remote && item.snapshot.git.remote === project.snapshot.git.remote
                ? ' · совпадает remote'
                : ''
            }}
          </option>
        </select></label
      >
      <div class="row">
        <button :disabled="busy || !candidate">Перепривязать</button
        ><button type="button" :disabled="busy" @click="forget">Забыть проект</button>
      </div>
    </form>
  </section>
  <section v-if="project.yamlConflict" class="message warning section-space">
    <h2>PROJECT.yaml изменился после локального редактирования</h2>
    <details class="section-space">
      <summary>Посмотреть различия</summary>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Поле</th>
              <th>Control Center</th>
              <th>PROJECT.yaml сейчас</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(label, key) in fields" :key="key">
              <th>{{ label }}</th>
              <td>{{ project.metadata[key] }}</td>
              <td>{{ project.snapshot.yaml.metadata?.[key] ?? 'Нет данных' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
    <p v-if="project.snapshot.yaml.error">{{ project.snapshot.yaml.error }}</p>
    <div class="row section-space">
      <button
        :disabled="busy || !!project.snapshot.yaml.error || !project.available"
        @click="useYaml"
      >
        Использовать PROJECT.yaml</button
      ><button
        :disabled="busy || !!project.snapshot.yaml.error || !project.available"
        @click="keepLocal"
      >
        Оставить версию Control Center
      </button>
    </div>
  </section>
  <details class="panel section-space">
    <summary>Дополнительные каталоги решений</summary>
    <form class="form section-space" @submit.prevent="saveSources">
      <p class="help">
        Подключите отдельный каталог decisions из приватного источника. Путь хранится только в
        SQLite, файлы не изменяются.
      </p>
      <label>Каталоги решений, каждый с новой строки<textarea v-model="sources" rows="3" /></label
      ><button :disabled="busy">Сохранить источники решений</button>
    </form>
  </details>
</template>
