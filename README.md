# Control Center

Control Center helps you keep track of your projects and decide what to do next. It brings each project's purpose, tasks, results and notes together in one place.

The app runs on your computer and opens in your browser. The interface is in Russian.

## What you can do

- See your projects and their current status.
- Keep a task list and record completed work.
- Save observations and decisions in the project's history.
- Review a week or month to understand what changed.
- Use optional AI analysis to help think through progress and next steps.

Each project page shows its description, current tasks, recent history and latest review.

## Get started

Install **Node.js 22.17+** and **Git**, then run:

```sh
git clone https://github.com/Dmitryaf/control-center.git
cd control-center
npm ci
npm run dev
```

In PowerShell, use `npm.cmd` instead of `npm`.

Open [Control Center](http://127.0.0.1:4310). Add the folders containing your projects in settings, then scan them. Open a project, describe its purpose and add your first task or note. Both repositories and ordinary project folders are supported.

On Windows, you can also [create a desktop shortcut](SETUP.md#windows-desktop-shortcut) to open the app with a double-click.

## Your data

Tasks, notes and reviews are stored on your computer. There are no accounts or cloud sync. You can create a backup in settings; project files need their own backup.

AI is optional. Built-in analysis requires an OpenAI API key and paid API access. You choose what to share and approve sending it. The rest of the app works without it.

See [setup and usage](SETUP.md) when you need AI or Codex setup, backup restoration or development commands.
