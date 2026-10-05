<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { workspace } from '../../shared/api';
import ProjectCard from './ProjectCard.vue';
const route = useRoute();
const filter = ref(String(route.query.filter ?? 'all'));
const query = ref('');
const filters = {
  all: 'Все',
  active: 'Активные',
  paused: 'Отложенные',
  completed: 'Завершённые',
  tool: 'Инструменты',
  product: 'Продукты',
  experiment: 'Эксперименты',
  high: 'Высокий приоритет',
};
const projects = computed(() =>
  workspace.value!.projects.filter(
    (p) =>
      (filter.value === 'all' ||
        [p.metadata.status, p.metadata.type, p.metadata.priority].some(
          (value) => value === filter.value,
        )) &&
      `${p.metadata.name} ${p.path}`.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
</script>
<template>
  <div class="page-heading">
    <div>
      <p class="section-label">Каталог</p>
      <h1>
        Проекты <span class="count">{{ workspace!.projects.length }}</span>
      </h1>
      <p class="subtitle">Продукты, инструменты и эксперименты рядом.</p>
    </div>
    <RouterLink to="/settings" class="button">Каталоги проектов</RouterLink>
  </div>
  <div class="toolbar">
    <div class="filter-bar">
      <button
        v-for="(label, key) in filters"
        :key="key"
        :class="{ active: filter === key }"
        :aria-pressed="filter === key"
        @click="filter = key"
      >
        {{ label }}
      </button>
    </div>
    <input v-model="query" aria-label="Поиск проектов" placeholder="Найти проект…" type="search" />
  </div>
  <div class="project-register">
    <ProjectCard v-for="project in projects" :key="project.id" :project="project" />
  </div>
  <div v-if="!projects.length" class="panel empty">
    <h2>Проекты не найдены</h2>
    <p>Измените фильтр или добавьте каталог в настройках.</p>
    <RouterLink to="/settings">Открыть настройки →</RouterLink>
  </div>
</template>
