<script setup lang="ts">
import type { CheckView } from '../../../shared/checks';
import { date, today } from '../../shared/labels';
import { daysBetween } from '../../../shared/time';
import ProjectLink from '../../shared/ProjectLink.vue';
defineProps<{ check: CheckView }>();
const statuses = { active: 'Активна', paused: 'На паузе', completed: 'Завершена' };
function since(value: string | null) {
  return value ? `${date(value)} · ${daysBetween(value, today())} дн. назад` : 'Ещё не записано';
}
</script>
<template>
  <article class="panel check-card">
    <div class="row between">
      <ProjectLink :id="check.projectId" /><span class="badge">{{ statuses[check.status] }}</span>
    </div>
    <h3>
      <RouterLink :to="`/checks/${check.id}`">{{ check.title }}</RouterLink>
    </h3>
    <p class="preserve">{{ check.question }}</p>
    <dl class="check-dates">
      <dt>Запущена</dt>
      <dd>
        {{ date(check.startedAt) }} · {{ check.daysActive }} дн.{{
          check.completedAt ? ' до завершения' : ' с запуска'
        }}
      </dd>
      <dt>Последний внешний шаг</dt>
      <dd>{{ since(check.lastExternalActionAt) }}</dd>
      <dt>Последнее свидетельство</dt>
      <dd>{{ since(check.lastEvidenceAt) }}</dd>
      <dt>Пересмотр</dt>
      <dd>{{ check.reviewAt ? date(check.reviewAt) : check.reviewCondition || 'Не задан' }}</dd>
    </dl>
    <p v-for="signal in check.signals" :key="signal.code" class="signal" :class="signal.level">
      {{ signal.message }}
    </p>
    <div v-if="check.status !== 'completed'" class="next-step">
      <span>Следующий внешний шаг</span>
      <p>{{ check.nextExternalAction }}</p>
    </div>
    <p v-else class="muted">Завершена: {{ date(check.completedAt) }}</p>
  </article>
</template>
