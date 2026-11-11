# Setup

## Get started

Install Node.js 22.17+ and Git. From the project checkout:

```sh
npm ci
npm run dev
```

In PowerShell use `npm.cmd`. Open [http://127.0.0.1:4310](http://127.0.0.1:4310). Add the folders containing your projects in Settings and scan. Open a project, describe its purpose and add a task or observation.

## Windows shortcut

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1
```

The shortcut launches the current sources and checks that an existing process belongs to this checkout and database. Closing the browser leaves the server running. Restart after backend updates; startup with Windows is not configured by the launcher.

## Analysis

With a compatible Codex CLI installed, open analysis, select projects and period, prepare context and sign in to the separate Control Center profile when prompted. Inspect the packet before confirming a question. Opening analysis alone does not dispatch it.

The OpenAI API is a separate optional provider. Its credentials remain in the HTTP server environment. [Provider, context and task access](guides/ANALYSIS.md).

## Data

Windows defaults to `%USERPROFILE%/.control-center/control-center.sqlite`. `CONTROL_CENTER_DATA_DIR` overrides the directory. If an older AppData database exists and the new location is empty, startup asks for recovery rather than creating an apparently empty workspace.

Create a verified backup in Settings. Before moving or replacing a database, stop all HTTP and MCP writers and follow [storage, backup and restore](guides/MAINTENANCE.md#storage-backup-and-restore). Repository files and private context need their own backup.
