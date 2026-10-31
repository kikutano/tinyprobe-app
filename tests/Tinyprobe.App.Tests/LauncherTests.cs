using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace Tinyprobe.App.Tests;

public sealed class HttpTests
{
    private static Task<HttpRequest?> Read(string raw) => HttpServer.Read(new MemoryStream(Encoding.UTF8.GetBytes(raw)));

    [Fact]
    public async Task ARequest_IsReadWithItsPathQueryHeadersAndBody()
    {
        var request = await Read("POST /api/run%20x?root=%2Fhome%2Fme&to=3&q=a+b HTTP/1.1\r\nHost: 127.0.0.1:4747\r\ncontent-length: 7\r\nCookie: a=1; tinyprobe_app=abc\r\n\r\n{\"x\":1}");

        Assert.NotNull(request);
        Assert.Equal("POST", request.Method);
        Assert.Equal("/api/run x", request.Path);
        Assert.Equal("/home/me", request.Query["root"]);
        Assert.Equal("3", request.Query["to"]);
        Assert.Equal("a b", request.Query["q"]);
        Assert.Equal("127.0.0.1:4747", request.Header("HOST"));
        Assert.Equal("abc", request.Cookie("tinyprobe_app"));
        Assert.Equal("{\"x\":1}", Encoding.UTF8.GetString(request.Body));
    }

    [Theory]
    [InlineData("GET /\r\n\r\n")]                                             // no HTTP version
    [InlineData("GET / HTTP/1.1\r\nno colon here\r\n\r\n")]
    [InlineData("POST / HTTP/1.1\r\nContent-Length: -1\r\n\r\n")]
    [InlineData("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")]      // the page never sends chunks
    [InlineData("POST / HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n")]        // over 16 MiB
    [InlineData("POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nshort")]        // the connection ends first
    public async Task MalformedRequests_AreRefused(string raw) => Assert.Null(await Read(raw));
}

public sealed class SessionTests
{
    [Fact]
    public void ATicket_WorksOnce_AndGivesASession()
    {
        var sessions = new Sessions();
        var ticket = sessions.NewTicket();

        var session = sessions.Redeem(ticket);

        Assert.NotNull(session);
        Assert.True(sessions.IsValid(session));
        Assert.Null(sessions.Redeem(ticket));
        Assert.False(sessions.IsValid("guess"));
        Assert.False(sessions.IsValid(null));
        Assert.Equal(32, session.Length);
    }
}

public sealed class WorkspaceTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("tinyprobe-app-").FullName;

    public void Dispose() => Directory.Delete(_root, recursive: true);

    [Fact]
    public void FilesInsideTheFolder_AreAllowed_AndNothingOutsideIt()
    {
        var folder = Workspace.RealPath(Path.Combine(_root, "tests"));
        Directory.CreateDirectory(Path.Combine(folder, "api"));
        File.WriteAllText(Path.Combine(_root, "secret.txt"), "x");

        Assert.Equal(Path.Combine(folder, "api", "shop.yaml"), Workspace.Inside(folder, "api/shop.yaml"));
        Assert.Null(Workspace.Inside(folder, "../secret.txt"));
        Assert.Null(Workspace.Inside(folder, "api/../../secret.txt"));
        Assert.Null(Workspace.Inside(folder, Path.Combine(_root, "secret.txt")));
        Assert.Null(Workspace.Inside(folder, "."));
        Assert.Null(Workspace.Inside(folder, ""));
    }

    [Fact]
    public void ALinkThatLeadsOutside_IsRefused()
    {
        if (OperatingSystem.IsWindows()) return;   // symbolic links need extra rights on Windows
        var folder = Workspace.RealPath(Path.Combine(_root, "tests"));
        Directory.CreateDirectory(folder);
        Directory.CreateDirectory(Path.Combine(_root, "outside"));
        File.WriteAllText(Path.Combine(_root, "outside", "secret.yaml"), "x");
        Directory.CreateSymbolicLink(Path.Combine(folder, "link"), Path.Combine(_root, "outside"));

        Assert.Null(Workspace.Inside(folder, "link/secret.yaml"));
    }

    [Fact]
    public void AProject_OpensOnItsTinyprobeFolder()
    {
        Assert.Equal(_root, Workspace.OpenTarget(_root));
        Directory.CreateDirectory(Path.Combine(_root, "tinyprobe"));
        Assert.Equal(Workspace.RealPath(Path.Combine(_root, "tinyprobe")), Workspace.OpenTarget(_root));
    }

    [Fact]
    public void TheListing_HasTheYamlFiles_InOrdinalOrder_WithoutSkippedFolders()
    {
        foreach (var file in new[] { "workflows/users.yaml", "api/shop.yml", "env.local.yaml", "node_modules/x.yaml", ".git/y.yaml", "bin/z.yaml", "readme.md" })
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.Combine(_root, file))!);
            File.WriteAllText(Path.Combine(_root, file), "");
        }

        var (files, truncated) = Workspace.YamlFiles(_root);

        Assert.Equal(["api/shop.yml", "env.local.yaml", "workflows/users.yaml"], files);
        Assert.False(truncated);
    }

    [Theory]
    [InlineData("base_url: x\nendpoints:\n  a: { path: /a }\n", true)]
    [InlineData("name: Users\nsteps:\n  - call: a\n", true)]
    [InlineData("sequence:\n  - call: a\n", true)]
    [InlineData("steps :\n", true)]
    [InlineData("services:\n  steps:\n", false)]       // nested, not top level
    [InlineData("openapi: 3.0.0\npaths: {}\n", false)]
    [InlineData("stepsx: 1\n", false)]
    public void TinyprobeFiles_AreRecognisedAsInTheExtension(string text, bool expected) =>
        Assert.Equal(expected, Workspace.IsTinyprobeFile(text));

    [Theory]
    [InlineData("env.yaml", true)]
    [InlineData("tinyprobe/env.local.yaml", true)]
    [InlineData("env-dev.yml", true)]
    [InlineData("environment.yaml", true)]
    [InlineData("Env.CI.yaml", true)]
    [InlineData("envoy.yaml", false)]
    [InlineData("env..yaml", true)]
    [InlineData("env.yaml.bak", false)]
    [InlineData("my-env.yaml", false)]
    public void EnvironmentFiles_AreRecognisedByName(string path, bool expected) =>
        Assert.Equal(expected, Workspace.IsEnvironmentFile(path));
}

public sealed class TinyprobeCliTests
{
    [Theory]
    [InlineData("0.20.0", true)]
    [InlineData("0.20.1", true)]
    [InlineData("0.21.0", true)]
    [InlineData("1.0.0", true)]
    [InlineData("0.19.9", false)]
    [InlineData("0.0.0-dev", false)]
    [InlineData("0.20.0-beta.1", true)]
    [InlineData("0.20", true)]
    public void Versions_AreComparedAsNumbers(string version, bool expected) =>
        Assert.Equal(expected, TinyprobeCli.AtLeast(version, "0.20.0"));
}

/// <summary>The launcher's guards, against a real server on a free port.</summary>
public sealed class ApiTests : IDisposable
{
    private readonly string _data = Directory.CreateTempSubdirectory("tinyprobe-app-data-").FullName;
    private readonly string _folder = Directory.CreateTempSubdirectory("tinyprobe-app-folder-").FullName;
    private readonly CancellationTokenSource _stop = new();
    private readonly Sessions _sessions = new();
    private readonly int _port;

    public ApiTests()
    {
        var paths = new AppPaths(_data);
        var config = Config.Load(paths);
        config.AddFolder(Workspace.RealPath(_folder));
        File.WriteAllText(Path.Combine(_folder, "env.yaml"), "baseUrl: http://localhost/\n");
        var api = new Api(config, _sessions, new TinyprobeCli(paths), paths, "instance-secret");
        var server = HttpServer.Listen(0, api.Handle)!;
        _port = api.Port = server.Port;
        _ = server.Serve(_stop.Token);
    }

    public void Dispose()
    {
        _stop.Cancel();
        Directory.Delete(_data, recursive: true);
        Directory.Delete(_folder, recursive: true);
    }

    private string Root => Uri.EscapeDataString(Workspace.RealPath(_folder));

    private async Task<(int Status, Dictionary<string, string> Headers, string Body)> Send(string method, string target, string? body = null, params string[] headers)
    {
        using var client = new TcpClient();
        await client.ConnectAsync("127.0.0.1", _port);
        var stream = client.GetStream();
        var bytes = Encoding.UTF8.GetBytes(body ?? "");
        var head = new StringBuilder($"{method} {target} HTTP/1.1\r\n");
        if (!headers.Any(h => h.StartsWith("Host:", StringComparison.Ordinal))) head.Append($"Host: 127.0.0.1:{_port}\r\n");
        foreach (var header in headers) head.Append(header).Append("\r\n");
        head.Append($"Content-Length: {bytes.Length}\r\n\r\n");
        await stream.WriteAsync(Encoding.UTF8.GetBytes(head.ToString()));
        await stream.WriteAsync(bytes);
        var answer = await new StreamReader(stream).ReadToEndAsync();
        var split = answer.IndexOf("\r\n\r\n", StringComparison.Ordinal);
        var lines = answer[..split].Split("\r\n");
        var parsed = lines.Skip(1).Select(l => l.Split(": ", 2)).GroupBy(p => p[0], StringComparer.OrdinalIgnoreCase).ToDictionary(g => g.Key, g => g.Last()[1], StringComparer.OrdinalIgnoreCase);
        return (int.Parse(lines[0].Split(' ')[1]), parsed, answer[(split + 4)..]);
    }

    private async Task<string> Session()
    {
        var (status, headers, _) = await Send("GET", $"/open?t={_sessions.NewTicket()}");
        Assert.Equal(302, status);
        return "Cookie: " + headers["Set-Cookie"].Split(';')[0];
    }

    private string Origin => $"Origin: http://127.0.0.1:{_port}";

    [Fact]
    public async Task ThePage_IsServed_WithItsSecurityHeaders()
    {
        var (status, headers, body) = await Send("GET", "/");

        Assert.Equal(200, status);
        Assert.Contains("<title>tinyprobe</title>", body);
        Assert.StartsWith("default-src 'self'", headers["Content-Security-Policy"]);
        Assert.Equal("nosniff", headers["X-Content-Type-Options"]);
        Assert.Equal(404, (await Send("GET", "/nothing.js")).Status);
    }

    [Fact]
    public async Task TheOpenLink_SetsAStrictHttpOnlyCookie_AndWorksOnce()
    {
        var ticket = _sessions.NewTicket();

        var (status, headers, _) = await Send("GET", $"/open?t={ticket}&folder=%2Fhome");

        Assert.Equal(302, status);
        Assert.Equal("/#folder=%2Fhome", headers["Location"]);
        Assert.Matches("^tinyprobe_app=[0-9a-f]{32}; Path=/; HttpOnly; SameSite=Strict$", headers["Set-Cookie"]);
        Assert.False((await Send("GET", $"/open?t={ticket}")).Headers.ContainsKey("Set-Cookie"));
    }

    [Fact]
    public async Task WithoutTheCookie_TheApiAnswers401()
    {
        Assert.Equal(401, (await Send("GET", "/api/state")).Status);
        Assert.Equal(401, (await Send("GET", "/api/state", null, "Cookie: tinyprobe_app=guessed")).Status);
        Assert.Equal(200, (await Send("GET", "/api/state", null, await Session())).Status);
    }

    [Theory]
    [InlineData("Host: evil.example:{port}")]
    [InlineData("Host: 127.0.0.1")]
    [InlineData("Host: 127.0.0.1:1")]
    public async Task AnotherHost_IsRefused_ForThePageToo(string host)
    {
        var header = host.Replace("{port}", _port.ToString());
        Assert.Equal(403, (await Send("GET", "/", null, header)).Status);
        Assert.Equal(403, (await Send("GET", "/api/state", null, header, await Session())).Status);
    }

    [Fact]
    public async Task ChangesFromAnotherOrigin_OrWithoutOne_AreRefused()
    {
        var cookie = await Session();
        var body = $$"""{"root":"{{Workspace.RealPath(_folder).Replace("\\", "\\\\")}}"}""";

        Assert.Equal(403, (await Send("POST", "/api/run", body, cookie)).Status);
        Assert.Equal(403, (await Send("POST", "/api/run", body, cookie, "Origin: https://evil.example")).Status);
        Assert.Equal(403, (await Send("POST", "/api/folders/remove", body, cookie, "Origin: null")).Status);
    }

    [Fact]
    public async Task Files_AreReadOnlyInsideOpenedFolders()
    {
        var cookie = await Session();

        var inside = await Send("GET", $"/api/file?root={Root}&path=env.yaml", null, cookie);
        var outside = await Send("GET", $"/api/file?root={Root}&path=..%2F..%2Fetc%2Fpasswd", null, cookie);
        var notOpened = await Send("GET", $"/api/file?root={Uri.EscapeDataString(Path.GetTempPath())}&path=x.yaml", null, cookie);

        Assert.Equal((200, "baseUrl: http://localhost/\n"), (inside.Status, inside.Body));
        Assert.Equal(403, outside.Status);
        Assert.Equal(403, notOpened.Status);
        Assert.Equal("This folder is not open in the app.", JsonDocument.Parse(notOpened.Body).RootElement.GetProperty("error").GetString());
    }

    private string RootJson => Workspace.RealPath(_folder).Replace("\\", "\\\\");

    [Fact]
    public async Task AnEnvironment_IsWrittenOnlyFromWhatThePageRead()
    {
        var cookie = await Session();
        var write = (string path, string text, string basis) => Send("POST", "/api/environment",
            $$"""{"root":"{{RootJson}}","path":"{{path}}","text":{{JsonSerializer.Serialize(text)}},"basis":{{JsonSerializer.Serialize(basis)}}}""", cookie, Origin);

        var saved = await write("env.yaml", "baseUrl: http://localhost:8080/\n", "baseUrl: http://localhost/\n");
        var stale = await write("env.yaml", "x: 1\n", "baseUrl: http://localhost/\n");
        var notEnvironment = await write("api.yaml", "x: 1\n", "");

        Assert.Equal(200, saved.Status);
        Assert.Equal("baseUrl: http://localhost:8080/\n", File.ReadAllText(Path.Combine(_folder, "env.yaml")));
        Assert.Equal(409, stale.Status);
        Assert.Equal(400, notEnvironment.Status);
        Assert.False(File.Exists(Path.Combine(_folder, "api.yaml")));
    }

    [Fact]
    public async Task TheHistory_IsKeptPerFolder_InTheAppsDataFolder()
    {
        var cookie = await Session();

        Assert.Equal("[]", (await Send("GET", $"/api/history?root={Root}", null, cookie)).Body);
        var write = await Send("POST", "/api/history", $$"""{"root":"{{RootJson}}","entries":[{"endpoint":"get_user","status":200}]}""", cookie, Origin);
        var read = await Send("GET", $"/api/history?root={Root}", null, cookie);

        Assert.Equal(200, write.Status);
        Assert.Equal("""[{"endpoint":"get_user","status":200}]""", read.Body);
        Assert.Single(Directory.GetFiles(Path.Combine(_data, "history")));
        Assert.Empty(Directory.GetFiles(_folder, "*.json", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task TheInstanceRoute_NeedsTheSecretOfInstanceJson()
    {
        Assert.Equal(403, (await Send("GET", "/internal/ticket")).Status);
        var (status, _, ticket) = await Send("GET", "/internal/ticket", null, $"{Api.InstanceHeader}: instance-secret");
        Assert.Equal(200, status);
        Assert.NotNull(_sessions.Redeem(ticket));
    }

    [Fact]
    public async Task WithoutTinyprobe_CallsAndRunsSayWhatIsNeeded()
    {
        var cookie = await Session();
        var body = $$"""{"root":"{{Workspace.RealPath(_folder).Replace("\\", "\\\\")}}"}""";

        var (status, _, answer) = await Send("POST", "/api/run", body, cookie, Origin);

        Assert.Equal(409, status);
        Assert.Equal("tinyprobe 0.20.0 or newer is needed.", JsonDocument.Parse(answer).RootElement.GetProperty("error").GetString());
    }
}
