<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { workspace } from '../../shared/api';
import type { CheckInput } from '../../../shared/checks';
import CheckCard from './CheckCard.vue';
import CheckEditor from './CheckEditor.vue';
const route = useRoute();
const router = useRouter();
const filter = ref('active');
const creating = computed(() => !!(route.query.new || route.query.idea || route.query.next));
const initial = computed<Partial<CheckInput>>(() => {
  const idea = workspace.value!.ideas.find((i) => i.id === route.query.idea);
  const previous = workspace.value!.checks.find((c) => c.id === route.query.next);
  if (idea)
    return {
      title: idea.title,
      question: idea.title,
      assumption: idea.description,
      ideaId: idea.id,
      projectId: idea.projectId,
    };
  if (previous)
    return {
      title: previous.conclusion?.nextQuestion.slice(0, 240) || '',
      question: previous.conclusion?.nextQuestion || '',
      projectId: previous.projectId,
      ideaId: previous.ideaId,
    };
  return { projectId: String(route.query.project ?? '') || null };
});
const checks = computed(() => workspace.value!.checks.filter((c) => c.status === filter.value));
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">От предположения к свидетельствам</p>
      <h1>Проверки</h1>
      <p class="subtitle">Внешние шаги, результаты и время принять решение.</p>
    </div>
    <RouterLink v-if="!creating" to="/checks?new=1" class="button primary"
      >Новая проверка</RouterLink
    >
  </div>
  <CheckEditor
    v-if="creating"
    :key="route.fullPath"
    :initial="initial"
    @saved="(id) => router.push(`/checks/${id}`)"
    @cancel="router.push('/checks')"
  />
  <template v-else
    ><div class="filter-bar section-space">
      <button
        v-for="(label, key) in { active: 'Активные', paused: 'На паузе', completed: 'Архив' }"
        :key="key"
        :class="{ active: filter === key }"
        :aria-pressed="filter === key"
        @click="filter = key"
      >
        {{ label }} · {{ workspace!.checks.filter((c) => c.status === key).length }}
      </button>
    </div>
    <div class="check-register section-space">
      <CheckCard v-for="check in checks" :key="check.id" :check="check" />
    </div>
    <p v-if="!checks.length" class="panel empty section-space">
      Проверок в этом разделе пока нет. Начните с идеи или создайте проверку.
    </p></template
  >
</template>
