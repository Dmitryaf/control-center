<script setup lang="ts">
import { ref } from 'vue';
import type { Idea, IdeaInput } from '../../../shared/contracts';
import { api, act, busy, workspace } from '../../shared/api';
import { ideaLabels, date } from '../../shared/labels';
import ProjectSelect from '../../shared/ProjectSelect.vue';
import ProjectLink from '../../shared/ProjectLink.vue';
import RecordDelete from '../../shared/RecordDelete.vue';
import { daysBetween } from '../../../shared/time';
import { today } from '../../shared/labels';
const empty = (): IdeaInput => ({ title: '', description: '', projectId: null, state: 'new' });
const draft = ref(empty());
const editingId = ref<string | null>(null);
async function save() {
  const ok = await act(async () => {
    await api(
      editingId.value ? `/ideas/${editingId.value}` : '/ideas',
      editingId.value ? 'PUT' : 'POST',
      draft.value,
    );
  }, 'Идея сохранена');
  if (ok) {
    draft.value = empty();
    editingId.value = null;
  }
}
function update(idea: Idea, state: Idea['state']) {
  return act(async () => {
    await api(`/ideas/${idea.id}`, 'PUT', { ...idea, state });
  }, 'Состояние идеи обновлено');
}
function edit(idea: Idea) {
  draft.value = { ...idea };
  editingId.value = idea.id;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">Входящие</p>
      <h1>Идеи</h1>
      <p class="subtitle">Сохранить мысль сейчас, разобраться позже.</p>
    </div>
  </div>
  <form class="panel form" @submit.prevent="save">
    <h2>{{ editingId ? 'Изменить идею' : 'Новая идея' }}</h2>
    <label
      >Название идеи<input
        v-model="draft.title"
        required
        maxlength="240"
        placeholder="Что стоит попробовать?" /></label
    ><label>Описание<textarea v-model="draft.description" rows="3" /></label>
    <div class="form-grid">
      <ProjectSelect v-model="draft.projectId" /><label
        >Состояние<select v-model="draft.state">
          <option v-for="(label, key) in ideaLabels" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
    </div>
    <div class="row">
      <button class="primary" :disabled="busy">
        {{ editingId ? 'Сохранить идею' : 'Добавить идею' }}</button
      ><button
        v-if="editingId"
        type="button"
        @click="
          draft = empty();
          editingId = null;
        "
      >
        Отмена
      </button>
    </div>
  </form>
  <div class="section-heading section-space">
    <h2>
      Все идеи <span class="count">{{ workspace!.ideas.length }}</span>
    </h2>
  </div>
  <div class="record-list">
    <article v-for="idea in workspace!.ideas" :key="idea.id" class="panel">
      <div class="row between">
        <ProjectLink :id="idea.projectId" /><small>{{ date(idea.createdAt) }}</small>
      </div>
      <h3>{{ idea.title }}</h3>
      <p class="idea-age">
        Идея существует: {{ daysBetween(idea.createdAt, today()) }} дн. · {{ date(idea.createdAt) }}
      </p>
      <p class="preserve">{{ idea.description }}</p>
      <div class="row">
        <select
          :value="idea.state"
          :aria-label="`Состояние: ${idea.title}`"
          :disabled="busy"
          @change="update(idea, ($event.target as HTMLSelectElement).value as Idea['state'])"
        >
          <option v-for="(label, key) in ideaLabels" :key="key" :value="key">
            {{ label }}
          </option></select
        ><button @click="edit(idea)">Изменить</button>
        <RouterLink :to="`/checks?idea=${idea.id}`" class="button">Начать проверку</RouterLink>
        <RecordDelete
          :id="idea.id"
          kind="ideas"
          :title="idea.title"
          @deleted="editingId === idea.id && ((editingId = null), (draft = empty()))"
        />
      </div>
      <p v-for="check in workspace!.checks.filter((c) => c.ideaId === idea.id)" :key="check.id">
        <RouterLink :to="`/checks/${check.id}`">{{ check.title }}</RouterLink> ·
        {{
          check.status === 'completed'
            ? 'В архиве'
            : check.status === 'paused'
              ? 'На паузе'
              : 'Активна'
        }}
      </p>
    </article>
  </div>
  <p v-if="!workspace!.ideas.length" class="panel empty section-space">
    Список свободен. Добавьте первую мысль — проект выбирать необязательно.
  </p>
</template>
