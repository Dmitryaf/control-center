import { useEffect, useState } from 'react';
export function AnalysisProgress({
  startedAt,
  stage,
  stopping,
  busy,
  onStop,
  scope,
}: {
  startedAt: string | null;
  stage: string | null;
  stopping: boolean;
  busy: boolean;
  onStop: () => void;
  scope: string;
}) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(
    0,
    Math.floor((clock - Date.parse(startedAt || new Date(clock).toISOString())) / 1000),
  );
  return (
    <section className="analysis-progress" aria-label="Ход анализа">
      <p className="analysis-progress-scope">{scope}</p>
      <div className="analysis-progress-heading">
        <span className="analysis-spinner" role="progressbar" aria-label="Выполняется анализ" />
        <div>
          <h2>{stopping ? 'Останавливаем анализ' : 'Codex работает'}</h2>
          <p role="status" aria-live="polite">
            {stopping ? 'Ждём подтверждения остановки' : stage || 'Подготовка запуска'}
          </p>
        </div>
      </div>
      <p className="analysis-elapsed">
        Прошло {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </p>
      <p className="help">Можно закрыть страницу и вернуться позже. Ответ сохранится здесь.</p>
      <button disabled={busy || stopping} onClick={onStop}>
        {stopping ? 'Остановка запрошена' : 'Остановить анализ'}
      </button>
    </section>
  );
}
