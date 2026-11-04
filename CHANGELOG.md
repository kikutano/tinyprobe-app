# Changelog

## Unreleased

- **License: GPL-3.0.** From this version tinyprobe-app is licensed under the GNU General Public License, version 3 (GPL-3.0-only): it stays free and open source, and a changed version can be shared only under the same license, with its source code. Releases up to 0.4.4 stay under the MIT License.
- **A clearer head for workflows and sequences**: the name, the file and the description sit in a card of their own, the file as a small chip and the description under a line, as wide as the card, so it wraps less.

## 0.4.4

- **The outcome of the last run next to Run**: "✓ 12/12 passed" in green, or "✗ 11/12 passed · 1 failed" in red, counted live while the workflow runs; after **Run to here** it says "up to step N". Its tooltip gives the time, the checks and the requests.
- More space above and below the Run row of a workflow.

## 0.4.3

- **The diagram without lines**: a workflow is a column of steps, and each value is colored the same where it is saved and where it is used. **uses** and **saves** are in bold.
- **Bigger text in the diagram**: larger fonts, and the diagram grows with the width of the page, so it reads well on large and high-resolution screens.
- **The list of a workflow's steps shows the last run**: ✓ or ✗ for each step, with its status and time, updated as the workflow runs; a click on a step goes to its request and response.
- `scripts/dev.sh run [folder]` passed `run` to the app as a folder.

## 0.4.2

- **Opening a large folder shows how far it is**: "Reading the tinyprobe files with tinyprobe: 72 of 163", with a progress bar, instead of a page that looks stuck. Reading it again later (when the page comes back after an edit) shows a thin bar at the top and leaves the view as it is.
- **Only what changed is read again**: the app remembers what each file was read from (itself, its imports, the sequences it uses). An unchanged folder answers at once (22 ms instead of 0.8 s for 163 workflows), a changed workflow reads only that file, and a changed API file reads the workflows that import it.

## 0.4.1

- **A request is not a test**: sending an endpoint (and opening a request of the History) shows its HTTP status, `401 Unauthorized` in orange, `200 OK` in green, instead of `PASSED`, and no longer shows "1/1 steps passed · 0 checks": just the request and the response. A request that cannot be sent says so instead of "The workflow is not valid".

## 0.4.0

- **New environments**: **+** next to the environment creates `env.<name>.yaml`, empty or as a copy of another one, so that a staging environment changes only the values that differ. **Duplicate** in the Environment view does the same from the one on screen.
- **Versions and updates**: the versions of the app and of tinyprobe are next to the name; **↑ Update** appears when a newer one is out, or when the visual editor needs a newer tinyprobe, and Settings says how to update each. The app asks GitHub for the latest releases at most once a day, sending nothing else; Settings turns it off.
- **The install command updates the app's own tinyprobe** too, so a copy downloaded by an older app gets the visual editor.
- Settings and the folder picker no longer show a stray `null`.

## 0.3.2

The diagram of a workflow with many values:

- **Values wrap**: `uses` and `saves` are on lines of their own, and a long list goes on the next line inside the step instead of running out to the right.
- **No line that leads nowhere**: a value saved and never used afterwards is listed in grey, `(not used)`, without a line.
- **Every arrow reaches its step**: the arrows that come into the same step are spread along its side instead of covering each other.
- **Narrower and easier to tell apart**: a column is used again once its value has ended, and values on screen at the same time never share a color (eight colors).

## 0.3.1

From the first days of use on a real project.

- **The sidebar folds**: API, Workflows and Sequences open and close, and so does each API file, with its number of endpoints. A file opens by itself when it holds what is selected; the app remembers the rest for each folder.
- **A click on a step of the diagram goes to it**: after a run, the result selects that step and scrolls to its request and response; before, to what the step sends and checks.
- **Request, then response**: a step's detail shows what was sent before what came back.
- **Saved values are folded**: their names show (`Saved  token, userId`), their values on a click.
- **Each view shows its own results**: the result of a workflow stays with that workflow, the result of a request with that endpoint; switching to another one no longer shows the previous results, and coming back shows them again.

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
