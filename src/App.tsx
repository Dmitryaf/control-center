import { Link, Outlet, useLocation } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DraftProvider } from './shared/UnsavedChanges';
import { useWorkspace, useActions } from './shared/workspace';
import { api } from './shared/http';
import {
  LayoutDashboard,
  FolderOpen,
  ListTodo,
  History,
  MessageSquareText,
  Notebook,
  Menu,
  RefreshCw,
  Settings,
} from 'lucide-react';

export default function App() {
  const query = useWorkspace();
  const { busy, error, notice, act } = useActions();
  const workspace = query.data;
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => {
    if (
      document.activeElement?.closest('#workspace-navigation') &&
      menuToggle.current?.offsetWidth &&
      !location.hash
    ) {
      document.getElementById('content')?.focus({ preventScroll: true });
    }
    setMobileOpen(false);
    setMoreOpen(
      ['/checks', '/ideas', '/decisions'].some((path) => location.pathname.startsWith(path)),
    );
  }, [location.key, location.pathname]);
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
  const route = '/' + location.pathname.split('/')[1];
  const sections: Record<string, string> = {
    '/codex-analysis': '/analysis',
    '/period-analysis': '/analysis',
    '/analysis-schedules': '/analysis',
    '/period-proposal': '/analysis',
    '/proposal-acceptances': '/analysis',
    '/codex-context': '/analysis',
    '/history': '/timeline',
    '/observations': '/timeline',
    '/reviews': '/timeline',
    '/project-lifecycle': '/timeline',
  };
  const selected = (path: string) => path === (sections[route] ?? route);
  return (
    <div className="shell">
      <a className="skip-link" href="#content">
        К содержимому
      </a>
      <header
        className="workspace-bar"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && mobileOpen) {
            setMobileOpen(false);
            menuToggle.current?.focus();
          }
        }}
      >
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Notebook size={20} />
          </span>
          <span>Control Center</span>
        </Link>
        <button
          ref={menuToggle}
          type="button"
          className="mobile-menu-toggle"
          aria-expanded={mobileOpen}
          aria-controls="workspace-navigation"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          <Menu size={18} aria-hidden="true" /> Меню
        </button>
        <nav id="workspace-navigation" aria-label="Основная навигация" data-open={mobileOpen}>
          {[
            { path: '/', label: 'Обзор', icon: LayoutDashboard },
            { path: '/projects', label: 'Проекты', icon: FolderOpen },
            { path: '/tasks', label: 'Задачи', icon: ListTodo },
            { path: '/timeline', label: 'История', icon: History },
            { path: '/analysis', label: 'Анализ проектов', icon: MessageSquareText },
            { path: '/settings', label: 'Настройки', icon: Settings },
          ].map(({ path, label, icon: Icon }) => (
            <Link
              key={path}
              to={path}
              aria-label={path === '/analysis' ? label : undefined}
              aria-current={selected(path) ? 'page' : undefined}
              className={selected(path) ? 'selected' : ''}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="navigation-label">{path === '/analysis' ? 'Анализ' : label}</span>
            </Link>
          ))}
          <details
            className="more-navigation"
            open={moreOpen}
            onToggle={(event) => setMoreOpen(event.currentTarget.open)}
          >
            <summary>Ещё</summary>
            <div className="more-navigation-links">
              {[
                ['/checks', 'Проверки'],
                ['/ideas', 'Идеи'],
                ['/decisions', 'Решения'],
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
            </div>
          </details>
        </nav>
        <button
          className="refresh-workspace"
          aria-label={busy || (!workspace && query.isPending) ? 'Обновление…' : '↻ Обновить'}
          disabled={busy || (!workspace && query.isPending)}
          onClick={() => act(() => api('/scan', 'POST'), 'Данные обновлены')}
        >
          <RefreshCw size={16} aria-hidden="true" />
          <span>{busy || (!workspace && query.isPending) ? 'Обновление…' : 'Обновить'}</span>
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
              {workspace.refresh.running && (
                <p className="help" role="status">
                  Читаем состояние проектов…
                </p>
              )}
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
