<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CheckView, CheckEntry, CheckEntryInput } from '../../../shared/checks';
import { api, act, busy, workspace } from '../../shared/api';
import { date, today } from '../../shared/labels';
const props = defineProps<{ check: CheckView }>();
const empty = (): CheckEntryInput => ({
  kind: 'action',
  occurredAt: props.check.completedAt || today(),
  text: '',
  url: '',
  type: null,
  numericValue: null,
});
const draft = ref(empty());
const editingId = ref<string | null>(null);
const entries = computed(() =>
  workspace
    .value!.checkEntries.filter((e) => e.checkId === props.check.id)
    .sort(
      (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.createdAt.localeCompare(a.createdAt),
    ),
);
const types = { fact: 'Факт', observation: 'Наблюдение', problem: 'Проблема', decision: 'Решение' };
async function save() {
  const ok = await act(async () => {
    await api(
      `/checks/${props.check.id}/entries${editingId.value ? '/' + editingId.value : ''}`,
      editingId.value ? 'PUT' : 'POST',
      {
        ...draft.value,
        numericValue:
          draft.value.numericValue === null || String(draft.value.numericValue) === ''
            ? null
            : Number(draft.value.numericValue),
      },
    );
  }, 'Запись сохранена');
  if (ok) {
    editingId.value = null;
    draft.value = empty();
  }
}
function edit(entry: CheckEntry) {
  draft.value = { ...entry };
  editingId.value = entry.id;
}
function remove(entry: CheckEntry) {
  if (!confirm('Удалить запись? Даты последнего действия и свидетельства будут пересчитаны.'))
    return;
  return act(async () => {
    await api(`/checks/${props.check.id}/entries/${entry.id}`, 'DELETE');
    if (editingId.value === entry.id) {
      editingId.value = null;
      draft.value = empty();
    }
  }, 'Запись удалена');
}
</script>
<template>
  <section class="section-space">
    <h2>Действия и свидетельства</h2>
    <form class="panel form section-space" @submit.prevent="save">
      <h3>{{ editingId ? 'Изменить запись' : 'Добавить запись' }}</h3>
      <div class="form-grid">
        <label
          >Вид записи<select v-model="draft.kind">
            <option value="action">Внешнее действие</option>
            <option value="evidence">Свидетельство</option>
          </select></label
        ><label
          >Дата события<input
            v-model="draft.occurredAt"
            type="date"
            required
            :min="check.startedAt"
            :max="check.completedAt || today()"
        /></label>
      </div>
      <label>Что произошло<textarea v-model="draft.text" required rows="3" /></label
      ><label
        >Ссылка (необязательно)<input v-model="draft.url" type="url" placeholder="https://"
      /></label>
      <div v-if="draft.kind === 'evidence'" class="form-grid">
        <label
          >Тип свидетельства<select v-model="draft.type">
            <option :value="null">Не указан</option>
            <option v-for="(label, key) in types" :key="key" :value="key">{{ label }}</option>
          </select></label
        ><label
          >Числовое значение<input v-model.number="draft.numericValue" type="number" step="any"
        /></label>
      </div>
      <div class="row">
        <button class="primary" :disabled="busy">Сохранить запись</button
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
    <div class="timeline section-space">
      <article v-for="entry in entries" :key="entry.id" class="panel">
        <div class="row between">
          <strong>{{ entry.kind === 'action' ? 'Внешнее действие' : 'Свидетельство' }}</strong
          ><time>{{ date(entry.occurredAt) }}</time>
        </div>
        <p class="preserve">{{ entry.text }}</p>
        <p v-if="entry.kind === 'evidence'" class="muted">
          {{ entry.type ? types[entry.type] : 'Без типа'
          }}<span v-if="entry.numericValue !== null"> · {{ entry.numericValue }}</span>
        </p>
        <a v-if="entry.url" :href="entry.url" target="_blank" rel="noopener noreferrer"
          >Открыть источник ↗</a
        >
        <div class="row">
          <button :disabled="busy" @click="edit(entry)">Изменить</button
          ><button :disabled="busy" @click="remove(entry)">Удалить запись</button>
        </div>
      </article>
      <p v-if="!entries.length" class="muted">Внешние шаги и свидетельства ещё не записаны.</p>
    </div>
  </section>
</template>
