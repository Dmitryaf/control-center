<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import type { Task, TaskInput } from '../../../shared/contracts';
import { act, api, busy, workspace } from '../../shared/api';
import { taskLabels, priorityLabels, date, lines } from '../../shared/labels';
import ProjectSelect from '../../shared/ProjectSelect.vue';
import ProjectLink from '../../shared/ProjectLink.vue';
import RecordDelete from '../../shared/RecordDelete.vue';
const route = useRoute();
const initialProject = String(route.query.project ?? '') || null;
const filter = ref<string | null>(initialProject);
const showDone = ref(false);
const search = ref('');
const stateFilter = ref('');
const requestKey = ref(crypto.randomUUID());
const editingRevision = ref<number | null>(null);
const linksText = ref('');
const resultDraft = ref({ summary: '', verified: '', unverified: '', remaining: '' });
const titleInput = ref<HTMLInputElement | null>(null);
const empty = (): TaskInput => ({
  title: '',
  description: '',
  expectedResult: '',
  acceptance: '',
  links: [],
  result: null,
  projectId: initialProject,
  state: 'next',
  priority: 'normal',
  completedAt: null,
});
const draft = ref(empty());
const editingId = ref<string | null>(null);
const tasks = computed(() =>
  workspace
    .value!.tasks.filter(
      (t) =>
        (!filter.value ||
          (filter.value === '__general__' ? t.projectId === null : t.projectId === filter.value)) &&
        !!t.completedAt === showDone.value &&
        (!stateFilter.value || t.state === stateFilter.value) &&
        `${t.code} ${t.title} ${t.description}`
          .toLocaleLowerCase('ru')
          .includes(search.value.toLocaleLowerCase('ru')),
    )
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        b.number - a.number,
    ),
);
function reset() {
  draft.value = empty();
  draft.value.projectId = filter.value === '__general__' ? null : filter.value;
  editingId.value = null;
  editingRevision.value = null;
  linksText.value = '';
  resultDraft.value = { summary: '', verified: '', unverified: '', remaining: '' };
  requestKey.value = crypto.randomUUID();
}
async function save() {
  const ok = await act(async () => {
    await api(
      editingId.value ? `/tasks/${editingId.value}` : '/tasks',
      editingId.value ? 'PUT' : 'POST',
      {
        ...draft.value,
        links: lines(linksText.value),
        result: resultDraft.value.summary.trim() ? resultDraft.value : null,
        ...(editingId.value
          ? { revision: editingRevision.value }
          : { requestKey: requestKey.value }),
      },
    );
  }, 'Задача сохранена');
  if (ok) {
    reset();
  }
}
function update(task: Task, change: Partial<TaskInput>) {
  return act(async () => {
    await api(`/tasks/${task.id}`, 'PUT', { ...task, ...change });
  }, 'Задача обновлена');
}
function finish(task: Task) {
  if (task.completedAt) return update(task, { completedAt: null });
  return act(async () => {
    await api(`/tasks/${task.id}/complete`, 'POST', {
      revision: task.revision,
      result: task.result ?? {
        summary: 'Владелец отметил задачу выполненной.',
        verified: '',
        unverified: 'Сведения о проверках не указаны.',
        remaining: '',
      },
    });
  }, 'Задача обновлена');
}
function edit(task: Task) {
  draft.value = { ...task };
  editingId.value = task.id;
  editingRevision.value = task.revision;
  linksText.value = task.links.join('\n');
  resultDraft.value = task.result
    ? { ...task.result }
    : { summary: '', verified: '', unverified: '', remaining: '' };
  window.scrollTo({ top: 0, behavior: 'instant' });
  nextTick(() => titleInput.value?.focus());
}
watch(
  () => route.query.task,
  (identifier) => {
    const task = workspace.value?.tasks.find(
      (item) => item.code === identifier || item.id === identifier,
    );
    if (task) {
      showDone.value = !!task.completedAt;
      edit(task);
    }
  },
  { immediate: true },
);
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">План работы</p>
      <h1>Задачи</h1>
      <p class="subtitle">
        Все задачи в одном месте. Передайте Codex номер CC-N, чтобы начать работу.
      </p>
    </div>
    <RouterLink class="button" :to="filter ? `/history?project=${filter}` : '/history'"
      >История работы →</RouterLink
    >
  </div>
  <form class="panel form" @submit.prevent="save">
    <h2>{{ editingId ? 'Изменить задачу' : 'Новая задача' }}</h2>
    <div class="form-grid">
      <label class="wide"
        >Название задачи<input
          ref="titleInput"
          v-model="draft.title"
          required
          maxlength="240"
          placeholder="Что нужно сделать?" /></label
      ><ProjectSelect v-model="draft.projectId" /><label
        >Когда<select v-model="draft.state">
          <option v-for="(label, key) in taskLabels" :key="key" :value="key">{{ label }}</option>
        </select></label
      ><label
        >Приоритет<select v-model="draft.priority">
          <option v-for="(label, key) in priorityLabels" :key="key" :value="key">
            {{ label }}
          </option>
        </select></label
      ><label class="wide">Описание<textarea v-model="draft.description" rows="2" /></label>
    </div>
    <details class="task-details">
      <summary>Условия и результат работы</summary>
      <div class="form-grid">
        <label class="wide"
          >Ожидаемый результат<textarea v-model="draft.expectedResult" rows="2" maxlength="10000" />
        </label>
        <label class="wide"
          >Условия завершения<textarea v-model="draft.acceptance" rows="2" maxlength="10000" />
        </label>
        <label class="wide"
          >Ссылки и номера решений, по одной в строке<textarea v-model="linksText" rows="2" />
        </label>
        <label class="wide"
          >Что сделано<textarea v-model="resultDraft.summary" rows="2" maxlength="10000" />
        </label>
        <label
          >Что проверено<textarea v-model="resultDraft.verified" rows="2" maxlength="10000" />
        </label>
        <label
          >Что не удалось проверить<textarea
            v-model="resultDraft.unverified"
            rows="2"
            maxlength="10000"
          />
        </label>
        <label class="wide"
          >Что осталось<textarea v-model="resultDraft.remaining" rows="2" maxlength="10000" />
        </label>
      </div>
    </details>
    <div class="row">
      <button class="primary" :disabled="busy">
        {{ editingId ? 'Сохранить задачу' : 'Создать задачу' }}</button
      ><button v-if="editingId" type="button" @click="reset">Отмена</button>
    </div>
  </form>
  <div class="toolbar section-space">
    <label
      >Показать проект<select v-model="filter">
        <option :value="null">Все проекты и общие задачи</option>
        <option value="__general__">Только общие задачи</option>
        <option v-for="project in workspace!.projects" :key="project.id" :value="project.id">
          {{ project.metadata.name }}
        </option>
      </select></label
    ><label
      >Состояние<select v-model="stateFilter">
        <option value="">Все состояния</option>
        <option v-for="(label, key) in taskLabels" :key="key" :value="key">{{ label }}</option>
      </select></label
    >
    <label class="task-search"
      >Поиск задач<input v-model="search" type="search" placeholder="Название или CC-N"
    /></label>
    <label class="checkbox"><input v-model="showDone" type="checkbox" /> Завершённые</label>
  </div>
  <div class="task-board">
    <section v-for="(label, key) in taskLabels" :key="key">
      <h2>
        {{ label }} <span class="count">{{ tasks.filter((t) => t.state === key).length }}</span>
      </h2>
      <article
        v-for="task in tasks.filter((t) => t.state === key)"
        :key="task.id"
        class="panel task-card"
      >
        <div class="row between">
          <code>{{ task.code }}</code
          ><ProjectLink :id="task.projectId" /><span class="priority">{{
            priorityLabels[task.priority]
          }}</span>
        </div>
        <h3>{{ task.title }}</h3>
        <p v-if="task.description" class="preserve muted">{{ task.description }}</p>
        <details
          v-if="task.expectedResult || task.acceptance || task.links.length || task.result"
          class="task-details"
        >
          <summary>Условия и результат</summary>
          <p v-if="task.expectedResult" class="preserve">
            <strong>Ожидаемый результат:</strong> {{ task.expectedResult }}
          </p>
          <p v-if="task.acceptance" class="preserve">
            <strong>Условия завершения:</strong> {{ task.acceptance }}
          </p>
          <p v-for="link in task.links" :key="link" class="preserve">{{ link }}</p>
          <template v-if="task.result">
            <p class="preserve"><strong>Что сделано:</strong> {{ task.result.summary }}</p>
            <p class="preserve">
              <strong>Проверено:</strong> {{ task.result.verified || 'Не указано' }}
            </p>
            <p class="preserve">
              <strong>Не проверено:</strong> {{ task.result.unverified || 'Не указано' }}
            </p>
            <p v-if="task.result.remaining" class="preserve">
              <strong>Осталось:</strong> {{ task.result.remaining }}
            </p>
          </template>
        </details>
        <small v-if="task.completedAt">Завершена: {{ date(task.completedAt) }}</small>
        <div class="row">
          <select
            :value="task.state"
            :aria-label="`Состояние: ${task.title}`"
            :disabled="busy"
            @change="
              update(task, { state: ($event.target as HTMLSelectElement).value as Task['state'] })
            "
          >
            <option v-for="(stateLabel, stateKey) in taskLabels" :key="stateKey" :value="stateKey">
              {{ stateLabel }}
            </option></select
          ><button :disabled="busy" @click="finish(task)">
            {{ task.completedAt ? 'Вернуть' : 'Завершить' }}</button
          ><button class="text-button" @click="edit(task)">Изменить</button>
          <RouterLink :to="`/history?task=${task.code}`">История</RouterLink>
          <RecordDelete
            :id="task.id"
            kind="tasks"
            :title="task.title"
            @deleted="editingId === task.id && reset()"
          />
        </div>
      </article>
      <p v-if="!tasks.some((t) => t.state === key)" class="empty board-empty">Пока пусто</p>
    </section>
  </div>
</template>
<style scoped>
.task-details {
  margin-block: 12px;
}
.task-details summary {
  cursor: pointer;
}
.task-details .form-grid {
  margin-top: 12px;
}
.task-search {
  flex: 1;
  min-width: min(220px, 100%);
}
.task-card code {
  font-weight: 600;
}
.task-card p {
  overflow-wrap: anywhere;
}
</style>
