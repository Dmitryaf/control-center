import type { ProjectRefreshInfo } from '../../shared/contracts.js';
import type { Projects } from './projects.js';

// Only the HTTP process schedules reads. MCP clients refresh explicitly when context is requested.
export class ProjectRefresh {
  readonly info: ProjectRefreshInfo = { running: false, lastAttemptAt: null, errors: [] };
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  constructor(private projects: Projects) {}

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule();
  }
  reschedule() {
    clearTimeout(this.timer);
    this.controller?.abort();
    if (!this.pending) this.schedule();
  }
  async stop() {
    this.started = false;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.pending;
  }
  private schedule() {
    if (!this.started) return;
    const minutes = this.projects.store.settings().autoRefreshMinutes;
    if (!minutes) return;
    this.timer = setTimeout(() => {
      this.pending = this.run().finally(() => {
        this.pending = null;
        this.schedule();
      });
    }, minutes * 60000);
    this.timer.unref();
  }
  private async run() {
    this.controller = new AbortController();
    this.info.running = true;
    this.info.lastAttemptAt = new Date().toISOString();
    this.info.errors = [];
    try {
      this.info.errors = await this.projects.refreshKnown(this.controller.signal);
    } catch {
      this.info.errors = [
        'Не удалось обновить проекты. Следующая попытка будет выполнена автоматически.',
      ];
    } finally {
      this.info.running = false;
      this.controller = null;
    }
  }
}
