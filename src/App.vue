<script setup lang="ts">
import { onMounted } from 'vue';
import { act, api, busy, error, notice, reload, workspace } from './shared/api';
const navigation = [
  ['/', 'Обзор', '01'],
  ['/projects', 'Проекты', '02'],
  ['/checks', 'Проверки', '03'],
  ['/tasks', 'Задачи', '04'],
  ['/ideas', 'Идеи', '05'],
  ['/decisions', 'Решения', '06'],
  ['/settings', 'Настройки', '07'],
];
onMounted(() => act(reload));
function refresh() {
  return act(async () => {
    await api('/scan', 'POST');
  }, 'Данные обновлены');
}
</script>
<template>
  <div class="shell">
    <aside class="sidebar">
      <RouterLink to="/" class="brand"
        ><span class="brand-mark">C<span>·</span></span
        ><span>Control Center<small>Личное рабочее пространство</small></span></RouterLink
      >
      <p class="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</p>
      <nav aria-label="Основная навигация">
        <RouterLink
          v-for="[path, label, number] in navigation"
          :key="path"
          :to="path"
          :class="{ selected: path === '/' ? $route.path === '/' : $route.path.startsWith(path) }"
          ><span class="nav-number">{{ number }}</span
          >{{ label
          }}<span v-if="path === '/projects' && workspace" class="nav-count">{{
            workspace.projects.length
          }}</span></RouterLink
        >
      </nav>
      <div class="sidebar-foot">
        <span class="local-dot" /> Локально на вашем компьютере<small>Данные остаются у вас</small>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <span>Всё важное — в одном месте</span
        ><button :disabled="busy" @click="refresh">
          {{ busy ? 'Обновление…' : '↻ Обновить' }}
        </button>
      </header>
      <main>
        <div v-if="error" class="message error" role="alert">
          {{ error }} <button :disabled="busy" @click="act(reload)">Повторить загрузку</button>
        </div>
        <div v-if="notice" class="message success" role="status">{{ notice }}</div>
        <div v-if="workspace?.scan.errors.length" class="message warning">
          <strong>Не все каталоги удалось проверить</strong>
          <p v-for="item in workspace.scan.errors" :key="item">{{ item }}</p>
        </div>
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
