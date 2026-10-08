<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { act, api, busy, error, notice, reload, workspace, connectionLost } from './shared/api';
const navigation = [
  ['/', 'Обзор'],
  ['/projects', 'Проекты'],
  ['/checks', 'Проверки'],
  ['/tasks', 'Задачи'],
  ['/ideas', 'Идеи'],
  ['/decisions', 'Решения'],
  ['/settings', 'Настройки'],
];
onMounted(() => act(reload));
let interval: ReturnType<typeof setInterval>;
async function refreshSavedData() {
  if (busy.value || document.hidden) return;
  try {
    await reload();
  } catch {
    /* reload preserves saved data and records the latest connection state. */
  }
}
onMounted(() => {
  interval = setInterval(refreshSavedData, 5000);
  window.addEventListener('focus', refreshSavedData);
});
onUnmounted(() => {
  clearInterval(interval);
  window.removeEventListener('focus', refreshSavedData);
});
function refresh() {
  return act(async () => {
    await api('/scan', 'POST');
  }, 'Данные обновлены');
}
</script>
<template>
  <div class="shell">
    <a class="skip-link" href="#content">К содержимому</a>
    <header class="workspace-bar">
      <RouterLink to="/" class="brand"
        ><span class="brand-mark" aria-hidden="true">↗</span
        ><span>Control Center<small>Локальное рабочее пространство</small></span></RouterLink
      >
      <nav aria-label="Основная навигация">
        <RouterLink
          v-for="[path, label] in navigation"
          :key="path"
          :to="path"
          :class="{ selected: path === '/' ? $route.path === '/' : $route.path.startsWith(path) }"
          :aria-current="
            (path === '/' ? $route.path === '/' : $route.path.startsWith(path)) ? 'page' : undefined
          "
          >{{ label }}</RouterLink
        >
      </nav>
      <button :disabled="busy" @click="refresh">
        {{ busy ? 'Обновление…' : '↻ Обновить' }}
      </button>
    </header>
    <div class="main-shell">
      <main id="content" tabindex="-1">
        <div v-if="error" class="message error" role="alert" aria-label="Ошибка действия">
          {{ error }} <button :disabled="busy" @click="act(reload)">Повторить загрузку</button>
        </div>
        <div v-if="notice" class="message success" role="status">{{ notice }}</div>
        <div
          v-if="workspace && connectionLost"
          class="message warning"
          role="alert"
          aria-label="Связь с сервером"
        >
          Нет связи с локальным сервером. Показаны ранее загруженные данные; загрузка повторится
          автоматически.
        </div>
        <div v-if="workspace?.scan.errors.length" class="message warning">
          <strong>Не все каталоги удалось проверить</strong>
          <p v-for="item in workspace.scan.errors" :key="item">{{ item }}</p>
        </div>
        <template v-if="workspace">
          <p class="help" aria-live="polite">
            {{
              workspace.refresh.running
                ? 'Читаем состояние проектов…'
                : workspace.settings.autoRefreshMinutes
                  ? `Интервал обновления проектов: ${workspace.settings.autoRefreshMinutes} мин.`
                  : 'Автоматическое обновление проектов отключено.'
            }}
          </p>
          <div
            v-if="workspace.refresh.errors.length"
            class="message warning"
            role="alert"
            aria-label="Обновление проектов"
          >
            <strong>При автоматическом обновлении не все данные удалось прочитать</strong>
            <p v-if="workspace.refresh.lastAttemptAt" class="help">
              Последняя попытка:
              {{ new Date(workspace.refresh.lastAttemptAt).toLocaleString('ru') }}
            </p>
            <p v-for="item in workspace.refresh.errors" :key="item">{{ item }}</p>
          </div>
        </template>
        <RouterView v-if="workspace" />
        <p v-else class="empty">
          {{
            busy
              ? 'Загружаем рабочее пространство…'
              : 'Не удалось загрузить данные. Проверьте запуск сервера.'
          }}
        </p>
      </main>
    </div>
  </div>
</template>
