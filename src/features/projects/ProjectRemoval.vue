<script setup lang="ts">
import { useRouter } from 'vue-router';
import type { Project } from '../../../shared/contracts';
import { act, api, busy } from '../../shared/api';

const props = defineProps<{ project: Project }>();
const router = useRouter();
async function remove() {
  if (
    busy.value ||
    !confirm(
      `Удалить «${props.project.metadata.name}» из Control Center? Каталог и файлы останутся на диске. Задачи, идеи, локальные решения и проверки сохранятся как общие. Связи, заметки и локальная сводка проекта будут удалены. Проект будет исключён из сканирования; вернуть его можно в настройках.`,
    )
  )
    return;
  const ok = await act(async () => {
    await api(`/projects/${props.project.id}`, 'DELETE');
  }, 'Проект удалён из Control Center. Файлы и связанные записи сохранены.');
  if (ok) await router.push('/projects');
}
</script>
<template>
  <button :disabled="busy" @click="remove">Удалить из Control Center</button>
</template>
