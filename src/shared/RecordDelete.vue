<script setup lang="ts">
import type { RecordKind } from '../../shared/contracts';
import { act, api, busy } from './api';
const props = defineProps<{ kind: RecordKind; id: string; title: string }>();
const emit = defineEmits<{ deleted: [] }>();
async function remove() {
  if (
    !confirm(
      `Удалить «${props.title}»? Это действие нельзя отменить.${props.kind === 'ideas' ? ' Связанные проверки сохранятся без привязки к идее.' : props.kind === 'tasks' ? ' Сохранённые результаты останутся в истории работы.' : ''}`,
    )
  )
    return;
  const ok = await act(async () => {
    await api(`/${props.kind}/${props.id}`, 'DELETE');
  }, 'Запись удалена');
  if (ok) emit('deleted');
}
</script>
<template><button class="text-button" :disabled="busy" @click="remove">Удалить</button></template>
