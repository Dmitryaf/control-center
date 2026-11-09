import { Link } from 'react-router';
import type { PeriodRun } from '../../../shared/period-analysis';
import { date } from '../../shared/labels';
import './analysis-reading.css';
import { codexDefaultQuestion } from '../../../shared/codex-analysis';

function Narrative({ text, projectNames }: { text: string; projectNames: string[] }) {
  const lines = text.split(/\r?\n/);
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  function flush() {
    const body = paragraph.join('\n').trim();
    if (body)
      blocks.push(
        <p key={blocks.length} className="preserve">
          {body}
        </p>,
      );
    paragraph = [];
  }
  for (const line of lines) {
    if (projectNames.includes(line.trim())) {
      flush();
      blocks.push(
        <h3 className="analysis-project-title" key={blocks.length}>
          {line.trim()}
        </h3>,
      );
    } else paragraph.push(line);
  }
  flush();
  return blocks;
}

export function SavedReport({ run }: { run: PeriodRun }) {
  if (!run.report) return null;
  const origin = run.payload.origin;
  const title =
    origin?.kind === 'codex_runtime'
      ? origin.question === codexDefaultQuestion
        ? 'Разбор проектов за период'
        : origin.question
      : run.origin === 'codex_manual'
        ? 'Анализ Codex'
        : 'Обзор периода';
  return (
    <article className="analysis-reading analysis-result" aria-label="Сохранённый ответ">
      <p className="reading-period">
        {date(run.payload.period.from)} — {date(run.payload.period.to)}
      </p>
      <h2>{title}</h2>
      {run.origin === 'codex_manual' && !origin?.purpose && (
        <p className="message warning">Старый ручной импорт. Назначение разбора не указано.</p>
      )}
      <Narrative
        text={run.report.narrative}
        projectNames={run.payload.sources.filter((s) => s.kind === 'project').map((s) => s.title)}
      />
      <details>
        <summary>Откуда это известно</summary>
        {run.payload.period.incomplete && <p>Период на момент подготовки был неполным.</p>}
        {!run.report.findings.length && (
          <ul>
            {run.payload.sources.map((source) => (
              <li key={source.id}>{source.title}</li>
            ))}
          </ul>
        )}
        {!run.payload.sources.length && <p>Для этого разбора нет сохранённых источников.</p>}
        {run.report.findings.length > 0 && (
          <>
            <h3>Выводы и основания</h3>
            {run.report.findings.map((finding, index) => (
              <article key={index}>
                <p>{finding.statement}</p>
                <ul>
                  {finding.sources.map((id) => (
                    <li key={id}>
                      {run.payload.sources.find((source) => source.id === id)?.title}{' '}
                      <small>({id})</small>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </>
        )}
        {run.report.uncertainties.length > 0 && (
          <>
            <h3>Что остаётся неизвестным</h3>
            <ul>
              {run.report.uncertainties.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </>
        )}
      </details>
      {run.report.proposals.length > 0 && (
        <details>
          <summary>Предложения · {run.report.proposals.length}</summary>
          {run.report.proposals.map((proposal, index) => (
            <article key={index}>
              <h4>{proposal.title}</h4>
              <p>{proposal.description}</p>
              <p>{proposal.reason}</p>
              <p>
                Основания:{' '}
                {proposal.sources
                  .map((id) => run.payload.sources.find((s) => s.id === id)?.title ?? id)
                  .join('; ')}
              </p>
              <Link to={`/period-proposal?run=${run.id}&index=${index}`}>
                Проверить и принять предложение →
              </Link>
              <p className="help">
                {proposal.uncertainty && <>Что ещё выяснить: {proposal.uncertainty}. </>}
                Первый шаг: {proposal.cheapCheck}
              </p>
            </article>
          ))}
        </details>
      )}
    </article>
  );
}
