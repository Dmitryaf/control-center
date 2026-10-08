<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  AnalysisStatus,
  AnalysisPreview,
  AnalysisResult,
  AnalysisReport,
} from '../../../shared/analysis';
import type { Task } from '../../../shared/contracts';
import { api, reload, workspace } from '../../shared/api';
import { priorityLabels } from '../../shared/labels';

const selection = ref<string[]>([]);
const status = ref<AnalysisStatus | null>(null);
const preview = ref<AnalysisPreview | null>(null);
const result = ref<AnalysisResult | null>(null);
const working = ref(false);
const failure = ref('');
const reviewed = ref(false);
type Draft = AnalysisReport['proposals'][number] & { created: Task | null };
const drafts = ref<Draft[]>([]);
let version = 0;
const clock = ref(Date.now());
const interval = setInterval(() => {
  clock.value = Date.now();
}, 1000);
const payloadText = computed(() =>
  preview.value ? JSON.stringify(preview.value.payload, null, 2) : '',
);
const timestamp = (value: string) => new Date(value).toLocaleString('ru');
const expired = computed(
  () => !!preview.value && Date.parse(preview.value.expiresAt) <= clock.value,
);
watch(selection, () => {
  preview.value = null;
  result.value = null;
  drafts.value = [];
  reviewed.value = false;
});
onUnmounted(() => {
  version++;
  clearInterval(interval);
});
async function action(callback: () => Promise<void>) {
  if (working.value) return;
  const current = ++version;
  working.value = true;
  failure.value = '';
  try {
    await callback();
  } catch (cause) {
    if (current === version)
      failure.value = cause instanceof Error ? cause.message : 'Не удалось выполнить действие.';
  } finally {
    if (current === version) working.value = false;
  }
}
async function loadStatus() {
  const current = version;
  const response = await api<AnalysisStatus>('/analysis/status');
  if (current === version) status.value = response;
}
onMounted(() => action(loadStatus));
async function prepare() {
  await action(async () => {
    const current = version;
    const response = await api<AnalysisPreview>('/analysis/prepare', 'POST', {
      projectIds: selection.value,
    });
    if (current !== version) return;
    preview.value = response;
    status.value = response.config;
    result.value = null;
    drafts.value = [];
    reviewed.value = false;
  });
}
async function run() {
  if (!preview.value || !reviewed.value) return;
  await action(async () => {
    const current = version;
    const response = await api<AnalysisResult>('/analysis/run', 'POST', {
      previewId: preview.value!.id,
      consent: true,
    });
    if (current !== version) return;
    result.value = response;
    drafts.value = response.report.proposals.map((proposal) => ({ ...proposal, created: null }));
  });
}
async function create(index: number) {
  const draft = drafts.value[index];
  if (!result.value || !draft || draft.created) return;
  await action(async () => {
    const current = version;
    const task = await api<Task>('/tasks', 'POST', {
      projectId: draft.projectId,
      title: draft.title,
      description: draft.description,
      expectedResult: draft.expectedResult,
      acceptance: draft.acceptance,
      priority: draft.priority,
      state: 'next',
      requestKey: `analysis:${result.value!.previewId}:${index}`,
    });
    if (current !== version) return;
    draft.created = task;
    // A failed workspace refresh must not conceal a successful task write.
    await reload();
  });
}
function projectName(id: string | null) {
  return (
    preview.value?.payload.projects.find((project) => project.id === id)?.name ??
    'Неизвестный проект'
  );
}
function sourceLabel(source: string) {
  const projects = preview.value?.payload.projects ?? [];
  for (const project of projects) {
    if (source === project.source) return `Сводка: ${project.name}`;
    const task = project.tasks.find((item) => item.source === source);
    if (task) return `${task.code}: ${task.title}`;
    const history = project.recentWork.find((item) => item.source === source);
    if (history) return `${history.taskCode}, запись ${timestamp(history.recordedAt)}`;
  }
  return source;
}
</script>

<template>
  <div class="analysis-page">
    <div class="page-head">
      <div>
        <p class="eyebrow">Выбор следующего шага</p>
        <h1>Анализ проектов</h1>
      </div>
      <RouterLink to="/">К обзору →</RouterLink>
    </div>
    <p>
      Выберите проекты, просмотрите данные и запросите предложения у OpenAI. Каждую задачу вы
      создаёте отдельно.
    </p>
    <div v-if="failure" class="message error" role="alert" aria-label="Анализ проектов">
      {{ failure }}
    </div>
    <p v-if="working" role="status">Выполняем запрос…</p>
    <div v-if="status && !status.ready" class="message warning">
      <strong>OpenAI не настроен</strong>
      <p>Добавьте API-ключ и модель в окружение сервера. Данные можно просмотреть заранее.</p>
      <details>
        <summary>Как подключить</summary>
        <p>
          Задайте <code>OPENAI_API_KEY</code> и <code>CONTROL_CENTER_OPENAI_MODEL</code> перед
          запуском Control Center, затем перезапустите сервер. Ключ не вводится в браузере и не
          сохраняется в базе.
        </p>
        <button :disabled="working" @click="action(loadStatus)">Проверить настройки</button>
      </details>
    </div>
    <fieldset :disabled="working" class="project-selection">
      <legend>Проекты для анализа · до 10</legend>
      <label v-for="project in workspace!.projects" :key="project.id" class="checkbox">
        <input v-model="selection" type="checkbox" :value="project.id" />
        <span
          >{{ project.metadata.name
          }}<small v-if="!project.available"> · сохранённый снимок, каталог недоступен</small></span
        >
      </label>
      <p v-if="!workspace!.projects.length" class="empty">
        Добавьте проекты в настройках и выполните сканирование.
      </p>
    </fieldset>
    <button :disabled="working || !selection.length || selection.length > 10" @click="prepare">
      Просмотреть данные
    </button>
    <section
      v-if="preview"
      class="section-space analysis-preview"
      aria-labelledby="preview-heading"
    >
      <h2 id="preview-heading">Данные для отправки</h2>
      <p>
        Подготовлены {{ timestamp(preview.payload.preparedAt) }}. Пакет действителен до
        {{ timestamp(preview.expiresAt) }}.
      </p>
      <p>
        Включены сводки, открытые задачи и по 5 последних записей работы выбранных проектов. Файлы,
        Git, заметки и приватные решения не включены. Сохранённые сведения могут устареть; пакет
        ниже останется неизменным при отправке.
      </p>
      <p class="help">
        Сводки и результаты могут содержать личные сведения. Проверьте весь текст; при необходимости
        исключите проект или исправьте исходную запись. Автоматическая проверка не распознаёт все
        секреты.
      </p>
      <pre tabindex="0" aria-label="Полный пакет данных">{{ payloadText }}</pre>
      <p>
        Получатель: OpenAI · модель {{ preview.config.model || 'не задана' }}. Один платный запрос,
        до {{ preview.config.maxOutputTokens }} выходных токенов, ожидание до
        {{ preview.config.timeoutSeconds }} секунд. Цена зависит от модели и объёма; повтор не
        выполняется автоматически.
      </p>
      <p class="help">
        Ответ не сохраняется как состояние OpenAI (<code>store: false</code>); это не обещание
        отсутствия иных сроков хранения у провайдера. Предложения живут на этом экране и исчезнут
        после его закрытия.
      </p>
      <label class="checkbox"
        ><input v-model="reviewed" type="checkbox" :disabled="working || !!result" /><span
          >Я просмотрел данные и разрешаю отправить этот пакет в OpenAI</span
        ></label
      >
      <button
        class="primary"
        :disabled="working || !reviewed || !preview.config.ready || !!result || expired"
        @click="run"
      >
        Отправить в OpenAI
      </button>
      <p v-if="expired && !result" class="help">Срок пакета истёк. Подготовьте данные заново.</p>
    </section>
    <section v-if="result" class="section-space analysis-result" aria-labelledby="result-heading">
      <h2 id="result-heading">Предложения</h2>
      <p class="preserve">{{ result.report.summary }}</p>
      <p class="help">
        {{ result.model }} · {{ timestamp(result.generatedAt)
        }}<template v-if="result.usage">
          · входных токенов {{ result.usage.inputTokens }}, выходных
          {{ result.usage.outputTokens }}</template
        >. Это предложения модели; фактическая работа и проверки не выполнялись.
      </p>
      <p v-if="!drafts.length" class="empty">Новых задач модель не предложила.</p>
      <article v-for="(draft, index) in drafts" :key="index" class="proposal">
        <h3>{{ projectName(draft.projectId) }}</h3>
        <p class="preserve">{{ draft.reason }}</p>
        <p class="help">Основания:</p>
        <ul>
          <li v-for="source in draft.sources" :key="source">{{ sourceLabel(source) }}</li>
        </ul>
        <fieldset :disabled="working || !!draft.created" class="form">
          <legend>Предложение {{ index + 1 }}</legend>
          <label>Название<input v-model="draft.title" maxlength="240" /></label>
          <label>Описание<textarea v-model="draft.description" rows="2" maxlength="10000" /></label>
          <label
            >Ожидаемый результат<textarea
              v-model="draft.expectedResult"
              rows="2"
              maxlength="10000"
            />
          </label>
          <label
            >Условия завершения<textarea v-model="draft.acceptance" rows="2" maxlength="10000" />
          </label>
          <label
            >Приоритет<select v-model="draft.priority">
              <option v-for="(label, value) in priorityLabels" :key="value" :value="value">
                {{ label }}
              </option>
            </select></label
          >
        </fieldset>
        <RouterLink v-if="draft.created" :to="`/tasks?task=${draft.created.code}`"
          >Открыть {{ draft.created.code }} →</RouterLink
        >
        <button v-else :disabled="working || !draft.title.trim()" @click="create(index)">
          Создать задачу «Следом»
        </button>
      </article>
    </section>
  </div>
</template>
<style scoped>
fieldset {
  border: 1px solid var(--line);
  margin: 0 0 16px;
  padding: 14px;
  min-width: 0;
}
legend {
  font-weight: 600;
  padding: 0 5px;
}
.project-selection {
  max-height: 360px;
  overflow-y: auto;
}
.checkbox {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 10px 0;
}
.checkbox input {
  width: auto;
  margin-top: 5px;
  flex-shrink: 0;
}
.checkbox span,
.proposal li {
  overflow-wrap: anywhere;
}
pre {
  background: var(--paper);
  border: 1px solid var(--line);
  padding: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 440px;
  overflow-y: auto;
  font-size: 0.9rem;
}
.proposal {
  border-top: 1px solid var(--line);
  padding: 18px 0;
}
.proposal .form {
  max-width: 850px;
}
@media (max-width: 600px) {
  fieldset,
  pre {
    padding: 10px;
  }
}
</style>
