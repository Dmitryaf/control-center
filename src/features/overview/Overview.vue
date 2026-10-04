<script setup lang="ts">
import { computed } from 'vue';
import { workspace } from '../../shared/api';
import { date } from '../../shared/labels';
import ProjectCard from '../projects/ProjectCard.vue';
const active = computed(() =>
  workspace.value!.projects.filter((p) => p.metadata.status === 'active'),
);
const attention = computed(() => workspace.value!.projects.filter((p) => p.signals.length));
const now = computed(() =>
  workspace.value!.tasks.filter((t) => !t.completedAt && t.state === 'now'),
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
      <p class="eyebrow">ВАША ЭКОСИСТЕМА</p>
      <h1>Сейчас</h1>
      <p class="subtitle">Что движется вперёд и где нужно ваше внимание.</p>
    </div>
    <span class="muted">{{ date(new Date().toISOString()) }}</span>
  </div>
  <div v-if="!workspace!.settings.roots.length" class="panel welcome">
    <h2>Начните с каталога проектов</h2>
    <p>Укажите, где лежат ваши репозитории. GitHub и PROJECT.yaml не обязательны.</p>
    <RouterLink to="/settings" class="button primary">Добавить каталог →</RouterLink>
  </div>
  <div class="stats">
    <RouterLink to="/projects?filter=active"
      ><span>Активных проектов</span
      ><strong>{{ active.length.toString().padStart(2, '0') }}</strong></RouterLink
    ><a href="#attention"
      ><span>Требуют внимания</span
      ><strong>{{ attention.length.toString().padStart(2, '0') }}</strong></a
    ><RouterLink to="/tasks"
      ><span>Задач сейчас</span
      ><strong>{{ now.length.toString().padStart(2, '0') }}</strong></RouterLink
    ><RouterLink to="/ideas"
      ><span>Идей на рассмотрении</span
      ><strong>{{ inbox.length.toString().padStart(2, '0') }}</strong></RouterLink
    >
  </div>
  <div class="dashboard-columns">
    <section>
      <div class="section-heading">
        <h2>
          Активные проекты <span class="count">{{ active.length }}</span>
        </h2>
        <RouterLink to="/projects">Все проекты →</RouterLink>
      </div>
      <div class="project-grid">
        <ProjectCard v-for="project in active" :key="project.id" :project="project" />
      </div>
      <p v-if="!active.length" class="panel empty">
        Активных проектов пока нет. Откройте найденный проект и задайте статус.
      </p>
      <section class="section-space">
        <div class="section-heading">
          <h2>Последние изменения</h2>
          <span class="muted">По истории Git</span>
        </div>
        <div class="panel activity-list">
          <div v-for="item in recent" :key="item.project.id + item.commit.hash" class="activity">
            <span class="activity-dot" />
            <div>
              <RouterLink :to="`/projects/${item.project.id}`">{{
                item.project.metadata.name
              }}</RouterLink>
              <p>{{ item.commit.subject }}</p>
            </div>
            <time>{{ date(item.commit.date) }}</time>
          </div>
          <p v-if="!recent.length" class="empty">История commits появится после сканирования.</p>
        </div>
      </section>
    </section>
    <aside>
      <section id="attention">
        <div class="section-heading">
          <h2>Требуют внимания</h2>
          <span class="attention-mark">●</span>
        </div>
        <div class="panel attention-list">
          <div v-for="project in attention" :key="project.id" class="attention-item">
            <RouterLink :to="`/projects/${project.id}`"
              >{{ project.metadata.name }} <span>↗</span></RouterLink
            >
            <ul>
              <li v-for="signal in project.signals" :key="signal.code + signal.message">
                {{ signal.message }}
              </li>
            </ul>
          </div>
          <p v-if="!attention.length" class="empty">По доступным данным сигналов нет.</p>
        </div>
      </section>
      <section class="section-space">
        <div class="section-heading">
          <h2>В работе</h2>
          <RouterLink to="/tasks">Задачи →</RouterLink>
        </div>
        <div class="panel compact-list">
          <p v-for="task in now" :key="task.id">{{ task.title }}</p>
          <p v-if="!now.length" class="muted">Выберите задачи на сейчас.</p>
        </div>
      </section>
      <section v-if="pending.length" class="section-space">
        <div class="section-heading"><h2>Ожидают решения</h2></div>
        <div class="panel compact-list">
          <RouterLink v-for="decision in pending" :key="decision.id" to="/decisions">{{
            decision.title
          }}</RouterLink>
        </div>
      </section>
    </aside>
  </div>
</template>
