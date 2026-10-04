# Control Center

A local dashboard for projects, tasks, ideas, and hypothesis checks. See what needs attention and choose the next step. Works with private repositories and projects without a Git remote. The interface is in Russian.

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

Moved a project? Scan its new location, open the unavailable project, and use **Rebind** to keep its ID and history. **Forget project** detaches its records and removes its links; it never deletes repository files.

## Project files and decisions

`PROJECT.yaml` is an optional project summary. Local edits take priority. If the file changes, compare versions and choose which to keep. Writing back to YAML is always explicit.

Project decisions stay in `DECISIONS.md` and `decisions/*.md`. Control Center reads Agent Kit YAML front matter, flags due reviews and accepted decisions awaiting implementation, and also displays older Markdown records. It does not edit these files.

To add private decisions, open a project and expand **Additional decision directories**. Directory paths stay in local SQLite and are never exported to YAML. General decisions remain in SQLite; older project-linked local decisions are preserved and labeled.

Everything stays on your computer. No accounts, cloud sync, GitHub API, or external AI services. Scanning reads files without running project code.

## Development

Vue 3, TypeScript, Vite, a local Node.js API, and SQLite.

```sh
npm run check            # Lint, typecheck, tests, and build
npm run test:e2e         # Browser tests; requires Microsoft Edge
npm run test:production  # Built app, persistence, and backup
npm start               # Run the built app
```
