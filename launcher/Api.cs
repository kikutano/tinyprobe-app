using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json;

namespace Tinyprobe.App;

/// <summary>
/// The routes of the page. They are internal to tinyprobe-app (the page ships in the same executable), so they
/// can change in any version. The tinyprobe contracts go through unchanged: `inspect --json` documents and the
/// ndjson events of `run` and `call` reach the page as tinyprobe wrote them.
/// </summary>
internal sealed class Api
{
    public const string InstanceHeader = "X-Tinyprobe-App-Instance";

    private readonly Config _config;
    private readonly Sessions _sessions;
    private readonly TinyprobeCli _cli;
    private readonly AppPaths _paths;
    private readonly string _instanceSecret;
    private readonly Dictionary<string, string> _files;
    private readonly SemaphoreSlim _download = new(1, 1);

    public Api(Config config, Sessions sessions, TinyprobeCli cli, AppPaths paths, string instanceSecret)
    {
        _config = config;
        _sessions = sessions;
        _cli = cli;
        _paths = paths;
        _instanceSecret = instanceSecret;
        // Resource names use `\` when the project is built on Windows.
        _files = Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Where(n => n.StartsWith("web", StringComparison.Ordinal))
            .ToDictionary(n => n.Replace('\\', '/')[3..], n => n, StringComparer.Ordinal);
    }

    public int Port { get; set; }

    public static string Version => typeof(Api).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0] ?? "0.0.0";

    public async Task Handle(HttpRequest request, HttpResponse response, CancellationToken gone)
    {
        // DNS rebinding: a page on another name that resolves to 127.0.0.1 is refused.
        var host = request.Header("Host");
        if (host != $"127.0.0.1:{Port}" && host != $"localhost:{Port}")
        {
            await response.Text(403, "Open the app from http://127.0.0.1.");
            return;
        }

        if (request.Path == "/internal/ticket")
        {
            await Ticket(request, response);
            return;
        }

        if (!request.Path.StartsWith("/api/", StringComparison.Ordinal) && request.Path != "/open")
        {
            await Static(request, response);
            return;
        }

        if (request.Path == "/open")
        {
            await Open(request, response);
            return;
        }

        if (!_sessions.IsValid(request.Cookie(Sessions.Cookie)))
        {
            await response.Json(401, Json.Error("The app was restarted: open it again from its icon."));
            return;
        }
        // A form on another site can send a POST with the cookie of a link it opens: such requests carry its Origin.
        if (request.Method != "GET" && request.Header("Origin") is var origin && origin != $"http://127.0.0.1:{Port}" && origin != $"http://localhost:{Port}")
        {
            await response.Json(403, Json.Error("Requests that change something must come from the app's page."));
            return;
        }

        switch (request.Method, request.Path)
        {
            case ("GET", "/api/state"): await response.Json(200, State()); break;
            case ("POST", "/api/tinyprobe/download"): await DownloadTinyprobe(response, gone); break;
            case ("POST", "/api/tinyprobe/update"): await UpdateTinyprobe(response, gone); break;
            case ("GET", "/api/browse"): await Browse(request, response); break;
            case ("POST", "/api/folders/open"): await OpenFolder(request, response); break;
            case ("POST", "/api/folders/remove"): await RemoveFolder(request, response); break;
            case ("GET", "/api/folder"): await Folder(request, response, gone); break;
            case ("GET", "/api/file"): await ReadFile(request, response); break;
            case ("POST", "/api/save"): await Save(request, response, gone); break;
            case ("POST", "/api/environment"): await WriteEnvironment(request, response, gone); break;
            case ("GET", "/api/history"): await ReadHistory(request, response); break;
            case ("POST", "/api/history"): await WriteHistory(request, response); break;
            case ("POST", "/api/call"): await Call(request, response, gone); break;
            case ("POST", "/api/run"): await Run(request, response, gone); break;
            case ("POST", "/api/icon"): await Icon(request, response); break;
            default: await response.Json(404, Json.Error($"No route {request.Method} {request.Path}.")); break;
        }
    }

    // --- Page and session ------------------------------------------------------------------------------------

    private async Task Static(HttpRequest request, HttpResponse response)
    {
        if (request.Method != "GET")
        {
            await response.Text(405, "Method not allowed");
            return;
        }
        var path = request.Path == "/" ? "/index.html" : request.Path;
        if (!_files.TryGetValue(path, out var resource))
        {
            await response.Text(404, "Not found");
            return;
        }
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource)!;
        var bytes = new byte[stream.Length];
        stream.ReadExactly(bytes);
        // The page loads only its own files: no inline script, no CDN, no frame.
        response.Headers.Add(("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"));
        await response.Send(200, ContentType(path), bytes);
    }

    private static string ContentType(string path) => Path.GetExtension(path) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".webmanifest" => "application/manifest+json",
        _ => "application/octet-stream"
    };

    /// <summary>The one-time link the launcher opens: it becomes the session cookie, then the page.</summary>
    private async Task Open(HttpRequest request, HttpResponse response)
    {
        var session = _sessions.Redeem(request.Query.GetValueOrDefault("t"));
        var folder = request.Query.GetValueOrDefault("folder");
        var location = string.IsNullOrEmpty(folder) ? "/" : "/#folder=" + Uri.EscapeDataString(folder);
        if (session is not null) response.Headers.Add(("Set-Cookie", $"{Sessions.Cookie}={session}; Path=/; HttpOnly; SameSite=Strict"));
        response.Headers.Add(("Location", location));
        await response.Send(302, "text/plain; charset=utf-8", Array.Empty<byte>());
    }

    /// <summary>A second start of the app asks the running one for a link to open, with the secret of instance.json.</summary>
    private async Task Ticket(HttpRequest request, HttpResponse response)
    {
        if (request.Header(InstanceHeader) != _instanceSecret)
        {
            await response.Text(403, "Forbidden");
            return;
        }
        if (request.Query.GetValueOrDefault("folder") is { Length: > 0 } folder && Directory.Exists(folder))
            _config.AddFolder(Workspace.OpenTarget(Workspace.RealPath(folder)));
        await response.Text(200, _sessions.NewTicket());
    }

    // --- State and tinyprobe -----------------------------------------------------------------------------------

    private byte[] State() => Json.Write(w =>
    {
        w.WriteStartObject();
        w.WriteString("app", Version);
        w.WriteString("minimum", TinyprobeCli.Minimum);
        w.WriteString("platform", OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : "linux");
        w.WriteString("separator", Path.DirectorySeparatorChar.ToString());
        w.WriteString("home", Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        if (_cli.Current is { } cli)
        {
            w.WriteStartObject("tinyprobe");
            w.WriteString("path", cli.Path);
            w.WriteString("version", cli.Version);
            w.WriteString("source", cli.Source);
            w.WriteEndObject();
        }
        else
        {
            w.WriteNull("tinyprobe");
        }
        w.WriteString("problem", _cli.Problem);
        w.WriteString("icon", Desktop.CanAddIcon ? _config.Shortcut : "unsupported");
        w.WriteStartArray("folders");
        foreach (var folder in _config.Folders)
        {
            w.WriteStartObject();
            w.WriteString("path", folder);
            w.WriteBoolean("exists", Directory.Exists(folder));
            w.WriteEndObject();
        }
        w.WriteEndArray();
        w.WriteEndObject();
    });

    private async Task DownloadTinyprobe(HttpResponse response, CancellationToken gone)
    {
        await _download.WaitAsync(gone);
        try
        {
            var error = _cli.Current is null ? await _cli.Download(gone) : null;
            if (error is not null) Console.WriteLine($"  tinyprobe-app: {error}");
            await response.Json(error is null ? 200 : 502, error is null ? State() : Json.Error(error));
        }
        finally
        {
            _download.Release();
        }
    }

    private async Task UpdateTinyprobe(HttpResponse response, CancellationToken gone)
    {
        var (code, output) = await _cli.UpdateOwnCopy(gone);
        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteNumber("code", code);
            w.WriteString("output", output);
            w.WriteEndObject();
        }));
    }

    // --- Folders -----------------------------------------------------------------------------------------------

    /// <summary>The names of the folders inside one: the page's folder picker. A browser cannot give a path to a program.</summary>
    private static async Task Browse(HttpRequest request, HttpResponse response)
    {
        var path = request.Query.GetValueOrDefault("path");
        if (string.IsNullOrEmpty(path))
        {
            if (OperatingSystem.IsWindows())
            {
                await response.Json(200, Json.Write(w =>
                {
                    w.WriteStartObject();
                    w.WriteString("path", "");
                    w.WriteNull("parent");
                    w.WriteStartArray("folders");
                    foreach (var drive in DriveInfo.GetDrives().Where(d => d.IsReady))
                    {
                        w.WriteStartObject();
                        w.WriteString("name", drive.Name);
                        w.WriteString("path", drive.RootDirectory.FullName);
                        w.WriteBoolean("tinyprobe", false);
                        w.WriteEndObject();
                    }
                    w.WriteEndArray();
                    w.WriteEndObject();
                }));
                return;
            }
            path = "/";
        }

        string full;
        List<string> folders;
        try
        {
            full = Path.GetFullPath(path);
            folders = Directory.EnumerateDirectories(full)
                .Where(d => !Path.GetFileName(d).StartsWith('.') && !new DirectoryInfo(d).Attributes.HasFlag(FileAttributes.Hidden))
                .Order(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or ArgumentException)
        {
            await response.Json(404, Json.Error($"The folder {path} cannot be opened."));
            return;
        }

        var parent = Path.GetDirectoryName(full);
        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("path", full);
            if (parent is null && OperatingSystem.IsWindows()) w.WriteString("parent", "");
            else w.WriteString("parent", parent);
            w.WriteStartArray("folders");
            foreach (var folder in folders)
            {
                w.WriteStartObject();
                w.WriteString("name", Path.GetFileName(folder));
                w.WriteString("path", folder);
                w.WriteBoolean("tinyprobe", Directory.Exists(Path.Combine(folder, "tinyprobe")));
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteEndObject();
        }));
    }

    private async Task OpenFolder(HttpRequest request, HttpResponse response)
    {
        using var body = Parse(request);
        var path = body is null ? null : Json.String(body.RootElement, "path");
        if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || !Directory.Exists(path))
        {
            await response.Json(404, Json.Error($"The folder {path} does not exist."));
            return;
        }
        var folder = Workspace.OpenTarget(Workspace.RealPath(path));
        _config.AddFolder(folder);
        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("root", folder);
            w.WriteEndObject();
        }));
    }

    private async Task RemoveFolder(HttpRequest request, HttpResponse response)
    {
        using var body = Parse(request);
        if (body is not null && Json.String(body.RootElement, "root") is { } root) _config.RemoveFolder(root);
        await response.Json(200, State());
    }

    /// <summary>The folder's tinyprobe files with their `inspect --json`, and its environment files.</summary>
    private async Task Folder(HttpRequest request, HttpResponse response, CancellationToken gone)
    {
        if (await RootOf(request.Query.GetValueOrDefault("root"), response) is not { } root) return;
        if (await Cli(response) is not { } cli) return;

        var (files, truncated) = Workspace.YamlFiles(root);
        var environments = files.Where(Workspace.IsEnvironmentFile).ToList();
        var tinyprobeFiles = new List<string>();
        foreach (var file in files.Except(environments))
        {
            try
            {
                if (Workspace.IsTinyprobeFile(await File.ReadAllTextAsync(Path.Combine(root, file), gone))) tinyprobeFiles.Add(file);
            }
            catch (IOException)
            {
            }
        }

        var inspections = new string[tinyprobeFiles.Count];
        await Parallel.ForEachAsync(Enumerable.Range(0, tinyprobeFiles.Count), new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = gone }, async (i, cancel) =>
        {
            var (_, output, _) = await TinyprobeCli.Run(cli.Path, ["inspect", tinyprobeFiles[i], "--json"], root, cancel);
            inspections[i] = output;
        });

        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("root", root);
            w.WriteBoolean("truncated", truncated);
            w.WriteStartArray("files");
            for (var i = 0; i < tinyprobeFiles.Count; i++)
            {
                w.WriteStartObject();
                w.WriteString("path", tinyprobeFiles[i]);
                Json.WriteRaw(w, "inspect", inspections[i]);
                w.WriteEndObject();
            }
            w.WriteEndArray();
            w.WriteStartArray("environments");
            foreach (var environment in environments) w.WriteStringValue(environment);
            w.WriteEndArray();
            w.WriteEndObject();
        }));
    }

    private async Task ReadFile(HttpRequest request, HttpResponse response)
    {
        if (await RootOf(request.Query.GetValueOrDefault("root"), response) is not { } root) return;
        if (await FileOf(root, request.Query.GetValueOrDefault("path"), response) is not { } file) return;
        if (!File.Exists(file))
        {
            await response.Json(404, Json.Error("The file does not exist."));
            return;
        }
        await response.Send(200, "text/plain; charset=utf-8", await File.ReadAllBytesAsync(file));
    }

    /// <summary>
    /// Writes a file the page edited, then checks it with `tinyprobe inspect`. A form never leaves a broken file:
    /// when the result is not valid, the previous text comes back (or the new file goes away).
    /// </summary>
    private async Task Save(HttpRequest request, HttpResponse response, CancellationToken gone)
    {
        using var body = Parse(request);
        if (body is null)
        {
            await response.Json(400, Json.Error("The request is not JSON."));
            return;
        }
        var json = body.RootElement;
        if (await RootOf(Json.String(json, "root"), response) is not { } root) return;
        var relative = Json.String(json, "path");
        if (relative is null || !(relative.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase) || relative.EndsWith(".yml", StringComparison.OrdinalIgnoreCase)))
        {
            await response.Json(400, Json.Error("Only YAML files are written."));
            return;
        }
        if (await FileOf(root, relative, response) is not { } file) return;
        if (await Cli(response) is not { } cli) return;

        var text = Json.String(json, "text") ?? "";
        // The text the page started from: if the file changed since, the page reads it again instead of overwriting.
        var basis = json.TryGetProperty("basis", out var b) && b.ValueKind == JsonValueKind.String ? b.GetString() : null;
        var existed = File.Exists(file);
        var previous = existed ? await File.ReadAllTextAsync(file, gone) : null;
        if (previous != basis)
        {
            await response.Json(409, Json.Error(existed ? "The file changed on disk since it was read." : "The file no longer exists."));
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await File.WriteAllTextAsync(file, text, new UTF8Encoding(false), gone);
        var (code, output, _) = await TinyprobeCli.Run(cli.Path, ["inspect", relative, "--json"], root, CancellationToken.None);
        var saved = code == 0;
        if (!saved)
        {
            if (previous is not null) await File.WriteAllTextAsync(file, previous, new UTF8Encoding(false), CancellationToken.None);
            else File.Delete(file);
        }
        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteBoolean("saved", saved);
            Json.WriteRaw(w, "inspect", output);
            w.WriteEndObject();
        }));
    }

    /// <summary>
    /// Writes an environment file the page edited. Environment files are not tinyprobe files, so there is no
    /// `inspect` here: the page edits only the lines of one variable, and only files named like environments.
    /// </summary>
    private async Task WriteEnvironment(HttpRequest request, HttpResponse response, CancellationToken gone)
    {
        using var body = Parse(request);
        if (body is null)
        {
            await response.Json(400, Json.Error("The request is not JSON."));
            return;
        }
        var json = body.RootElement;
        if (await RootOf(Json.String(json, "root"), response) is not { } root) return;
        var relative = Json.String(json, "path");
        if (relative is null || !Workspace.IsEnvironmentFile(relative))
        {
            await response.Json(400, Json.Error("Only environment files (env.yaml, env.local.yaml...) are written here."));
            return;
        }
        if (await FileOf(root, relative, response) is not { } file) return;
        var basis = Json.String(json, "basis");
        var previous = File.Exists(file) ? await File.ReadAllTextAsync(file, gone) : null;
        if (previous is null || previous != basis)
        {
            await response.Json(409, Json.Error("The file changed on disk since it was read."));
            return;
        }
        await File.WriteAllTextAsync(file, Json.String(json, "text") ?? "", new UTF8Encoding(false), gone);
        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteBoolean("saved", true);
            w.WriteEndObject();
        }));
    }

    // --- History -----------------------------------------------------------------------------------------------

    private const int MaxHistory = 8 * 1024 * 1024;

    /// <summary>
    /// One history file per folder, in the app's data folder (readable by this user only): requests and responses
    /// carry credentials, so they stay out of the user's project, as in the extension.
    /// </summary>
    private string HistoryFile(string root) =>
        Path.Combine(_paths.Data, "history", Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(root)))[..16] + ".json");

    private async Task ReadHistory(HttpRequest request, HttpResponse response)
    {
        if (await RootOf(request.Query.GetValueOrDefault("root"), response) is not { } root) return;
        var file = HistoryFile(root);
        await response.Json(200, File.Exists(file) ? await File.ReadAllBytesAsync(file) : "[]"u8.ToArray());
    }

    /// <summary>The page keeps the list (newest first, at most 50, bodies cut): the launcher only stores it.</summary>
    private async Task WriteHistory(HttpRequest request, HttpResponse response)
    {
        using var body = Parse(request);
        if (body is null || await RootOf(Json.String(body.RootElement, "root"), response) is not { } root) return;
        if (!body.RootElement.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array)
        {
            await response.Json(400, Json.Error("The history is a list of entries."));
            return;
        }
        var json = Json.Write(w => entries.WriteTo(w));
        if (json.Length > MaxHistory)
        {
            await response.Json(413, Json.Error("The history is too large."));
            return;
        }
        AppPaths.WritePrivate(HistoryFile(root), json);
        await response.Json(200, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteNumber("entries", entries.GetArrayLength());
            w.WriteEndObject();
        }));
    }

    // --- Calls and runs ----------------------------------------------------------------------------------------

    private async Task Call(HttpRequest request, HttpResponse response, CancellationToken gone)
    {
        using var body = Parse(request);
        if (body is null || await RootOf(Json.String(body.RootElement, "root"), response) is not { } root) return;
        var json = body.RootElement;
        var file = Json.String(json, "file");
        var endpoint = Json.String(json, "endpoint");
        if (string.IsNullOrEmpty(endpoint) || await FileOf(root, file, response) is null)
        {
            if (!response.Started) await response.Json(400, Json.Error("A call needs a file and an endpoint."));
            return;
        }

        var arguments = new List<string> { "call", file!, endpoint };
        if (json.TryGetProperty("with", out var with) && with.ValueKind == JsonValueKind.Array)
            foreach (var pair in with.EnumerateArray())
                if (Json.String(pair, "name") is { Length: > 0 } name)
                {
                    arguments.Add("--with");
                    arguments.Add($"{name}={Json.String(pair, "value") ?? ""}");
                }
        if (await EnvironmentArguments(json, root, response) is not { } environment) return;
        arguments.AddRange(environment);
        arguments.AddRange(["--reporter", "ndjson"]);
        await Stream(root, arguments, response, gone);
    }

    private async Task Run(HttpRequest request, HttpResponse response, CancellationToken gone)
    {
        using var body = Parse(request);
        if (body is null || await RootOf(Json.String(body.RootElement, "root"), response) is not { } root) return;
        var json = body.RootElement;

        var arguments = new List<string> { "run" };
        if (json.TryGetProperty("files", out var files) && files.ValueKind == JsonValueKind.Array && files.GetArrayLength() > 0)
        {
            foreach (var item in files.EnumerateArray())
            {
                var file = item.GetString();
                if (await FileOf(root, file, response) is null) return;
                arguments.Add(file!);
            }
        }
        else
        {
            arguments.Add(".");
        }
        if (json.TryGetProperty("to", out var to) && to.ValueKind == JsonValueKind.Number)
            arguments.AddRange(["--to", to.GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture)]);
        if (await EnvironmentArguments(json, root, response) is not { } environment) return;
        arguments.AddRange(environment);
        arguments.AddRange(["--reporter", "ndjson"]);
        await Stream(root, arguments, response, gone);
    }

    private async Task<string[]?> EnvironmentArguments(JsonElement json, string root, HttpResponse response)
    {
        var environment = Json.String(json, "env");
        if (string.IsNullOrEmpty(environment)) return [];
        if (await FileOf(root, environment, response) is null) return null;
        return ["-e", environment];
    }

    /// <summary>
    /// Runs tinyprobe and sends its ndjson events as they come, then one line of the app's own, `{"app":"exit"}`,
    /// with the exit code and what tinyprobe wrote on standard error. Closing the page stops the process.
    /// </summary>
    private async Task Stream(string root, List<string> arguments, HttpResponse response, CancellationToken gone)
    {
        if (await Cli(response) is not { } cli) return;
        using var process = Process.Start(TinyprobeCli.StartInfo(cli.Path, arguments, root))!;
        var error = process.StandardError.ReadToEndAsync(CancellationToken.None);
        var output = await response.Stream(200, "application/x-ndjson; charset=utf-8");
        try
        {
            await process.StandardOutput.BaseStream.CopyToAsync(output, gone);
            await process.WaitForExitAsync(gone);
        }
        catch (Exception e) when (e is OperationCanceledException or IOException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            return;
        }
        var end = Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteString("app", "exit");
            w.WriteNumber("code", process.ExitCode);
            w.WriteString("stderr", error.Result);
            w.WriteEndObject();
        });
        await output.WriteAsync(end.Concat("\n"u8.ToArray()).ToArray(), CancellationToken.None);
    }

    // --- Icon --------------------------------------------------------------------------------------------------

    private async Task Icon(HttpRequest request, HttpResponse response)
    {
        using var body = Parse(request);
        var action = body is null ? null : Json.String(body.RootElement, "action");
        if (action == "decline")
        {
            _config.SetShortcut("declined");
            await response.Json(200, State());
            return;
        }
        var error = Desktop.AddIcon(_paths);
        if (error is null) _config.SetShortcut("created");
        await response.Json(error is null ? 200 : 500, error is null ? State() : Json.Error(error));
    }

    // --- Checks ------------------------------------------------------------------------------------------------

    private static JsonDocument? Parse(HttpRequest request)
    {
        try
        {
            return JsonDocument.Parse(request.Body);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Only the folders the user opened: the page cannot name any other.</summary>
    private async Task<string?> RootOf(string? root, HttpResponse response)
    {
        if (!string.IsNullOrEmpty(root) && _config.IsFolder(root) && Directory.Exists(root)) return root;
        await response.Json(403, Json.Error("This folder is not open in the app."));
        return null;
    }

    private static async Task<string?> FileOf(string root, string? relative, HttpResponse response)
    {
        if (relative is not null && Workspace.Inside(root, relative) is { } file) return file;
        await response.Json(403, Json.Error($"{relative} is not inside the folder."));
        return null;
    }

    private async Task<CliInfo?> Cli(HttpResponse response)
    {
        if (_cli.Current is { } cli) return cli;
        await response.Json(409, Json.Error($"tinyprobe {TinyprobeCli.Minimum} or newer is needed."));
        return null;
    }
}
