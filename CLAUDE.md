# tinyprobe-app

The visual app of tinyprobe: a small launcher that serves a page on `127.0.0.1` and runs the `tinyprobe` binary. For people who use neither the terminal nor VS Code. GitHub: `kikutano/tinyprobe-app`.
The CLI lives in `../tinyprobe` (its `ROADMAP.md` is the plan for every repository; M5 is this app), the VS Code extension in `../tinyprobe-vscode`.

## Commands

```bash
scripts/dev.sh check   # build + unit tests + AOT + e2e + perf: run before every PR (mirrors CI)
scripts/dev.sh test    # dotnet test + node --test
scripts/dev.sh e2e     # AOT launcher on ../tinyprobe/docs against the test server (started if needed)
scripts/dev.sh run     # start the app from the sources, settings in .dev/data
dotnet test Tinyprobe.App.slnx --filter "FullyQualifiedName~ApiTests"   # one test class
```

`TINYPROBE_PATH` picks the tinyprobe binary (also a development build, `0.0.0-dev`); `TINYPROBE_APP_DATA` the settings folder.

## Architecture

```
browser ── web/ (HTML, JS, CSS; no framework, no build) ── HTTP on 127.0.0.1 ──► launcher/ (C#, Native AOT)
                                                                                      │ inspect --json, call/run --reporter ndjson
                                                                                      ▼
                                                                                  tinyprobe
```

- `launcher/Http.cs`: a minimal HTTP/1.1 server on sockets (one request per connection, close-delimited streams).
- `launcher/Api.cs`: the page's routes, the Host/Origin/cookie checks, streaming of tinyprobe's ndjson with a last `{"app":"exit"}` line.
- `launcher/Sessions.cs`: one-time links that become an HttpOnly, SameSite=Strict cookie. `Workspace.cs`: files only inside opened folders (links resolved). `TinyprobeCli.cs`: which tinyprobe, and its download (system `curl` and `tar`, SHA256SUMS checked). `Desktop.cs`: browser and icons. `Config.cs`: settings. `Program.cs`: options, second start hand-over (`instance.json`), signals.
- `web/app.js`: the page. `web/lib/core.js`: logic without a browser (ndjson lines, writing an endpoint as YAML text), tested by `test/*.test.js`. `web/shared/`: code shared with the VS Code extension (the run view, editing environment files, the request history); this repository has the canonical copy and its tests.

## Rules that are easy to break

- **A client of the CLI** ([tinyprobe decision 0004](../tinyprobe/docs/decisions/0004-the-app-is-a-client-of-the-cli.md)): run `tinyprobe`, read its JSON, never parse YAML to run it or evaluate a check. A need the CLI does not cover becomes a general feature of the CLI, with its spec, not a workaround here.
- **YAML is written as text**, keeping comments and order, and checked with `tinyprobe inspect` before it is kept (`/api/save` restores the file otherwise).
- **Light and fast.** `scripts/perf.sh` fails CI over 4 MiB for the launcher, 200 KiB for `web/`, 50 ms to start. No `HttpClient` (it tripled the size: downloads use the system's `curl`), no `Regex`, no reflection, JSON by hand with `Utf8JsonWriter`.
- **Security.** `127.0.0.1` only; every `/api/` route needs the session cookie; changes need the page's `Origin`; `Host` is checked on every request; paths go through `Workspace.Inside`. The page sets every value with `textContent` and the CSP allows only its own files.
- **Shared code.** `web/shared/` is copied by the extension (`../tinyprobe-vscode/scripts/dev.sh sync-shared`): no host API in it, and keep its CSS on the tokens listed at its top.
- All docs and comments in **English**; comments explain *why*.

## Git

- Branch per change (`feature/…`, `fix/…`), merged to `main` through a PR; `scripts/dev.sh check` green.
- Releases: annotated SemVer tag (`v0.1.0`); the Release workflow builds the six platforms and publishes the archives with `SHA256SUMS`.
