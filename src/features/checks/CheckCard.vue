<script setup lang="ts">
import { computed } from 'vue';
import type { CheckView } from '../../../shared/checks';
import { date } from '../../shared/labels';
import ProjectLink from '../../shared/ProjectLink.vue';
const props = defineProps<{ check: CheckView; compact?: boolean; detail?: boolean }>();
const statuses = { active: 'Активна', paused: 'На паузе', completed: 'Завершена' };
const level = computed(() =>
  props.check.signals.some((s) => s.level === 'decision')
    ? 'decision'
    : props.check.signals.some((s) => s.level === 'attention')
      ? 'attention'
      : 'info',
);
</script>
<template>
  <article class="check-card" :class="[level, { compact, 'check-summary': detail }]">
    <div class="movement-clock">
      <strong>{{ check.daysWithoutMovement }}<small>дн.</small></strong>
      <span>{{
        check.status === 'completed' ? 'без шага к завершению' : 'без внешнего шага'
      }}</span>
      <span class="clock-state">{{ statuses[check.status] }}</span>
    </div>
    <div class="check-reading">
      <div class="row between">
        <ProjectLink :id="check.projectId" /><span class="help"
          >{{ date(check.startedAt) }} · {{ check.daysActive }} дн.{{
            check.completedAt ? ' до завершения' : ' с запуска'
          }}</span
        >
      </div>
      <h3 v-if="!detail">
        <RouterLink :to="`/checks/${check.id}`">{{ check.title }}</RouterLink>
      </h3>
      <p v-if="!compact" class="check-question preserve">{{ check.question }}</p>
      <dl v-if="!compact" class="check-dates">
        <dt>Последний внешний шаг</dt>
        <dd>
          {{ check.lastExternalActionAt ? date(check.lastExternalActionAt) : 'Ещё не записано'
          }}<span v-if="check.lastExternalActionAt">
            · {{ check.daysWithoutMovement }} дн.{{
              check.completedAt ? ' до завершения' : ' назад'
            }}</span
          >
        </dd>
        <dt>Последнее свидетельство</dt>
        <dd>{{ check.lastEvidenceAt ? date(check.lastEvidenceAt) : 'Ещё не записано' }}</dd>
        <dt>Пересмотр</dt>
        <dd>{{ check.reviewAt ? date(check.reviewAt) : check.reviewCondition || 'Не задан' }}</dd>
      </dl>
      <p v-else class="help">
        Шаг: {{ date(check.lastExternalActionAt) }} · Свидетельство: {{ date(check.lastEvidenceAt)
        }}<template v-if="check.reviewAt"> · Пересмотр: {{ date(check.reviewAt) }}</template>
      </p>
      <template v-if="!compact"
        ><p v-for="signal in check.signals" :key="signal.code" class="signal" :class="signal.level">
          <strong
            >{{
              signal.level === 'decision'
                ? 'Решение'
                : signal.level === 'attention'
                  ? 'Внимание'
                  : 'Информация'
            }}.</strong
          >
          {{ signal.message }}
        </p></template
      >
      <div v-if="check.status !== 'completed'" class="next-step">
        <span>Следующий внешний шаг</span>
        <p>{{ check.nextExternalAction }}</p>
      </div>
      <p v-else class="muted">Завершена: {{ date(check.completedAt) }}</p>
    </div>
  </article>
</template>
