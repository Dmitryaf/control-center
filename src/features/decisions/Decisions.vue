<script setup lang="ts">
import { ref } from 'vue';
import type { Decision, DecisionInput } from '../../../shared/contracts';
import { api, act, busy, workspace } from '../../shared/api';
import { decisionLabels, date, today } from '../../shared/labels';
import ProjectSelect from '../../shared/ProjectSelect.vue';
import ProjectLink from '../../shared/ProjectLink.vue';
import RecordDelete from '../../shared/RecordDelete.vue';
import DecisionFiles from './DecisionFiles.vue';
const empty = (): DecisionInput => ({
  title: '',
  context: '',
  decision: '',
  reason: '',
  projectId: null,
  date: today(),
  status: 'active',
});
const draft = ref(empty());
const editingId = ref<string | null>(null);
async function save() {
  const ok = await act(async () => {
    await api(
      editingId.value ? `/decisions/${editingId.value}` : '/decisions',
      editingId.value ? 'PUT' : 'POST',
      draft.value,
    );
  }, 'Решение сохранено');
  if (ok) {
    draft.value = empty();
    editingId.value = null;
  }
}
function edit(decision: Decision) {
  draft.value = { ...decision };
  editingId.value = decision.id;
  window.scrollTo({ top: 0, behavior: 'instant' });
}
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">Журнал</p>
      <h1>Решения</h1>
      <p class="subtitle">Что выбрано и почему — чтобы не вспоминать заново.</p>
    </div>
  </div>
  <DecisionFiles />
  <h2 class="section-space">Общие решения экосистемы</h2>
  <p class="help">
    Новые проектные решения добавляйте в канонические файлы. Существующие локальные записи сохранены
    ниже.
  </p>
  <form class="panel form" @submit.prevent="save">
    <h2>{{ editingId ? 'Изменить решение' : 'Записать решение' }}</h2>
    <label>Название решения<input v-model="draft.title" required maxlength="240" /></label>
    <div class="form-grid">
      <label>Контекст<textarea v-model="draft.context" rows="3" /></label
      ><label>Решение<textarea v-model="draft.decision" required rows="3" /></label>
    </div>
    <label>Почему<textarea v-model="draft.reason" rows="2" /></label>
    <div class="form-grid">
      <ProjectSelect v-if="editingId" v-model="draft.projectId" /><label
        >Статус<select v-model="draft.status">
          <option v-for="(label, key) in decisionLabels" :key="key" :value="key">
            {{ label }}
          </option>
        </select></label
      ><label>Дата<input v-model="draft.date" type="date" required /></label>
    </div>
    <div class="row">
      <button class="primary" :disabled="busy">
        {{ editingId ? 'Сохранить решение' : 'Добавить решение' }}</button
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
      Журнал решений <span class="count">{{ workspace!.decisions.length }}</span>
    </h2>
  </div>
  <div class="record-list">
    <article v-for="decision in workspace!.decisions" :key="decision.id" class="panel prose">
      <div class="row between">
        <ProjectLink :id="decision.projectId" /><span class="badge">{{
          decisionLabels[decision.status]
        }}</span>
      </div>
      <h3>{{ decision.title }}</h3>
      <p class="section-label">
        {{ decision.projectId ? 'Локальное решение Control Center' : 'Общее решение экосистемы' }}
      </p>
      <p v-if="decision.context" class="muted preserve">{{ decision.context }}</p>
      <p class="preserve">{{ decision.decision }}</p>
      <template v-if="decision.reason"
        ><h4>Почему</h4>
        <p class="preserve">{{ decision.reason }}</p></template
      >
      <div class="row between">
        <small>{{ date(decision.date) }}</small
        ><button @click="edit(decision)">Изменить</button>
        <RecordDelete
          :id="decision.id"
          kind="decisions"
          :title="decision.title"
          @deleted="editingId === decision.id && ((editingId = null), (draft = empty()))"
        />
      </div>
    </article>
  </div>
  <p v-if="!workspace!.decisions.length" class="panel empty section-space">
    Решений пока нет. Запишите выбор и его причину.
  </p>
</template>
