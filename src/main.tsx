import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ActionProvider } from './shared/workspace';
import App from './App';
import Settings from './features/settings/Settings';
import Projects from './features/projects/Projects';
import ProjectDetail from './features/projects/ProjectDetail';
import Overview from './features/overview/Overview';
import Tasks, { TaskHistory } from './features/tasks/Tasks';
import Checks, { CheckDetail } from './features/checks/Checks';
import { Ideas, Decisions } from './features/records/Records';
import Analysis from './features/analysis/Analysis';
import History from './features/history/History';
import Observations from './features/observations/Observations';
import Reviews from './features/reviews/Reviews';
import CodexContext from './features/codex-context/CodexContext';
import Acceptances, { Proposal } from './features/period-analysis/Proposals';
import Schedules from './features/period-analysis/Schedules';
import PeriodAnalysis from './features/period-analysis/PeriodAnalysis';
import CodexAnalysis from './features/codex-analysis/CodexAnalysis';
import './style.css';
import './styles/components.css';
const router = createBrowserRouter([
  {
    element: <App />,
    children: [
      { path: '/', element: <Overview /> },
      { path: '/projects', element: <Projects /> },
      { path: '/projects/:id', element: <ProjectDetail /> },
      { path: '/tasks', element: <Tasks /> },
      { path: '/history', element: <TaskHistory /> },
      { path: '/timeline', element: <History /> },
      { path: '/observations', element: <Observations /> },
      { path: '/reviews', element: <Reviews /> },
      { path: '/period-analysis', element: <PeriodAnalysis /> },
      { path: '/analysis-schedules', element: <Schedules /> },
      { path: '/period-proposal', element: <Proposal /> },
      { path: '/codex-context', element: <CodexContext /> },
      { path: '/proposal-acceptances', element: <Acceptances /> },
      { path: '/checks', element: <Checks /> },
      { path: '/checks/:id', element: <CheckDetail /> },
      { path: '/ideas', element: <Ideas /> },
      { path: '/decisions', element: <Decisions /> },
      { path: '/analysis', element: <Analysis /> },
      { path: '/codex-analysis', element: <CodexAnalysis /> },
      { path: '/settings', element: <Settings /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={client}>
    <ActionProvider>
      <RouterProvider router={router} />
    </ActionProvider>
  </QueryClientProvider>,
);
