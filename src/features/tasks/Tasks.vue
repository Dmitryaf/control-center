<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { Task, TaskInput } from '../../../shared/contracts';
import { act, api, busy, workspace } from '../../shared/api';
import { taskLabels, priorityLabels } from '../../shared/labels';
import ProjectSelect from '../../shared/ProjectSelect.vue';
import ProjectLink from '../../shared/ProjectLink.vue';
const route = useRoute();
const initialProject = String(route.query.project ?? '') || null;
const filter = ref<string | null>(initialProject);
const showDone = ref(false);
const empty = (): TaskInput => ({
  title: '',
  description: '',
  projectId: initialProject,
  state: 'next',
  priority: 'normal',
  completedAt: null,
});
const draft = ref(empty());
const editingId = ref<string | null>(null);
const tasks = computed(() =>
  workspace.value!.tasks.filter(
    (t) => (!filter.value || t.projectId === filter.value) && !!t.completedAt === showDone.value,
  ),
);
async function save() {
  const ok = await act(async () => {
    await api(
      editingId.value ? `/tasks/${editingId.value}` : '/tasks',
      editingId.value ? 'PUT' : 'POST',
      draft.value,
    );
  }, 'Задача сохранена');
  if (ok) {
    draft.value = empty();
    editingId.value = null;
  }
}
function update(task: Task, change: Partial<TaskInput>) {
  return act(async () => {
    await api(`/tasks/${task.id}`, 'PUT', { ...task, ...change });
  }, 'Задача обновлена');
}
function edit(task: Task) {
  draft.value = { ...task };
  editingId.value = task.id;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="eyebrow">ПЛАН РАБОТЫ</p>
      <h1>Задачи</h1>
      <p class="subtitle">Три состояния, чтобы выбрать главное.</p>
    </div>
  </div>
  <form class="panel form" @submit.prevent="save">
    <h2>{{ editingId ? 'Изменить задачу' : 'Новая задача' }}</h2>
    <div class="form-grid">
      <label class="wide"
        >Название задачи<input
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
    <div class="row">
      <button class="primary" :disabled="busy">
        {{ editingId ? 'Сохранить задачу' : 'Создать задачу' }}</button
      ><button
        v-if="editingId"
        type="button"
        @click="
          editingId = null;
          draft = empty();
        "
      >
        Отмена
      </button>
    </div>
  </form>
  <div class="toolbar section-space">
    <label
      >Показать проект<select v-model="filter">
        <option :value="null">Все проекты и общие задачи</option>
        <option v-for="project in workspace!.projects" :key="project.id" :value="project.id">
          {{ project.metadata.name }}
        </option>
      </select></label
    ><label class="checkbox"><input v-model="showDone" type="checkbox" /> Завершённые</label>
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
          <ProjectLink :id="task.projectId" /><span v-if="task.priority === 'high'" class="priority"
            >↑ Высокий</span
          >
        </div>
        <h3>{{ task.title }}</h3>
        <p v-if="task.description" class="preserve muted">{{ task.description }}</p>
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
          ><button
            :disabled="busy"
            @click="
              update(task, { completedAt: task.completedAt ? null : new Date().toISOString() })
            "
          >
            {{ task.completedAt ? 'Вернуть' : 'Завершить' }}</button
          ><button class="text-button" @click="edit(task)">Изменить</button>
        </div>
      </article>
      <p v-if="!tasks.some((t) => t.state === key)" class="empty board-empty">Пока пусто</p>
    </section>
  </div>
</template>
