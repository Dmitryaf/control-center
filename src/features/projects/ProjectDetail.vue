<script setup lang="ts">
import { computed, ref, watch, toRaw } from 'vue';
import { useRoute } from 'vue-router';
import type { Metadata, Project, Relation } from '../../../shared/contracts';
import ProjectMaintenance from './ProjectMaintenance.vue';
import ProjectRemoval from './ProjectRemoval.vue';
import ProjectContext from './ProjectContext.vue';
import ProjectFreshness from './ProjectFreshness.vue';
import DecisionFiles from '../decisions/DecisionFiles.vue';
import CheckCard from '../checks/CheckCard.vue';
import { api, act, busy, error, workspace, reload } from '../../shared/api';
import {
  date,
  lines,
  today,
  statusLabels,
  typeLabels,
  priorityLabels,
  taskLabels,
  decisionLabels,
  relationLabels,
} from '../../shared/labels';
const route = useRoute();
const project = ref<Project | null>(null);
const draft = ref<Metadata | null>(null);
const notes = ref('');
const blockedText = ref('');
const relatedText = ref('');
const editing = ref(false);
const editHash = ref<string | null>(null);
const loading = ref(false);
let loadVersion = 0;
const targetId = ref('');
const relationType = ref<Relation['type']>('uses');
function accept(value: Project) {
  project.value = value;
  draft.value = structuredClone(toRaw(value.metadata));
  notes.value = value.notes;
  blockedText.value = value.metadata.blocked_by.join('\n');
  relatedText.value = value.metadata.related.join('\n');
}
watch(
  () => route.params.id,
  async (id) => {
    const version = ++loadVersion;
    project.value = null;
    editing.value = false;
    loading.value = true;
    try {
      const result = await api<Project>(`/projects/${id}`);
      await reload();
      if (version === loadVersion) accept(result);
    } catch (cause) {
      if (version === loadVersion) error.value = (cause as Error).message;
    } finally {
      if (version === loadVersion) loading.value = false;
    }
  },
  { immediate: true },
);
watch(
  () => workspace.value?.projects,
  (items) => {
    const updated = items?.find((item) => item.id === project.value?.id);
    if (!updated) return;
    if (editing.value) project.value = updated;
    else accept(updated);
  },
);
const unfinishedChecks = computed(() =>
  workspace.value!.checks.filter(
    (check) => check.projectId === project.value?.id && check.status !== 'completed',
  ),
);
const tasks = computed(() =>
  workspace.value!.tasks.filter((t) => t.projectId === project.value?.id && !t.completedAt),
);
const decisions = computed(() =>
  workspace.value!.decisions.filter((d) => d.projectId === project.value?.id),
);
const relations = computed(() =>
  workspace.value!.relations.filter(
    (r) => r.sourceId === project.value?.id || r.targetId === project.value?.id,
  ),
);
const others = computed(() => workspace.value!.projects.filter((p) => p.id !== project.value?.id));
function relatedProject(id: string) {
  return workspace.value!.projects.find((p) => p.id === id);
}
async function save() {
  const ok = await act(async () => {
    accept(
      await api<Project>(`/projects/${project.value!.id}`, 'PUT', {
        metadata: {
          ...draft.value,
          // JSON omits these fields; the server retains the current legacy plan.
          current_focus: undefined,
          next: undefined,
          last_reviewed: draft.value?.last_reviewed || null,
          blocked_by: lines(blockedText.value),
          related: lines(relatedText.value),
        },
        notes: notes.value,
        expectedHash: editHash.value,
      }),
    );
  }, 'Сводка сохранена в Control Center');
  if (ok) editing.value = false;
}
function importPlan() {
  return act(async () => {
    await api(`/projects/${project.value!.id}/import-plan`, 'POST');
  }, 'Следующие шаги добавлены на доску. Прежняя сводка сохранена.');
}
function toggleEditing() {
  if (!editing.value) {
    editHash.value = project.value!.snapshot.yaml.hash;
    accept(project.value!);
  }
  editing.value = !editing.value;
}
function exportYaml() {
  return act(async () => {
    accept(
      await api<Project>(`/projects/${project.value!.id}/export`, 'POST', {
        expectedHash: project.value!.snapshot.yaml.hash,
      }),
    );
  }, 'PROJECT.yaml записан в репозиторий');
}
function useYaml() {
  if (!confirm('Убрать локальные правки сводки и использовать PROJECT.yaml? Заметки сохранятся.'))
    return;
  return act(async () => {
    accept(
      await api<Project>(`/projects/${project.value!.id}/use-yaml`, 'POST', {
        expectedHash: project.value!.snapshot.yaml.hash,
      }),
    );
  }, 'Источник сводки обновлён');
}
function addRelation() {
  return act(async () => {
    await api('/relations', 'POST', {
      sourceId: project.value!.id,
      targetId: targetId.value,
      type: relationType.value,
    });
    targetId.value = '';
  }, 'Связь добавлена');
}
function removeRelation(id: string) {
  return act(async () => {
    await api(`/relations/${id}`, 'DELETE');
  }, 'Связь удалена');
}
</script>
<template>
  <template v-if="project && draft">
    <RouterLink to="/projects" class="back-link">← Все проекты</RouterLink>
    <div class="page-heading">
      <div>
        <p class="section-label">{{ typeLabels[project.metadata.type] }}</p>
        <h1>{{ project.metadata.name }}</h1>
        <div class="row">
          <span class="badge" :class="project.metadata.status">{{
            statusLabels[project.metadata.status]
          }}</span
          ><span class="muted">Приоритет: {{ priorityLabels[project.metadata.priority] }}</span
          ><span v-if="project.metadata.stage" class="muted">{{ project.metadata.stage }}</span>
        </div>
        <ProjectFreshness :project="project" />
      </div>
      <div class="row">
        <button :disabled="busy" @click="toggleEditing">
          {{ editing ? 'Закрыть редактор' : 'Изменить сводку' }}
        </button>
        <ProjectRemoval :project="project" />
      </div>
    </div>
    <div v-if="!project.available" class="message warning">
      Каталог недоступен или вне настроек. Показан сохранённый снимок.
    </div>
    <form v-if="editing" class="panel form section-space" @submit.prevent="save">
      <h2>Сводка проекта</h2>
      <div class="form-grid">
        <label>Название<input v-model="draft.name" required maxlength="240" /></label
        ><label
          >Тип<select v-model="draft.type">
            <option v-for="(label, key) in typeLabels" :key="key" :value="key">{{ label }}</option>
          </select></label
        ><label
          >Статус<select v-model="draft.status">
            <option v-for="(label, key) in statusLabels" :key="key" :value="key">
              {{ label }}
            </option>
          </select></label
        ><label
          >Приоритет<select v-model="draft.priority">
            <option v-for="(label, key) in priorityLabels" :key="key" :value="key">
              {{ label }}
            </option>
          </select></label
        ><label
          >Этап<input
            v-model="draft.stage"
            maxlength="120"
            placeholder="Например, разработка" /></label
        ><label>Дата пересмотра<input v-model="draft.last_reviewed" type="date" /></label>
      </div>
      <label>Зачем существует<textarea v-model="draft.goal" rows="2" /></label
      ><label>Блокировки, по одной на строку<textarea v-model="blockedText" rows="2" /></label
      ><label>Связанные имена для PROJECT.yaml<textarea v-model="relatedText" rows="2" /></label
      ><label>Заметки<textarea v-model="notes" rows="3" /></label>
      <div class="row">
        <button class="primary" :disabled="busy">Сохранить сводку</button
        ><button type="button" @click="draft.last_reviewed = today()">Пересмотрено сегодня</button>
      </div>
    </form>
    <div class="project-dossier section-space">
      <div>
        <section class="project-brief prose">
          <h2>Зачем существует</h2>
          <p class="preserve">{{ project.metadata.goal || 'Цель пока не описана.' }}</p>
          <h2>Сейчас</h2>
          <ul v-if="tasks.some((task) => task.state === 'now')">
            <li v-for="task in tasks.filter((task) => task.state === 'now')" :key="task.id">
              <RouterLink :to="`/tasks?project=${project.id}&task=${task.code}`"
                >{{ task.code }} · {{ task.title }}</RouterLink
              >
            </li>
          </ul>
          <p v-else class="muted">Задачи на сейчас ещё не выбраны.</p>
          <h2>Следующий шаг</h2>
          <ol v-if="tasks.some((task) => task.state === 'next')">
            <li v-for="task in tasks.filter((task) => task.state === 'next')" :key="task.id">
              <RouterLink :to="`/tasks?project=${project.id}&task=${task.code}`"
                >{{ task.code }} · {{ task.title }}</RouterLink
              >
            </li>
          </ol>
          <p v-else class="muted">Следующие задачи ещё не выбраны.</p>
          <details
            v-if="project.metadata.current_focus || project.metadata.next.length"
            class="section-space legacy-plan"
          >
            <summary>Прежний план из сводки</summary>
            <p v-if="project.metadata.current_focus" class="preserve">
              <strong>Фокус:</strong> {{ project.metadata.current_focus }}
            </p>
            <ol>
              <li v-for="item in project.metadata.next" :key="item">{{ item }}</li>
            </ol>
            <p>
              Текущая работа редактируется на доске задач. Прежний план доступен только для чтения;
              экспорт сохраняет его и не заменяет задачами.
            </p>
            <button v-if="project.metadata.next.length" :disabled="busy" @click="importPlan">
              Добавить шаги на доску
            </button>
          </details>
        </section>
        <section v-if="unfinishedChecks.length" class="section-space">
          <h2>Проверки проекта</h2>
          <div class="check-register section-space">
            <CheckCard v-for="check in unfinishedChecks" :key="check.id" :check="check" compact />
          </div>
          <RouterLink :to="`/checks?new=1&project=${project.id}`">Новая проверка →</RouterLink>
        </section>

        <section class="section-space">
          <div class="section-heading">
            <h2>
              Задачи <span class="count">{{ tasks.length }}</span>
            </h2>
            <RouterLink :to="`/tasks?project=${project.id}`">Добавить задачу →</RouterLink>
            <RouterLink :to="`/history?project=${project.id}`">История работы →</RouterLink>
          </div>
          <div class="panel compact-list">
            <div v-for="task in tasks" :key="task.id" class="row between">
              <span>{{ task.title }}</span
              ><span class="badge">{{ taskLabels[task.state] }}</span>
            </div>
            <p v-if="!tasks.length" class="muted">Открытых задач нет.</p>
          </div>
        </section>
        <section class="section-space">
          <div class="section-heading"><h2>Последние изменения</h2></div>
          <div class="panel activity-list">
            <div v-for="commit in project.snapshot.git.commits" :key="commit.hash" class="activity">
              <code>{{ commit.hash.slice(0, 7) }}</code>
              <div>
                <p>{{ commit.subject }}</p>
                <small>{{ date(commit.date) }}</small>
              </div>
            </div>
            <p v-if="!project.snapshot.git.commits.length" class="empty">
              {{ project.snapshot.git.error || 'История commits отсутствует.' }}
            </p>
          </div>
        </section>
        <section class="section-space">
          <div class="section-heading">
            <h2>Локальные решения Control Center</h2>
            <RouterLink to="/decisions">Все решения →</RouterLink>
          </div>
          <div class="panel compact-list">
            <div v-for="item in decisions" :key="item.id">
              <strong>{{ item.title }}</strong>
              <p>{{ item.decision }}</p>
              <small>{{ decisionLabels[item.status] }} · {{ date(item.date) }}</small>
            </div>
            <p v-if="!decisions.length" class="muted">Локальных решений пока нет.</p>
          </div>
        </section>
        <section v-if="project.notes" class="panel prose section-space">
          <h2>Заметки</h2>
          <p class="preserve">{{ project.notes }}</p>
        </section>
      </div>
      <aside>
        <section class="panel prose">
          <h2>Требуют внимания</h2>
          <ul v-if="project.signals.length" class="project-signals">
            <li
              v-for="signal in project.signals"
              :key="signal.code + signal.message"
              class="signal"
              :class="signal.level || 'attention'"
            >
              <strong
                >{{
                  signal.level === 'info'
                    ? 'Информация'
                    : signal.level === 'decision'
                      ? 'Решение'
                      : 'Внимание'
                }}.</strong
              >
              <span>{{ signal.message }}</span>
            </li>
          </ul>
          <p v-else class="muted">По доступным данным сигналов нет.</p>
          <h3>Блокировки</h3>
          <ul v-if="project.metadata.blocked_by.length">
            <li v-for="item in project.metadata.blocked_by" :key="item">{{ item }}</li>
          </ul>
          <p v-else class="muted">Не указаны.</p>
        </section>
        <ProjectContext :key="project.id" :project="project" @updated="accept" />
        <section class="panel section-space">
          <h2>Связи</h2>
          <div v-for="relation in relations" :key="relation.id" class="relation-item">
            <div>
              <small>{{
                relation.sourceId === project.id
                  ? relationLabels[relation.type]
                  : `Входящая связь: ${relationLabels[relation.type].toLowerCase()}`
              }}</small
              ><RouterLink
                :to="`/projects/${relation.sourceId === project.id ? relation.targetId : relation.sourceId}`"
                >{{
                  relatedProject(
                    relation.sourceId === project.id ? relation.targetId : relation.sourceId,
                  )?.metadata.name
                }}</RouterLink
              >
            </div>
            <button
              class="text-button"
              :disabled="busy"
              aria-label="Удалить связь"
              @click="removeRelation(relation.id)"
            >
              ×
            </button>
          </div>
          <p v-if="!relations.length" class="muted">Связи ещё не добавлены.</p>
          <p v-if="project.metadata.related.length" class="help">
            Имена из сводки: {{ project.metadata.related.join(', ') }}
          </p>
          <form class="form section-space" @submit.prevent="addRelation">
            <label
              >Тип связи<select v-model="relationType">
                <option v-for="(label, key) in relationLabels" :key="key" :value="key">
                  {{ label }}
                </option>
              </select></label
            ><label
              >Связанный проект<select v-model="targetId" required>
                <option value="" disabled>Выберите проект</option>
                <option v-for="other in others" :key="other.id" :value="other.id">
                  {{ other.metadata.name }}
                </option>
              </select></label
            ><button :disabled="busy || !targetId">Добавить связь</button>
          </form>
        </section>
        <section class="panel section-space prose">
          <h2>Метаданные</h2>
          <p>
            Источник:
            <strong>{{
              project.metadataSource === 'local'
                ? 'Control Center'
                : project.metadataSource === 'yaml'
                  ? 'PROJECT.yaml'
                  : 'Имя каталога'
            }}</strong>
          </p>
          <p class="help">
            Экспорт записывает сводку и сохранённый прежний план в PROJECT.yaml. Задачи и результаты
            остаются в Control Center. Неизвестные поля сохраняются.
          </p>
          <div class="form">
            <button :disabled="busy || editing || !project.available" @click="exportYaml">
              {{
                project.snapshot.yaml.exists ? 'Обновить PROJECT.yaml' : 'Создать PROJECT.yaml'
              }}</button
            ><button v-if="project.metadataSource === 'local'" :disabled="busy" @click="useYaml">
              Использовать данные из YAML
            </button>
          </div>
          <small>Пересмотрено: {{ date(project.metadata.last_reviewed) }}</small>
        </section>
      </aside>
    </div>
    <DecisionFiles :project-id="project.id" />
    <ProjectMaintenance :key="project.id" :project="project" @updated="accept" />
    <details class="panel section-space">
      <summary>Информация о репозитории</summary>
      <dl class="repository-info">
        <dt>Локальный путь</dt>
        <dd>{{ project.path }}</dd>
        <dt>Git / ветка</dt>
        <dd>
          {{
            project.snapshot.git.present
              ? project.snapshot.git.branch || 'Не удалось определить'
              : 'Без Git'
          }}
        </dd>
        <dt>Рабочая директория</dt>
        <dd>
          {{
            project.snapshot.git.dirty === null
              ? 'Нет данных'
              : project.snapshot.git.dirty
                ? `Изменённых файлов: ${project.snapshot.git.changedFiles}`
                : 'Нет изменений'
          }}
        </dd>
        <dt>Remote</dt>
        <dd>{{ project.snapshot.git.remote || 'Не указан' }}</dd>
        <dt>AGENTS.md</dt>
        <dd>{{ project.snapshot.hasAgents ? 'Есть' : 'Нет' }}</dd>
        <dt>Карта проекта</dt>
        <dd>{{ project.snapshot.mapFile || 'Не найдена' }}</dd>
        <dt>Основные файлы</dt>
        <dd>{{ project.snapshot.files.join(', ') || 'Не найдены' }}</dd>
        <dt>package.json</dt>
        <dd>
          {{ project.snapshot.package?.name || 'Нет имени пакета'
          }}<span v-if="project.snapshot.package">
            · scripts: {{ project.snapshot.package.scripts.join(', ') || 'нет' }}</span
          >
        </dd>
        <dt>Снимок</dt>
        <dd>{{ new Date(project.snapshot.scannedAt).toLocaleString('ru') }}</dd>
      </dl>
    </details>
  </template>
  <p v-else class="empty">{{ loading ? 'Обновляем состояние проекта…' : 'Проект не загружен.' }}</p>
</template>
