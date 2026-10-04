import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Overview from './features/overview/Overview.vue';
import Projects from './features/projects/Projects.vue';
import ProjectDetail from './features/projects/ProjectDetail.vue';
import Tasks from './features/tasks/Tasks.vue';
import Ideas from './features/ideas/Ideas.vue';
import Decisions from './features/decisions/Decisions.vue';
import Settings from './features/settings/Settings.vue';
import Checks from './features/checks/Checks.vue';
import CheckDetail from './features/checks/CheckDetail.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Overview },
    { path: '/projects', component: Projects },
    { path: '/projects/:id', component: ProjectDetail },
    { path: '/checks', component: Checks },
    { path: '/checks/:id', component: CheckDetail },
    { path: '/tasks', component: Tasks },
    { path: '/ideas', component: Ideas },
    { path: '/decisions', component: Decisions },
    { path: '/settings', component: Settings },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
createApp(App).use(router).mount('#app');
