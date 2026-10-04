<script setup lang="ts">
import { ref } from 'vue';
import type { CheckInput } from '../../../shared/checks';
import { act, api, busy, workspace } from '../../shared/api';
import { today } from '../../shared/labels';
import ProjectSelect from '../../shared/ProjectSelect.vue';
const props = defineProps<{ initial?: Partial<CheckInput>; id?: string }>();
const emit = defineEmits<{ saved: [id: string]; cancel: [] }>();
const draft = ref<CheckInput>({
  title: '',
  projectId: null,
  ideaId: null,
  question: '',
  assumption: '',
  expectedExternalResult: '',
  startedAt: today(),
  reviewAt: null,
  reviewCondition: '',
  continueIf: '',
  stopIf: '',
  nextExternalAction: '',
  status: 'active',
  ...props.initial,
});
async function save() {
  const duplicate =
    draft.value.status === 'active' &&
    workspace.value!.checks.some(
      (c) =>
        c.id !== props.id && c.ideaId && c.ideaId === draft.value.ideaId && c.status === 'active',
    );
  const existing = workspace.value!.checks.find((c) => c.id === props.id);
  const needsConfirmation =
    duplicate &&
    (!existing || existing.status !== 'active' || existing.ideaId !== draft.value.ideaId);
  if (
    needsConfirmation &&
    !confirm('Для этой идеи уже есть активная проверка. Создать ещё одну параллельную проверку?')
  )
    return;
  let id = '';
  const ok = await act(async () => {
    const result = await api<{ id: string }>(
      props.id ? `/checks/${props.id}` : '/checks',
      props.id ? 'PUT' : 'POST',
      {
        check: { ...draft.value, reviewAt: draft.value.reviewAt || null },
        allowParallel: needsConfirmation,
      },
    );
    id = result.id;
  }, 'Проверка сохранена');
  if (ok) emit('saved', id);
}
</script>
<template>
  <form class="panel form" @submit.prevent="save">
    <h2>{{ id ? 'Изменить проверку' : 'Новая проверка' }}</h2>
    <label>Название проверки<input v-model="draft.title" required maxlength="240" /></label>
    <div class="form-grid">
      <ProjectSelect v-model="draft.projectId" /><label
        >Идея<select v-model="draft.ideaId">
          <option :value="null">Без идеи</option>
          <option v-for="idea in workspace!.ideas" :key="idea.id" :value="idea.id">
            {{ idea.title }}
          </option>
        </select></label
      >
    </div>
    <label>Что хотим выяснить<textarea v-model="draft.question" required rows="2" /></label>
    <label>Предположение<textarea v-model="draft.assumption" required rows="2" /></label>
    <label
      >Ожидаемый внешний результат<textarea
        v-model="draft.expectedExternalResult"
        required
        rows="2"
      />
    </label>
    <div class="form-grid">
      <label>Продолжаем, если<textarea v-model="draft.continueIf" required rows="2" /></label
      ><label>Останавливаемся, если<textarea v-model="draft.stopIf" required rows="2" /></label>
    </div>
    <label
      >Следующий внешний шаг<textarea v-model="draft.nextExternalAction" required rows="2" />
    </label>
    <div class="form-grid">
      <label
        >Дата запуска<input v-model="draft.startedAt" type="date" :max="today()" required /></label
      ><label
        >Дата пересмотра<input v-model="draft.reviewAt" type="date" :min="draft.startedAt"
      /></label>
    </div>
    <label>Условие пересмотра<textarea v-model="draft.reviewCondition" rows="2" /></label>
    <label
      >Состояние проверки<select v-model="draft.status">
        <option value="active">Активна</option>
        <option value="paused">На паузе</option>
      </select></label
    >
    <div class="row">
      <button class="primary" :disabled="busy">
        {{ id ? 'Сохранить проверку' : 'Запустить проверку' }}</button
      ><button type="button" @click="emit('cancel')">Отмена</button>
    </div>
  </form>
</template>
