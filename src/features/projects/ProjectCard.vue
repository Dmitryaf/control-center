<script setup lang="ts">
import type { Project } from '../../../shared/contracts';
import { statusLabels, typeLabels, date } from '../../shared/labels';
defineProps<{ project: Project }>();
</script>
<template>
  <article class="project-card">
    <div class="row between">
      <span class="eyebrow">{{ typeLabels[project.metadata.type] }}</span
      ><span class="badge" :class="project.metadata.status">{{
        statusLabels[project.metadata.status]
      }}</span>
    </div>
    <h3>
      <RouterLink :to="`/projects/${project.id}`">{{ project.metadata.name }}</RouterLink>
    </h3>
    <p class="focus-text">{{ project.metadata.current_focus || 'Текущий фокус ещё не задан' }}</p>
    <div class="next-step">
      <span>Следующий шаг</span>
      <p>{{ project.metadata.next[0] || 'Пока не определён' }}</p>
    </div>
    <footer class="row between">
      <span>Commit: {{ date(project.snapshot.git.commits[0]?.date) }}</span
      ><span v-if="project.metadata.priority === 'high'" class="priority">↑ Высокий</span>
    </footer>
    <p v-if="!project.available" class="warning-text">Каталог недоступен · сохранённый снимок</p>
    <p v-else-if="project.snapshot.git.dirty" class="warning-text">
      ● Есть незакоммиченные изменения
    </p>
  </article>
</template>
