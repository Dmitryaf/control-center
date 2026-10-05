# Control Center

A local dashboard for projects, tasks, ideas, and hypothesis checks. See what needs attention and choose the next step. Works with public or private repositories and projects without a Git remote. The interface is in Russian.

## Get started

Install **Node.js 22.17+** and **Git**, then run:

```sh
git clone https://github.com/Dmitryaf/control-center.git
cd control-center
npm ci
npm run dev
```

Open [localhost:4310](http://127.0.0.1:4310), add your project folders in **Settings**, and scan. Open a project to set its focus and next step. Use **Refresh** to reread projects; opening a project also refreshes its files and Git status.

## Checks

Start a check from an idea or the **Checks** page. Record the question, expected external result, conditions to continue or stop, and the next external step.

Log **external actions** and **evidence** separately. Dates stay visible. Git commits show development work; they never reset the external-action clock. Evidence has its own date. With no actions, elapsed time starts at the check's launch date.

Reminders appear inside the app: information after **3 days**, attention after **7**, and a decision prompt after **14** without an external action. Change these intervals in Settings or set a review date for a check. Paused checks have no reminders. Completion requires a result and a decision; the check stays in the archive.

## Your data

SQLite stores your settings, notes, tasks, ideas, checks, and local decisions. The default database is `control-center.sqlite` in:

- Windows: `%LOCALAPPDATA%/ControlCenter`
- macOS: `~/Library/Application Support/ControlCenter`
- Linux: `$XDG_DATA_HOME/control-center` or `~/.local/share/control-center`

Set `CONTROL_CENTER_DATA_DIR` to use another directory.

**Settings → Create backup** saves and verifies a SQLite copy and shows its path. See [backup and restore](docs/data.md) for recovery instructions.

Moved a project? Scan its new location, open the unavailable project, and use **Rebind** to keep its ID and history. **Удалить из Control Center** removes any project after confirmation and excludes its directory from future scans. Records and checks remain unassigned; relations, local metadata and project notes are removed. Repository and private-context files stay intact. To discover it again, remove its path under **Settings → Проекты, удалённые из Control Center** and save settings. It receives a new ID; removed local data and former record links are not restored.

## Project files and decisions

`PROJECT.yaml` is an optional project summary. Local edits take priority. If the file changes, compare versions and choose which to keep. Writing back to YAML is always explicit.

Project decisions stay in `DECISIONS.md` and `decisions/*.md`. Control Center reads Agent Kit YAML front matter, flags due reviews and accepted decisions awaiting implementation, and also displays older Markdown records. It does not edit these files.

Open **Источники контекста → Настройки контекста** on a project to explicitly select **Репозиторий публичный**, **Репозиторий приватный**, or **Не указано**. Visibility is a local setting; it is never guessed from a remote URL or changed on GitHub.

Link a separate local folder using **Каталог приватного контекста**. Control Center reads its `DECISIONS.md` and `decisions/*.md`, and reports whether `PROJECT_MAP.md` exists. Other folders, such as `research/`, `hypotheses/`, and `agent/`, are allowed but not indexed yet. Keep the context outside the project repository and arrange its private versioning and backup yourself.

Repository and private-context decisions share one list with visible sources. Conflicting IDs show both entries; neither wins automatically. Text is read from its canonical file when opened. **Отключить приватный контекст** removes the local link after confirmation and leaves every file intact. An unavailable source loses its temporary index; a public project with previously seen private records gets an attention signal. Existing additional decision directories and SQLite decisions remain supported without automatic migration.

The separation is:

- **Repository**: source code and documents intended for its readers.
- **Agent Kit**: local working infrastructure (`AGENTS.md`, `.ai-rules/`), connected separately after cloning.
- **Private Project Context**: long-lived internal documents in a separate private source.
- **Control Center**: combines these sources with local tasks, ideas, and checks.

For public projects, **Проверка публикации** inspects `git ls-files`, including staged changes. Tracked `.ai-rules/`, `AGENTS.md`, and `.local/` are strong internal-infrastructure signals. Decision records and project maps require an audience check; their names do not prove a leak. Choose **Этот путь намеренно публичный** to suppress the signal for that exact path. Review or remove confirmations under **Намеренно публичные пути**. This does not inspect remote publication, history, file contents for secrets, or future edits to an allowed path.

Visibility, private paths, publication confirmations, and the fact that private records were previously found stay only in SQLite and its private backups. They are never added to `PROJECT.yaml`, repository decisions, or Git configuration. Document bodies are not stored in SQLite. Only actionable publication/context problems are added to the overview. Control Center never installs Kit, moves source files, commits, pushes, or publishes automatically.

Everything stays on your computer. No accounts, cloud sync, GitHub API, or external AI services. Scanning reads files without running project code.

## Development

Vue 3, TypeScript, Vite, a local Node.js API, and SQLite.

```sh
npm run check            # Lint, typecheck, tests, and build
npm run test:e2e         # Browser tests; requires Microsoft Edge
npm run test:production  # Built app, persistence, and backup
npm start               # Run the built app
```
