<script setup lang="ts">
import { computed, ref } from 'vue';
import { api, workspace } from '../../shared/api';
import type { FileDecision } from '../../../shared/decisions';
import { date } from '../../shared/labels';
import ProjectLink from '../../shared/ProjectLink.vue';
const props = defineProps<{ projectId?: string }>();
const records = computed(() =>
  workspace.value!.fileDecisions.filter((d) => !props.projectId || d.projectId === props.projectId),
);
const statuses = {
  proposed: 'Предложено',
  accepted: 'Принято',
  rejected: 'Отклонено',
  superseded: 'Заменено',
};
const implementation = {
  unknown: 'Не проверено',
  not_implemented: 'Не реализовано',
  partial: 'Частично',
  implemented: 'Реализовано',
};
const contents = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
async function read(record: FileDecision, event: Event) {
  if (!(event.target as HTMLDetailsElement).open) {
    delete contents.value[record.key];
    return;
  }
  delete contents.value[record.key];
  delete errors.value[record.key];
  try {
    const result = await api<{ body: string }>(
      `/projects/${record.projectId}/decision-content`,
      'POST',
      { key: record.key },
    );
    contents.value[record.key] = result.body;
  } catch (error) {
    errors.value[record.key] = (error as Error).message;
  }
}
</script>
<template>
  <section class="section-space">
    <h2>
      Проектные решения из файлов <span class="count">{{ records.length }}</span>
    </h2>
    <p class="help">
      Источник истины — файл. Control Center только читает; изменения вносятся в исходный документ.
    </p>
    <div class="timeline section-space">
      <article v-for="record in records" :key="record.key" class="panel prose">
        <ProjectLink v-if="!projectId" :id="record.projectId" />
        <div class="row between">
          <h3>{{ record.metadata?.id }} {{ record.title }}</h3>
          <span class="badge">{{
            record.source === 'repository'
              ? 'Проектное решение · repository'
              : record.source === 'private_context'
                ? 'Проектное решение · private context'
                : 'Проектное решение · приватный каталог решений'
          }}</span>
        </div>
        <p class="source-path">{{ record.sourcePath }}</p>
        <p v-if="record.error" class="signal attention">{{ record.error }}</p>
        <template v-else-if="record.metadata"
          ><p>
            {{ statuses[record.metadata.status] }} ·
            {{ implementation[record.metadata.implementation] }} · {{ date(record.metadata.date) }}
          </p>
          <p v-if="record.metadata.review_after">
            Пересмотр: {{ date(record.metadata.review_after) }}
          </p>
          <p
            v-for="signal in record.signals"
            :key="signal.code"
            class="signal"
            :class="signal.level"
          >
            {{ signal.message }}
          </p>
          <details>
            <summary>Метаданные</summary>
            <dl class="check-dates">
              <dt>Область</dt>
              <dd>{{ record.metadata.area }}</dd>
              <dt>Заменяет</dt>
              <dd>{{ record.metadata.supersedes.join(', ') || 'Нет' }}</dd>
              <dt>Заменено решением</dt>
              <dd>{{ record.metadata.superseded_by || 'Нет' }}</dd>
              <dt>Видимость / схема</dt>
              <dd>{{ record.metadata.visibility }} / {{ record.metadata.schema_version }}</dd>
            </dl>
          </details></template
        >
        <p v-else class="muted">Неструктурированная запись решения</p>
        <details v-if="record.hasContent" @toggle="read(record, $event)">
          <summary>Читать решение</summary>
          <p v-if="errors[record.key]" role="alert">{{ errors[record.key] }}</p>
          <pre v-else-if="contents[record.key] !== undefined" class="decision-body">{{
            contents[record.key]
          }}</pre>
          <p v-else>Чтение исходного файла…</p>
        </details>
      </article>
    </div>
    <p v-if="!records.length" class="empty">
      Файлов решений пока нет. Поддерживаются DECISIONS.md и decisions/*.md.
    </p>
  </section>
</template>
