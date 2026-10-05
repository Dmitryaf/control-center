<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Project } from '../../../shared/contracts';
import { act, api, busy, workspace } from '../../shared/api';
const props = defineProps<{ project: Project }>();
const emit = defineEmits<{ updated: [project: Project] }>();
const visibility = ref(props.project.context.visibility);
const privatePath = ref(props.project.context.privateContextPath ?? '');
watch(
  [() => props.project.context.visibility, () => props.project.context.privateContextPath],
  ([nextVisibility, nextPath]) => {
    visibility.value = nextVisibility;
    privatePath.value = nextPath ?? '';
  },
);
const files = computed(() =>
  workspace.value!.fileDecisions.filter(
    (record) => record.projectId === props.project.id && record.hasContent,
  ),
);
const counts = computed(() => ({
  repository: files.value.filter((record) => record.source === 'repository').length,
  private: files.value.filter((record) => record.source !== 'repository').length,
  local: workspace.value!.decisions.filter((record) => record.projectId === props.project.id)
    .length,
}));
const kitLabels = {
  unknown: 'Не проверен',
  local: 'Локальный режим — не отслеживается Git',
  tracked: 'Внутренние файлы отслеживаются Git',
  missing: 'Не найден',
  partial: 'Неполное локальное подключение',
};
const contextLabels = {
  disconnected: 'Не подключён',
  connected: 'Подключён',
  unavailable: 'Приватный контекст недоступен',
};
function save(disconnect = false) {
  const nextPath = disconnect ? null : privatePath.value.trim() || null;
  if (
    props.project.context.privateContextPath &&
    nextPath !== props.project.context.privateContextPath &&
    !confirm(
      'Файлы не будут удалены. Control Center перестанет их индексировать.' +
        (nextPath ? ' Будет подключён новый каталог.' : ''),
    )
  )
    return;
  return act(async () => {
    emit(
      'updated',
      await api<Project>(`/projects/${props.project.id}/context`, 'PUT', {
        visibility: visibility.value,
        privateContextPath: nextPath,
      }),
    );
  }, 'Настройки контекста сохранены');
}
function allow(path: string, allowed: boolean) {
  return act(
    async () => {
      emit(
        'updated',
        await api<Project>(`/projects/${props.project.id}/publication-allowlist`, 'PUT', {
          path,
          allowed,
        }),
      );
    },
    allowed ? 'Путь отмечен как намеренно публичный' : 'Путь снова проверяется',
  );
}
</script>
<template>
  <section class="panel section-space context-panel">
    <h2>Источники контекста</h2>
    <dl class="check-dates">
      <dt>Репозиторий</dt>
      <dd>
        {{ project.context.visibility === 'unknown' ? 'Не указано' : project.context.visibility }}
      </dd>
      <dt>Agent Kit</dt>
      <dd>{{ kitLabels[project.context.audit.kit] }}</dd>
      <dt>Приватный контекст</dt>
      <dd>{{ contextLabels[project.context.privateStatus] }}</dd>
      <dt>Решения</dt>
      <dd>
        {{ counts.repository }} repository · {{ counts.private }} private · {{ counts.local }} local
      </dd>
    </dl>
    <p v-if="project.context.privateContextPath" class="source-path">
      {{ project.context.privateContextPath }}
    </p>
    <p v-if="project.context.hasPrivateMap">Приватная карта проекта найдена</p>
    <details class="section-space">
      <summary>Настройки контекста</summary>
      <form class="form section-space" @submit.prevent="save()">
        <label
          >Видимость репозитория<select v-model="visibility" :disabled="busy">
            <option value="unknown">Не указано</option>
            <option value="private">Репозиторий приватный</option>
            <option value="public">Репозиторий публичный</option>
          </select></label
        >
        <label
          >Каталог приватного контекста<input
            v-model="privatePath"
            :disabled="busy"
            placeholder="Полный путь к отдельному каталогу"
        /></label>
        <p class="help">
          Настройки хранятся только в SQLite. Каталог может содержать DECISIONS.md, decisions/ и
          PROJECT_MAP.md. Control Center читает файлы; версионирование и резервное хранение каталога
          настраиваете вы.
        </p>
        <div class="row">
          <button :disabled="busy">Сохранить контекст</button>
          <button
            v-if="project.context.privateContextPath"
            type="button"
            :disabled="busy"
            @click="save(true)"
          >
            Отключить приватный контекст
          </button>
        </div>
      </form>
      <h3 class="section-space">Намеренно публичные пути</h3>
      <p v-if="!project.context.allowlist.length" class="help">Подтверждённых путей нет.</p>
      <ul v-else class="plain-list">
        <li v-for="file in project.context.allowlist" :key="file" class="row between">
          <span class="source-path">{{ file }}</span
          ><button :disabled="busy" @click="allow(file, false)">Убрать из списка</button>
        </li>
      </ul>
    </details>
    <details v-if="project.context.visibility === 'public'" class="section-space">
      <summary>Проверка публикации · {{ project.context.audit.findings.length }}</summary>
      <p class="help">
        Проверяются отслеживаемые файлы Git, включая подготовленные изменения. Это не проверка
        remote или истории публикаций.
      </p>
      <p v-if="project.context.audit.status !== 'ok'" class="signal attention">
        Не удалось проверить отслеживаемые Git файлы. Проверьте доступ к репозиторию и обновите
        проект.
      </p>
      <p v-else-if="!project.context.audit.findings.length">
        Нет путей, требующих проверки публикации.
      </p>
      <article
        v-for="finding in project.context.audit.findings"
        :key="finding.path"
        class="section-space"
      >
        <p class="source-path">
          <strong>{{ finding.path }}</strong>
        </p>
        <p>
          {{
            finding.kind === 'infrastructure'
              ? 'В публичном репозитории отслеживается внутренняя инфраструктура. Проверьте необходимость публикации.'
              : 'Проверьте, что файл действительно должен быть публичным и предназначен для внешней аудитории.'
          }}
        </p>
        <button :disabled="busy" @click="allow(finding.path, true)">
          Этот путь намеренно публичный
        </button>
      </article>
    </details>
  </section>
</template>
