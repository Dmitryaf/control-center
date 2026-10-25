import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  proposalApprovalSchema,
  type ProposalAcceptance,
  type ProposalApproval,
} from '../../shared/proposal-acceptances.js';
import type { Store } from '../db.js';
import { Tasks } from '../tasks.js';
import { Records } from '../records.js';
import { HttpError } from '../errors.js';
import type { PeriodAnalysis } from './period-analysis.js';

export class ProposalAcceptances {
  constructor(
    private store: Store,
    private analysis: PeriodAnalysis,
  ) {}
  links(): Record<string, string> {
    const rows = this.store.db
      .prepare(
        "SELECT a.id,a.result_id FROM analysis_acceptances a JOIN records r ON r.id=a.result_id AND r.kind=CASE WHEN a.kind='task' THEN 'tasks' ELSE 'ideas' END",
      )
      .all();
    return Object.fromEntries(rows.map((row) => [String(row.result_id), String(row.id)]));
  }
  private index(index: unknown) {
    return z.coerce.number().int().min(0).max(7).parse(index);
  }
  private dto(row: Record<string, unknown>): ProposalAcceptance {
    const kind = row.kind as 'task' | 'idea';
    const exists = !!this.store.db
      .prepare('SELECT id FROM records WHERE id=? AND kind=?')
      .get(String(row.result_id), kind === 'task' ? 'tasks' : 'ideas');
    return {
      id: String(row.id),
      runId: row.analysis_run_id as string | null,
      runKey: String(row.run_key),
      proposalIndex: Number(row.proposal_index),
      kind,
      resultId: String(row.result_id),
      resultExists: exists,
      resultHref: kind === 'task' ? `/tasks?task=${row.result_id}` : `/ideas#idea-${row.result_id}`,
      createdAt: String(row.created_at),
      approved: JSON.parse(String(row.approved_json)),
      original: JSON.parse(String(row.original_json)),
    };
  }
  read(id: string) {
    z.string().uuid().parse(id);
    const row = this.store.db.prepare('SELECT * FROM analysis_acceptances WHERE id=?').get(id);
    if (!row) throw new HttpError(404, 'Принятое предложение не найдено.');
    return this.dto(row);
  }
  forRun(id: string) {
    z.string().uuid().parse(id);
    return this.store.db
      .prepare('SELECT * FROM analysis_acceptances WHERE run_key=? ORDER BY proposal_index')
      .all(id)
      .map((row) => this.dto(row));
  }
  list(input: unknown = {}) {
    const { cursor, limit } = z
      .object({
        cursor: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(30).default(20),
      })
      .strict()
      .parse(input);
    const rows = this.store.db
      .prepare(
        `SELECT * FROM analysis_acceptances ${cursor ? 'WHERE id>?' : ''} ORDER BY id LIMIT ?`,
      )
      .all(...(cursor ? [cursor] : []), limit + 1);
    return {
      items: rows.slice(0, limit).map((row) => this.dto(row)),
      nextCursor: rows.length > limit ? String(rows[limit - 1].id) : null,
    };
  }
  private existing(runId: string, index: number, approved: ProposalApproval) {
    const row = this.store.db
      .prepare('SELECT * FROM analysis_acceptances WHERE run_key=? AND proposal_index=?')
      .get(runId, index);
    if (!row) return null;
    if (JSON.stringify(JSON.parse(String(row.approved_json))) !== JSON.stringify(approved))
      throw new HttpError(
        409,
        'Это предложение уже принято с другой редакцией. Откройте сохранённую запись; исходная задача или идея не изменена.',
      );
    return this.dto(row);
  }
  accept(runId: string, indexInput: unknown, input: unknown) {
    z.string().uuid().parse(runId);
    const index = this.index(indexInput),
      approved = proposalApprovalSchema.parse(input);
    const previous = this.existing(runId, index, approved);
    if (previous) return previous;
    const run = this.analysis.read(runId);
    const proposal = run.report?.proposals[index];
    if (run.status !== 'succeeded' || !proposal)
      throw new HttpError(
        409,
        'Для принятия нужен сохранённый успешный анализ и существующее предложение.',
      );
    if (
      approved.projectId
        ? !proposal.projectIds.includes(approved.projectId)
        : proposal.projectIds.length > 0
    )
      throw new HttpError(
        400,
        'Выберите один из проектов предложения. Общая запись разрешена только для общего предложения.',
      );
    if (approved.projectId && !this.store.project(approved.projectId))
      throw new HttpError(410, 'Проект удалён. Предложение сохраняется только для чтения.');
    const sources = proposal.sources.map((id) =>
      run.payload.sources.find((source) => source.id === id),
    );
    if (sources.some((source) => !source))
      throw new HttpError(409, 'Основания предложения не входят в сохранённый пакет.');
    const bytes = createHash('sha1')
      .update(Buffer.from(runId.replaceAll('-', ''), 'hex'))
      .update(`proposal:${index}`)
      .digest()
      .subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 80;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = bytes.toString('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const original = {
      origin: run.origin ?? 'openai',
      reviewKey: run.reviewKey,
      proposal,
      sources,
      model: run.model,
      packetHash: run.packetHash,
      period: run.payload.period,
    };
    const description = [
      approved.description,
      `Основание: ${approved.reason}`,
      `Неизвестное: ${approved.uncertainty || 'Не указано'}`,
      `Дешёвая проверка: ${approved.cheapCheck}`,
      `Редакция и источники: /proposal-acceptances?id=${id}`,
    ].join('\n\n');
    let accepted: ProposalAcceptance | undefined;
    const link = (resultId: string) => {
      // Recheck while holding the same write lock as the target creation.
      const repeated = this.existing(runId, index, approved);
      if (repeated) {
        accepted = repeated;
        return;
      }
      const current = this.analysis.read(runId);
      if (current.status !== 'succeeded')
        throw new HttpError(409, 'Анализ больше недоступен для принятия.');
      this.store.db
        .prepare(
          'INSERT INTO analysis_acceptances(id,analysis_run_id,run_key,proposal_index,kind,result_id,approved_json,original_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          runId,
          runId,
          index,
          approved.kind,
          resultId,
          JSON.stringify(approved),
          JSON.stringify(original),
          new Date().toISOString(),
        );
      accepted = this.read(id);
    };
    if (approved.kind === 'task') {
      new Tasks(this.store).createLinked(
        {
          title: approved.title,
          projectId: approved.projectId,
          description,
          expectedResult: approved.expectedResult,
          acceptance: approved.acceptance,
          priority: approved.priority,
          requestKey: `period-proposal:${runId}:${index}`,
          allowDuplicate: approved.allowDuplicate,
        },
        (task) => link(task.id),
      );
    } else
      this.store.transaction(() => {
        const repeated = this.existing(runId, index, approved);
        if (repeated) {
          accepted = repeated;
          return;
        }
        const resultId = randomUUID();
        if (this.store.db.prepare('SELECT id FROM records WHERE id=?').get(resultId))
          throw new HttpError(409, 'Идентификатор уже занят. Повторите создание.');
        const result = new Records(this.store).save(
          'ideas',
          {
            title: approved.title,
            projectId: approved.projectId,
            description,
            state: 'new',
          },
          resultId,
        );
        link(result.id);
      });
    return accepted!;
  }
}
