<script setup lang="ts">
import { computed } from 'vue';
import { workspace } from './api';
const props = defineProps<{ id?: string | null }>();
const project = computed(() => workspace.value?.projects.find((item) => item.id === props.id));
</script>
<template>
  <RouterLink v-if="project" :to="`/projects/${project.id}`" class="subtle-link">{{
    project.metadata.name
  }}</RouterLink
  ><span v-else class="muted">Вся экосистема</span>
</template>
