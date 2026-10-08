<script setup lang="ts">
import { computed } from 'vue';
import { workspace } from '../../shared/api';
import { date, priorityLabels } from '../../shared/labels';
import ProjectLink from '../../shared/ProjectLink.vue';
import RecentWork from './RecentWork.vue';
import ProjectCard from '../projects/ProjectCard.vue';
import CheckCard from '../checks/CheckCard.vue';
const checks = computed(() =>
  workspace
    .value!.checks.filter((c) => c.status === 'active')
    .sort(
      (a, b) =>
        Number(b.signals.some((s) => s.level === 'decision')) -
          Number(a.signals.some((s) => s.level === 'decision')) ||
        b.daysWithoutMovement - a.daysWithoutMovement,
    ),
);
const active = computed(() =>
  workspace.value!.projects.filter((p) => p.metadata.status === 'active'),
);
const attention = computed(() =>
  [
    ...checks.value.map((c) => ({
      signals: c.signals,
      title: c.title,
      to: `/checks/${c.id}`,
      kind: 'Проверка',
    })),
    ...workspace.value!.projects.map((p) => ({
      signals: p.signals,
      title: p.metadata.name,
      to: `/projects/${p.id}`,
      kind: 'Проект',
    })),
  ]
    .map((item) => ({
      ...item,
      signals: item.signals.filter((s) => s.level !== 'info'),
      level: item.signals.some((s) => s.level === 'decision') ? 'decision' : 'attention',
    }))
    .filter((item) => item.signals.length)
    .sort((a, b) => Number(b.level === 'decision') - Number(a.level === 'decision')),
);
const now = computed(() =>
  workspace
    .value!.tasks.filter((t) => !t.completedAt && t.state === 'now')
    .sort(
      (a, b) =>
        ({ high: 0, normal: 1, low: 2 })[a.priority] - { high: 0, normal: 1, low: 2 }[b.priority] ||
        b.number - a.number,
    ),
);
const inbox = computed(() =>
  workspace.value!.ideas.filter((i) => ['new', 'consider', 'testing'].includes(i.state)),
);
const pending = computed(() => workspace.value!.decisions.filter((d) => d.status === 'pending'));
const recent = computed(() =>
  workspace
    .value!.projects.flatMap((project) =>
      project.snapshot.git.commits.map((commit) => ({ project, commit })),
    )
    .sort((a, b) => b.commit.date.localeCompare(a.commit.date))
    .slice(0, 10),
);
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">Задачи и результаты</p>
      <h1>Сейчас</h1>
    </div>
    <p class="scan-stamp">
      Последнее сканирование<br /><time>{{
        workspace!.scan.scannedAt
          ? new Date(workspace!.scan.scannedAt).toLocaleString('ru')
          : 'Сканирования ещё не было'
      }}</time>
    </p>
  </div>
  <section class="current-work" aria-labelledby="current-work-heading">
    <div class="section-heading">
      <h2 id="current-work-heading">В работе</h2>
      <RouterLink to="/tasks">Задачи · {{ now.length }} →</RouterLink>
    </div>
    <ul v-if="now.length" class="work-list current-task-list">
      <li v-for="task in now" :key="task.id">
        <RouterLink :to="`/tasks?task=${task.code}`">{{ task.code }} · {{ task.title }}</RouterLink>
        <div class="row">
          <ProjectLink v-if="task.projectId" :id="task.projectId" /><span v-else class="muted"
            >Общая задача</span
          ><span class="help">{{ priorityLabels[task.priority] }}</span>
        </div>
      </li>
    </ul>
    <p v-else class="empty">Выберите задачу на сейчас на доске или создайте новую.</p>
  </section>
  <div v-if="!workspace!.settings.roots.length" class="panel welcome">
    <h2>Начните с каталога проектов</h2>
    <p>Укажите, где лежат ваши репозитории. GitHub и PROJECT.yaml не обязательны.</p>
    <RouterLink to="/settings" class="button primary">Добавить каталог →</RouterLink>
  </div>
  <section id="attention" class="attention-queue" aria-labelledby="attention-heading">
    <div class="section-heading">
      <h2 id="attention-heading">
        Требуют внимания <span class="count">{{ attention.length }}</span>
      </h2>
      <span class="help">Сначала — решения, затем — сигналы</span>
    </div>
    <div
      v-for="item in attention"
      :key="item.to"
      class="attention-line"
      :class="item.level || 'attention'"
    >
      <span class="signal-label">{{ item.level === 'decision' ? 'Решение' : 'Внимание' }}</span>
      <RouterLink :to="item.to"
        ><small>{{ item.kind }}</small
        >{{ item.title }}</RouterLink
      >
      <ul class="signal-reasons">
        <li v-for="signal in item.signals" :key="signal.code + signal.message">
          {{ signal.message }}
        </li>
      </ul>
    </div>
    <p v-if="!attention.length" class="empty">По доступным данным сигналов нет.</p>
  </section>
  <RecentWork />
  <div class="row overview-links section-space">
    <RouterLink to="/analysis">Анализ проектов →</RouterLink>
    <RouterLink to="/projects">Все проекты · {{ workspace!.projects.length }} →</RouterLink>
    <RouterLink to="/ideas">Идеи · {{ inbox.length }} →</RouterLink>
    <RouterLink v-if="pending.length" to="/decisions"
      >Ожидают решения · {{ pending.length }} →</RouterLink
    >
  </div>
  <details class="overview-details section-space">
    <summary>Проверки: {{ checks.length }} · активные проекты: {{ active.length }}</summary>
    <div class="section-space">
      <div>
        <section class="checks-overview" aria-labelledby="checks-heading">
          <div class="section-heading">
            <h2 id="checks-heading">
              Внешнее движение <span class="count">{{ checks.length }} проверок</span>
            </h2>
            <RouterLink to="/checks">Все проверки →</RouterLink>
          </div>
          <p class="help">
            Время без внешнего шага. Свидетельства и commits не обнуляют этот отсчёт.
          </p>
          <div class="check-register">
            <CheckCard v-for="check in checks" :key="check.id" :check="check" compact />
          </div>
          <p v-if="!checks.length" class="empty">
            Активных проверок нет. Начните с вопроса, который требует внешнего подтверждения.
          </p>
        </section>
        <section class="section-space">
          <div class="section-heading">
            <h2>
              Активные проекты <span class="count">{{ active.length }}</span>
            </h2>
            <RouterLink to="/projects">Все проекты →</RouterLink>
          </div>
          <div class="project-register">
            <ProjectCard v-for="project in active" :key="project.id" :project="project" />
          </div>
          <p v-if="!active.length" class="empty">
            Активных проектов пока нет. Откройте найденный проект и задайте статус.
          </p>
        </section>
        <details class="section-space git-overview">
          <summary>Изменения в Git · внутренняя работа</summary>
          <div class="section-heading">
            <h2>Изменения в Git</h2>
            <span class="help">Внутренняя работа</span>
          </div>
          <div class="activity-list">
            <div v-for="item in recent" :key="item.project.id + item.commit.hash" class="activity">
              <time>{{ date(item.commit.date) }}</time>
              <div>
                <RouterLink :to="`/projects/${item.project.id}`">{{
                  item.project.metadata.name
                }}</RouterLink>
                <p>{{ item.commit.subject }}</p>
              </div>
            </div>
            <p v-if="!recent.length" class="empty">История commits появится после сканирования.</p>
          </div>
        </details>
      </div>
    </div>
  </details>
</template>
<style scoped>
.current-work {
  border-top: 2px solid var(--ink);
  padding-top: 16px;
  margin-bottom: 28px;
}
.current-task-list {
  list-style: none;
  padding: 0;
}
.current-task-list > li {
  padding-block: 12px;
}
.current-task-list > li > a {
  font-weight: 600;
}
.current-task-list .row {
  margin-top: 5px;
  font-size: 12px;
}
.overview-links {
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.overview-details > summary,
.git-overview > summary {
  cursor: pointer;
  font-weight: 600;
}
.overview-details {
  border-top: 1px solid var(--line);
  padding-top: 18px;
}
</style>
