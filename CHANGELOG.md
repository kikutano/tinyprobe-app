# Changelog

## 0.3.0

- **The visual editor**: edit an endpoint, add and edit auth sets (bearer token, API key header, Basic, OAuth2 client credentials), create a workflow with its first step, and add, edit, move and delete its steps: the endpoint, its values, the expected status, checks on the response (equals, >, contains, is one of, matches, exists...) and the values to save. Every form shows what is written, rewrites only its block of the file, and keeps the change only if tinyprobe accepts the file. What the forms do not show is edited as YAML, one block at a time. It reads files with `tinyprobe inspect --source` (tinyprobe 0.21.0).
- **The diagram of a workflow**: its steps in order, the steps of a sequence grouped under its name, `until` and `for_each` marked, and a colored line for each saved value from the step that saves it to the steps that use it. What comes from the environment or the workflow's variables is listed above, and a value defined nowhere is shown in red. It lights up as the workflow runs (the item of a `for_each`, the attempt of an `until`), and again when the workflow is opened later. Click a step for what it sends, checks and saves, and its last result. **List** shows the steps as before.

## 0.2.0

- **Environment**: the variables of the selected env file, edited in place. A change rewrites only that variable's lines, so comments and order stay; names that look like secrets are hidden until shown. Block values (on several lines) are edited in the file.
- **History**: the last 50 requests sent from the app, per folder, newest first, with status and time. Open one to see its request and response again, or send it again with its values and the environment picked now. Kept in the app's data folder, bodies cut at 64 KiB.
- The editing of environment files and the history are shared with the VS Code extension (`web/shared/`), as the run view is.

## 0.1.1

- **Install with one command**: `curl -fsSL https://raw.githubusercontent.com/kikutano/tinyprobe-app/main/install.sh | sh` on Linux and macOS, `irm https://raw.githubusercontent.com/kikutano/tinyprobe-app/main/install.ps1 | iex` on Windows. The app is checked against the release's checksums, the tinyprobe icon is added, and tinyprobe is downloaded if it is missing; no warning for an unsigned app. Run it again to update.
- `tinyprobe-app --install`, the step the installers run: copy the app to its folder, add the icon, download tinyprobe if needed.

## 0.1.0

The first version (tinyprobe spec 0017, roadmap M5-1).

- A launcher for Windows, macOS and Linux that serves the app on `127.0.0.1` and opens it in the browser; closing its window stops it, and a second start opens the running one.
- Open a folder (a folder browser and the recent folders; a project opens on its `tinyprobe/` folder), with its API files, workflows, sequences, environments and the problems of invalid files.
- Send an endpoint from a form, run a workflow, run it up to a step, run every workflow of the folder, with live results shown by the run view of the VS Code extension.
- **+ New request** writes an endpoint into an API file, or a new one, and keeps it only if `tinyprobe inspect` accepts the file.
- Uses the `tinyprobe` on the PATH (0.20.0 or newer), or downloads its own copy, checked against the release's checksums.
- Offers an icon in the Start menu and on the desktop, in Applications or in the applications menu.
