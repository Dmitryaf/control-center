# Setup

## Get started

Install **Node.js 22.17+** and **Git**, then run:

```sh
git clone https://github.com/Dmitryaf/control-center.git
cd control-center
npm ci
npm run dev
```

In PowerShell, use `npm.cmd` instead of `npm`.

Open [Control Center](http://127.0.0.1:4310). In Settings, add the folders containing your projects and scan them. Open a project, describe its purpose and add a task or observation.

## Windows desktop shortcut

Run this once from the project folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1
```

Double-click **Control Center** on your desktop to open the app. Keep the project folder in place. Closing the browser leaves the app running; restart it after updating backend code.

## Connect Codex

With Codex CLI installed:

1. Select the projects and review period.
2. Start a Codex analysis and sign in when prompted.
3. Follow the sign-in link and enter the displayed code. This is a separate profile for Control Center.
4. Ask a question, inspect the prepared context and confirm the analysis.

See [analysis and Codex](guides/ANALYSIS.md) for OpenAI API setup, task access from Codex and integration details.

## Storage, backup and restore

Create a backup in Settings. For restoring a backup, moving an installation or recovering an older Windows database, follow [backup and maintenance](guides/MAINTENANCE.md#storage-backup-and-restore).

Developer commands and project-file details are also in the [maintenance guide](guides/MAINTENANCE.md).
