<script setup lang="ts">
import { workspace } from './api';
const model = defineModel<string | null>();
</script>
<template>
  <label
    >Проект<select v-model="model">
      <option :value="null">Вся экосистема</option>
      <option v-for="project in workspace?.projects" :key="project.id" :value="project.id">
        {{ project.metadata.name }}
      </option>
    </select></label
  >
</template>
