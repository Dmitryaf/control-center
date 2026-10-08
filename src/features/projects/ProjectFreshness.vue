<script setup lang="ts">
import type { Project } from '../../../shared/contracts';
defineProps<{ project: Project }>();
</script>
<template>
  <p class="help">
    {{ project.available ? 'Снимок файлов:' : 'Последний доступный снимок:' }}
    <time :datetime="project.snapshot.scannedAt">{{
      new Date(project.snapshot.scannedAt).toLocaleString('ru')
    }}</time>
  </p>
</template>
