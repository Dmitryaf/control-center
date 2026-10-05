<script setup lang="ts">
import { computed } from 'vue';
import type { Project } from '../../../shared/contracts';
import { workspace } from '../../shared/api';
import { statusLabels, typeLabels, date } from '../../shared/labels';
const props = defineProps<{ project: Project }>();
const checks = computed(() =>
  workspace.value!.checks.filter((c) => c.projectId === props.project.id && c.status === 'active'),
);
const latestAction = computed(() =>
  checks.value
    .map((c) => c.lastExternalActionAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1),
);
</script>
<template>
  <article class="project-row">
    <div class="project-identity">
      <p class="section-label">
        {{ typeLabels[project.metadata.type] }} · {{ statusLabels[project.metadata.status] }}
      </p>
      <h3>
        <RouterLink :to="`/projects/${project.id}`">{{ project.metadata.name }}</RouterLink>
      </h3>
      <p v-if="project.metadata.priority === 'high'" class="priority">↑ Высокий приоритет</p>
    </div>
    <div class="project-focus">
      <p>{{ project.metadata.current_focus || 'Текущий фокус ещё не задан' }}</p>
      <p class="help">Далее · {{ project.metadata.next[0] || 'Шаг пока не определён' }}</p>
    </div>
    <div class="project-activity">
      <p>{{ checks.length }} активных проверок</p>
      <p class="help">
        Внешний шаг: {{ latestAction ? date(latestAction) : 'нет записи в активных проверках' }}
      </p>
      <p class="help">
        {{
          project.snapshot.git.present
            ? `Git: ${date(project.snapshot.git.commits[0]?.date)}`
            : 'Без Git'
        }}
      </p>
      <p v-if="!project.available" class="warning-text">Каталог недоступен · сохранённый снимок</p>
      <p v-else-if="project.snapshot.git.dirty" class="help">Есть незакоммиченные изменения</p>
    </div>
  </article>
</template>
