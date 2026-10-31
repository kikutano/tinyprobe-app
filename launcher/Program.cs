using System.Runtime.InteropServices;
using System.Text.Json;
using Tinyprobe.App;

const string Usage = """
    tinyprobe-app: call endpoints and run tinyprobe workflows from the browser.

    Usage:
      tinyprobe-app [folder] [--port <n>] [--no-open]

      folder        Open this folder in the page (its tinyprobe/ subfolder when it has one).
      --port <n>    The port on 127.0.0.1 (default: the last one used, first 4747).
      --no-open     Do not open the browser; print the link instead.
      --version     Show the version.
      -h, --help    Show this help.

    Close the window, or press Ctrl+C, to stop the app.
    """;

string? folder = null;
int? port = null;
var openBrowser = true;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "-h" or "--help":
            Console.WriteLine(Usage);
            return 0;
        case "--version":
            Console.WriteLine(Api.Version);
            return 0;
        case "--no-open":
            openBrowser = false;
            break;
        case "--port":
            if (i + 1 >= args.Length || !int.TryParse(args[++i], out var number) || number is < 1 or > 65535)
                return Fail("--port needs a number between 1 and 65535");
            port = number;
            break;
        case var option when option.StartsWith('-'):
            return Fail($"unknown option {option}");
        default:
            if (folder is not null) return Fail("only one folder can be given");
            folder = Path.GetFullPath(args[i]);
            if (!Directory.Exists(folder)) return Fail($"folder not found: {args[i]}");
            break;
    }
}

var paths = AppPaths.Default();
var config = Config.Load(paths);

// A second click on the icon: the running app opens a new tab instead of a second app starting.
if (await Instance.HandOver(paths, folder, openBrowser)) return 0;

var cli = new TinyprobeCli(paths);
await cli.Locate();
var sessions = new Sessions();
var secret = Sessions.Secret();
var api = new Api(config, sessions, cli, paths, secret);

// The port of the last start, so a page installed as an app finds the same address; the next one if it is taken.
HttpServer? server = null;
var wanted = port ?? config.Port;
for (var candidate = wanted; candidate < wanted + 20 && server is null; candidate++)
{
    server = HttpServer.Listen(candidate, api.Handle);
    if (server is null && port is not null) return Fail($"port {port} is in use; pick another with --port, or leave it out");
}
if (server is null) return Fail($"ports {wanted} to {wanted + 19} are all in use; pick a free one with --port");
api.Port = server.Port;
if (server.Port != wanted) Console.WriteLine($"  tinyprobe-app: port {wanted} is in use by another program; using {server.Port}");
if (port is null && server.Port != config.Port) config.SetPort(server.Port);
if (folder is not null) config.AddFolder(Workspace.OpenTarget(Workspace.RealPath(folder)));

Instance.Write(paths, server.Port, secret);
using var stop = new CancellationTokenSource();
var signals = new[] { PosixSignal.SIGINT, PosixSignal.SIGTERM, PosixSignal.SIGHUP, PosixSignal.SIGQUIT }
    .Select(signal => PosixSignalRegistration.Create(signal, context =>
    {
        context.Cancel = true;
        Instance.Remove(paths, secret);
        stop.Cancel();
    }))
    .ToList();

var link = Instance.Link(server.Port, sessions.NewTicket(), folder is null ? null : Workspace.OpenTarget(Workspace.RealPath(folder)));
Console.WriteLine();
Console.WriteLine($"  ⚡ tinyprobe-app {Api.Version}   ({(cli.Current is { } current ? $"tinyprobe {current.Version}" : $"tinyprobe {TinyprobeCli.Minimum} needed: the page installs it")})");
Console.WriteLine();
Console.WriteLine($"  open   : http://127.0.0.1:{server.Port}/");
if (config.Folders.Count > 0) Console.WriteLine($"  folder : {config.Folders[0]}");
if (cli.Problem is not null) Console.WriteLine($"\n  tinyprobe-app: {cli.Problem}");
Console.WriteLine();
Console.WriteLine("  tinyprobe-app is running. Close this window to stop it.");
Console.WriteLine();
if (!openBrowser || !Desktop.OpenBrowser(link))
    Console.WriteLine($"  Open this link in your browser (it works once): {link}");

await server.Serve(stop.Token);
Instance.Remove(paths, secret);
foreach (var signal in signals) signal.Dispose();
return 0;

static int Fail(string message)
{
    Console.Error.WriteLine($"tinyprobe-app: {message}");
    return 2;
}

/// <summary>The running app, recorded in instance.json (readable by this user only) so a second start finds it.</summary>
internal static class Instance
{
    public static string Link(int port, string ticket, string? folder) =>
        $"http://127.0.0.1:{port}/open?t={ticket}" + (folder is null ? "" : "&folder=" + Uri.EscapeDataString(folder));

    public static void Write(AppPaths paths, int port, string secret) =>
        AppPaths.WritePrivate(paths.Instance, Json.Write(w =>
        {
            w.WriteStartObject();
            w.WriteNumber("port", port);
            w.WriteString("secret", secret);
            w.WriteNumber("pid", Environment.ProcessId);
            w.WriteEndObject();
        }));

    /// <summary>Removes the record only if it is still ours: a newer app may have replaced it.</summary>
    public static void Remove(AppPaths paths, string secret)
    {
        try
        {
            if (Read(paths) is { Secret: var recorded } && recorded == secret) File.Delete(paths.Instance);
        }
        catch (IOException)
        {
        }
    }

    public static async Task<bool> HandOver(AppPaths paths, string? folder, bool openBrowser)
    {
        if (Read(paths) is not { } running) return false;
        try
        {
            var path = "/internal/ticket" + (folder is null ? "" : "?folder=" + Uri.EscapeDataString(folder));
            var ticket = await Get(running.Port, path, running.Secret);
            if (ticket is null) return false;
            var link = Link(running.Port, ticket, folder is null ? null : Workspace.OpenTarget(Workspace.RealPath(folder)));
            if (!openBrowser || !Desktop.OpenBrowser(link)) Console.WriteLine($"tinyprobe-app is already running: {link}");
            return true;
        }
        catch (Exception e) when (e is System.Net.Sockets.SocketException or IOException or OperationCanceledException)
        {
            // The record is left by an app that did not stop cleanly: this start takes over.
            return false;
        }
    }

    /// <summary>One GET to the running app, over a plain socket: the launcher has no HTTP client.</summary>
    private static async Task<string?> Get(int port, string path, string secret)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        using var client = new System.Net.Sockets.TcpClient();
        await client.ConnectAsync(System.Net.IPAddress.Loopback, port, timeout.Token);
        var stream = client.GetStream();
        var request = $"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{Api.InstanceHeader}: {secret}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(System.Text.Encoding.ASCII.GetBytes(request), timeout.Token);
        using var reader = new StreamReader(stream);
        var answer = await reader.ReadToEndAsync(timeout.Token);
        var split = answer.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        return answer.StartsWith("HTTP/1.1 200", StringComparison.Ordinal) && split > 0 ? answer[(split + 4)..].Trim() : null;
    }

    private static (int Port, string Secret)? Read(AppPaths paths)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(paths.Instance));
            var root = document.RootElement;
            return root.TryGetProperty("port", out var port) && port.TryGetInt32(out var number) && Json.String(root, "secret") is { } secret
                ? (number, secret)
                : null;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
