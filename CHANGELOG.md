# Changelog

## 0.1.0

The first version (tinyprobe spec 0017, roadmap M5-1).

- A launcher for Windows, macOS and Linux that serves the app on `127.0.0.1` and opens it in the browser; closing its window stops it, and a second start opens the running one.
- Open a folder (a folder browser and the recent folders; a project opens on its `tinyprobe/` folder), with its API files, workflows, sequences, environments and the problems of invalid files.
- Send an endpoint from a form, run a workflow, run it up to a step, run every workflow of the folder, with live results shown by the run view of the VS Code extension.
- **+ New request** writes an endpoint into an API file, or a new one, and keeps it only if `tinyprobe inspect` accepts the file.
- Uses the `tinyprobe` on the PATH (0.20.0 or newer), or downloads its own copy, checked against the release's checksums.
- Offers an icon in the Start menu and on the desktop, in Applications or in the applications menu.
