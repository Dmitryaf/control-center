import { Link, Outlet, useLocation } from 'react-router';
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DraftProvider } from './shared/UnsavedChanges';
import { useWorkspace, useActions } from './shared/workspace';
import { api } from './shared/http';

export default function App() {
  const query = useWorkspace();
  const { busy, error, notice, act } = useActions();
  const workspace = query.data;
  const location = useLocation();
  const ready = !!workspace;
  useEffect(() => {
    if (!ready || !location.hash) return;
    let target: HTMLElement | null = null;
    let addedTabIndex = false;
    const frame = requestAnimationFrame(() => {
      target = document.getElementById(location.hash.slice(1));
      if (!target) return;
      target.scrollIntoView();
      target.setAttribute('data-history-target', 'true');
      addedTabIndex = !target.hasAttribute('tabindex');
      if (addedTabIndex) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(frame);
      target?.removeAttribute('data-history-target');
      if (addedTabIndex) target?.removeAttribute('tabindex');
    };
  }, [ready, location.pathname, location.hash]);
  const client = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden && !busy)
        void client
          .cancelQueries({ type: 'active' })
          .then(() => client.refetchQueries({ type: 'active' }));
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [client, busy]);
  const selected = (path: string) =>
    path === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(path) ||
        (path === '/tasks' && location.pathname === '/history') ||
        (path === '/timeline' &&
          ['/observations', '/reviews', '/period-analysis'].includes(location.pathname)) ||
        (path === '/projects' && location.pathname === '/analysis');
  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        К содержимому
      </a>
      <header className="workspace-bar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            ↗
          </span>
          <span>
            Control Center<small>Локальное рабочее пространство</small>
          </span>
        </Link>
        <nav aria-label="Основная навигация">
          {[
            ['/', 'Обзор'],
            ['/projects', 'Проекты'],
            ['/timeline', 'История'],
            ['/checks', 'Проверки'],
            ['/tasks', 'Задачи'],
            ['/ideas', 'Идеи'],
            ['/decisions', 'Решения'],
            ['/settings', 'Настройки'],
          ].map(([path, label]) => (
            <Link
              key={path}
              to={path}
              aria-current={selected(path) ? 'page' : undefined}
              className={selected(path) ? 'selected' : ''}
            >
              {label}
            </Link>
          ))}
        </nav>
        <button
          disabled={busy || (!workspace && query.isPending)}
          onClick={() => act(() => api('/scan', 'POST'), 'Данные обновлены')}
        >
          {busy || (!workspace && query.isPending) ? 'Обновление…' : '↻ Обновить'}
        </button>
      </header>
      <div className="main-shell">
        <main id="content" tabIndex={-1}>
          {error && (
            <div className="message error" role="alert" aria-label="Ошибка действия">
              {error}{' '}
              <button
                disabled={busy}
                onClick={() => act(() => query.refetch({ throwOnError: true }))}
              >
                Повторить загрузку
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              {notice}
            </div>
          )}
          {query.isError && (
            <div
              className="message warning"
              role="alert"
              aria-label={workspace ? 'Связь с сервером' : 'Ошибка действия'}
            >
              {workspace
                ? 'Нет связи с локальным сервером. Показаны ранее загруженные данные; загрузка повторится автоматически.'
                : query.error.message}
              <button onClick={() => act(() => query.refetch({ throwOnError: true }))}>
                Повторить загрузку
              </button>
            </div>
          )}
          {workspace ? (
            <>
              {workspace.scan.errors.length > 0 && (
                <div className="message warning">
                  <strong>Не все каталоги удалось проверить</strong>
                  {workspace.scan.errors.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
              )}
              <p className="help" aria-live="polite">
                {workspace.refresh.running
                  ? 'Читаем состояние проектов…'
                  : workspace.settings.autoRefreshMinutes
                    ? `Интервал обновления проектов: ${workspace.settings.autoRefreshMinutes} мин.`
                    : 'Автоматическое обновление проектов отключено.'}
              </p>
              {workspace.refresh.errors.length > 0 && (
                <div className="message warning" role="alert" aria-label="Обновление проектов">
                  <strong>При автоматическом обновлении не все данные удалось прочитать</strong>
                  {workspace.refresh.lastAttemptAt && (
                    <p className="help">
                      Последняя попытка:{' '}
                      {new Date(workspace.refresh.lastAttemptAt).toLocaleString('ru')}
                    </p>
                  )}
                  {workspace.refresh.errors.map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                </div>
              )}
              <DraftProvider>
                <Outlet />
              </DraftProvider>
            </>
          ) : (
            !query.isError && <p className="empty">Загружаем рабочее пространство…</p>
          )}
        </main>
      </div>
    </div>
  );
}
