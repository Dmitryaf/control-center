<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { Conclusion, CheckInput } from '../../../shared/checks';
import { act, api, busy, workspace } from '../../shared/api';
import { date, today } from '../../shared/labels';
import CheckCard from './CheckCard.vue';
import CheckEditor from './CheckEditor.vue';
import CheckTimeline from './CheckTimeline.vue';
const route = useRoute();
const check = computed(() => workspace.value!.checks.find((c) => c.id === route.params.id));
const editing = ref(false);
const finishing = ref(false);
const conclusion = ref<Conclusion>({
  actualResult: '',
  whatWasConfirmedOrRejected: '',
  outcome: 'continue',
  basis: '',
  nextQuestion: '',
  completedAt: today(),
});
const outcomes = { continue: 'Продолжить', change: 'Изменить', stop: 'Остановить' };
async function complete() {
  if (!confirm('Завершить проверку с этим итогом и перенести в архив?')) return;
  const ok = await act(async () => {
    await api(`/checks/${check.value!.id}/complete`, 'POST', conclusion.value);
  }, 'Проверка завершена и сохранена в архиве');
  if (ok) finishing.value = false;
}
</script>
<template>
  <template v-if="check"
    ><RouterLink to="/checks" class="back-link">← Все проверки</RouterLink>
    <div class="page-heading">
      <div>
        <h1>{{ check.title }}</h1>
        <p class="subtitle">
          Git показывает работу над проектом. Здесь — движение к внешнему подтверждению.
        </p>
      </div>
      <div v-if="check.status !== 'completed'" class="row">
        <button
          @click="
            editing = !editing;
            finishing = false;
          "
        >
          Изменить проверку</button
        ><button
          @click="
            finishing = !finishing;
            editing = false;
          "
        >
          Завершить проверку
        </button>
      </div>
    </div>
    <CheckEditor
      v-if="editing"
      :id="check.id"
      :initial="check as CheckInput"
      @saved="editing = false"
      @cancel="editing = false"
    />
    <CheckCard :check="check" class="section-space" />
    <section class="panel prose section-space">
      <h2>Условия проверки</h2>
      <h3>Предположение</h3>
      <p>{{ check.assumption }}</p>
      <h3>Ожидаемый внешний результат</h3>
      <p>{{ check.expectedExternalResult }}</p>
      <h3>Продолжаем, если</h3>
      <p>{{ check.continueIf }}</p>
      <h3>Останавливаемся, если</h3>
      <p>{{ check.stopIf }}</p>
      <h3>Пересмотр</h3>
      <p>
        {{ check.reviewCondition || 'Условие не задано'
        }}<span v-if="check.reviewAt"> · {{ date(check.reviewAt) }}</span>
      </p>
      <p v-if="check.ideaId">
        Идея: {{ workspace!.ideas.find((i) => i.id === check?.ideaId)?.title }} ·
        <RouterLink to="/ideas">Открыть идеи</RouterLink>
      </p>
    </section>
    <form v-if="finishing" class="panel form section-space" @submit.prevent="complete">
      <h2>Итог проверки</h2>
      <label
        >Фактический результат<textarea
          v-model="conclusion.actualResult"
          required
          rows="3"
        /></label
      ><label
        >Что подтвердилось / не подтвердилось<textarea
          v-model="conclusion.whatWasConfirmedOrRejected"
          required
          rows="3"
        /></label
      ><label
        >Итоговое решение<select v-model="conclusion.outcome">
          <option v-for="(label, key) in outcomes" :key="key" :value="key">{{ label }}</option>
        </select></label
      ><label>Почему<textarea v-model="conclusion.basis" required rows="3" /></label
      ><label>Следующий вопрос<textarea v-model="conclusion.nextQuestion" rows="2" /></label
      ><label
        >Дата завершения<input
          v-model="conclusion.completedAt"
          type="date"
          :min="check.startedAt"
          :max="today()"
          required /></label
      ><button class="primary" :disabled="busy">Сохранить итог и завершить</button>
    </form>
    <section v-if="check.conclusion" class="panel prose section-space">
      <h2>Итог · {{ outcomes[check.conclusion.outcome] }}</h2>
      <h3>Фактический результат</h3>
      <p>{{ check.conclusion.actualResult }}</p>
      <h3>Что подтвердилось / не подтвердилось</h3>
      <p>{{ check.conclusion.whatWasConfirmedOrRejected }}</p>
      <h3>Почему</h3>
      <p>{{ check.conclusion.basis }}</p>
      <template v-if="check.conclusion.nextQuestion"
        ><h3>Следующий вопрос</h3>
        <p>{{ check.conclusion.nextQuestion }}</p>
        <RouterLink :to="`/checks?next=${check.id}`" class="button"
          >Создать следующую проверку</RouterLink
        ></template
      >
    </section>
    <CheckTimeline :key="check.id" :check="check" />
  </template>
  <p v-else class="empty">Проверка не найдена.</p>
</template>
