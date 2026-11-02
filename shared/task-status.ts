type TaskState = { completedAt: string | null; cancellation?: unknown };
export const isTaskOpen = (task: TaskState) => !task.completedAt && !task.cancellation;
export const taskOutcome = (task: TaskState) =>
  task.cancellation ? 'cancelled' : task.completedAt ? 'done' : 'open';
