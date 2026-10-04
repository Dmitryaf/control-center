# Control Center

A local dashboard for your projects, tools, tasks, ideas, and decisions. See what is active, what needs attention, and what to do next.

Works with local repositories, including private projects and projects without a Git remote. The interface is in Russian.

## Get started

Install **Node.js 22.17+** and **Git**, then run:

```sh
git clone https://github.com/Dmitryaf/control-center.git
cd control-center
npm ci
npm run dev
```

Open [localhost:4310](http://127.0.0.1:4310).

1. Open Settings and add your project folders, such as `C:/Personal`.
2. Scan the folders and open a project.
3. Set its status, current focus, and next step.
4. Add tasks, ideas, decisions, and links between projects.

Projects refresh on startup and when you click Refresh. Opening a project also updates its Git status.

## Your data

Everything stays on your computer. Settings and your entries are stored in `.data/control-center.sqlite`, which is excluded from Git. To back up your data, stop the app and copy the `.data` folder.

Scanning only reads repositories. It does not change files or run project code.

## Optional project summary

Add a `PROJECT.yaml` file to a project, or create it from the interface:

```yaml
name: My Project
type: product
status: active
current_focus: Prepare the first release
next:
  - Test the main workflow
```

Projects work without this file. Edits saved in Control Center take priority over YAML. Writing them back to `PROJECT.yaml` requires an explicit export.

## Development

Built with Vue 3, TypeScript, Vite, a local Node.js API, and SQLite. No accounts, cloud sync, GitHub integration, or AI services.

```sh
npm run check    # Lint, typecheck, tests, and production build
npm start        # Run the built app locally
```

Browser tests: `npm run test:e2e` (requires Microsoft Edge).
