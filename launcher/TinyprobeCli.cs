using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Tinyprobe.App;

/// <summary>Which tinyprobe the app runs, and where it came from: path, app (its own copy) or env (TINYPROBE_PATH).</summary>
internal sealed record CliInfo(string Path, string Version, string Source);

/// <summary>
/// The engine. The app is a client of the CLI (tinyprobe decision 0004): it only runs `tinyprobe` and reads its
/// JSON, as the VS Code extension does.
/// </summary>
internal sealed class TinyprobeCli(AppPaths paths)
{
    /// <summary>The oldest tinyprobe this app works with: `matches` and `schema` are in its forms and results.</summary>
    public const string Minimum = "0.20.0";

    private const string Releases = "https://github.com/kikutano/tinyprobe/releases/latest/download";

    private readonly object _lock = new();
    private CliInfo? _current;
    private string? _problem;

    public CliInfo? Current { get { lock (_lock) return _current; } }

    /// <summary>Why the tinyprobe of the PATH is not used, shown in the console and in the settings.</summary>
    public string? Problem { get { lock (_lock) return _problem; } }

    public static string ExecutableName => OperatingSystem.IsWindows() ? "tinyprobe.exe" : "tinyprobe";

    private string OwnCopy => Path.Combine(paths.Bin, ExecutableName);

    public async Task Locate()
    {
        CliInfo? found = null;
        string? problem = null;

        // Development and tests: the binary given, whatever its version (a development build is 0.0.0-dev).
        var forced = Environment.GetEnvironmentVariable("TINYPROBE_PATH");
        if (!string.IsNullOrEmpty(forced) && await VersionOf(forced) is { } forcedVersion)
            found = new CliInfo(forced, forcedVersion, "env");

        if (found is null && FindOnPath() is { } onPath && await VersionOf(onPath) is { } pathVersion)
        {
            if (AtLeast(pathVersion, Minimum)) found = new CliInfo(onPath, pathVersion, "path");
            else problem = $"tinyprobe {pathVersion} on the PATH is older than {Minimum}; using the app's own copy";
        }

        if (found is null && File.Exists(OwnCopy) && await VersionOf(OwnCopy) is { } ownVersion && AtLeast(ownVersion, Minimum))
            found = new CliInfo(OwnCopy, ownVersion, "app");

        lock (_lock)
        {
            _current = found;
            _problem = problem;
        }
    }

    /// <summary>Numeric comparison of `X.Y.Z`; a pre-release counts as its version without the suffix.</summary>
    public static bool AtLeast(string version, string minimum)
    {
        static int[] Parts(string v) => v.Split('-', '+')[0].Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).Concat([0, 0, 0]).Take(3).ToArray();
        var a = Parts(version);
        var b = Parts(minimum);
        for (var i = 0; i < 3; i++)
            if (a[i] != b[i]) return a[i] > b[i];
        return true;
    }

    private static string? FindOnPath()
    {
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(directory.Trim('"'), ExecutableName);
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static async Task<string?> VersionOf(string executable)
    {
        try
        {
            var info = new ProcessStartInfo(executable) { RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true };
            info.ArgumentList.Add("--version");
            using var process = Process.Start(info);
            if (process is null) return null;
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var output = await process.StandardOutput.ReadToEndAsync(timeout.Token);
            await process.WaitForExitAsync(timeout.Token);
            var version = output.Trim().Split(' ').LastOrDefault();
            return process.ExitCode == 0 && !string.IsNullOrEmpty(version) ? version : null;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or IOException or OperationCanceledException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>
    /// Installs the latest release in the app's data folder, checked against the release's SHA256SUMS as
    /// install.sh does. Returns null when it worked, or what went wrong.
    /// </summary>
    public async Task<string?> Download(CancellationToken cancel)
    {
        var rid = RuntimeInformation.RuntimeIdentifier;
        var archive = OperatingSystem.IsWindows() ? $"tinyprobe-{rid}.zip" : $"tinyprobe-{rid}.tar.gz";
        var source = Environment.GetEnvironmentVariable("TINYPROBE_APP_DOWNLOAD_URL") is { Length: > 0 } custom ? custom.TrimEnd('/') : Releases;
        var work = Path.Combine(paths.Data, "download");
        try
        {
            if (Directory.Exists(work)) Directory.Delete(work, recursive: true);
            Directory.CreateDirectory(work);
            if (await Fetch($"{source}/SHA256SUMS", Path.Combine(work, "SHA256SUMS"), cancel) is { } sumsError) return sumsError;
            var expected = (await File.ReadAllLinesAsync(Path.Combine(work, "SHA256SUMS"), cancel))
                .Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                .FirstOrDefault(parts => parts.Length == 2 && parts[1].TrimStart('*') == archive)?[0];
            if (expected is null) return $"the release has no tinyprobe for this platform ({rid})";

            var downloaded = Path.Combine(work, archive);
            if (await Fetch($"{source}/{archive}", downloaded, cancel) is { } archiveError) return archiveError;
            await using (var input = File.OpenRead(downloaded))
            {
                var actual = Convert.ToHexStringLower(await SHA256.HashDataAsync(input, cancel));
                if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
                    return "the download of tinyprobe does not match its checksum; nothing was installed";
            }

            // tar reads .tar.gz everywhere, and .zip too on Windows, where it ships since Windows 10.
            var (code, _, error) = await Run("tar", ["-xf", archive], work, cancel);
            var extracted = Path.Combine(work, ExecutableName);
            if (code != 0 || !File.Exists(extracted)) return $"the download could not be unpacked: {error.Trim()}";

            Directory.CreateDirectory(paths.Bin);
            if (!OperatingSystem.IsWindows())
                File.SetUnixFileMode(extracted, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            File.Move(extracted, OwnCopy, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            return $"tinyprobe could not be installed ({e.GetType().Name})";
        }
        finally
        {
            try
            {
                if (Directory.Exists(work)) Directory.Delete(work, recursive: true);
            }
            catch (IOException)
            {
            }
        }

        await Locate();
        return Current is null ? "the downloaded tinyprobe does not start on this machine" : null;
    }

    /// <summary>
    /// Downloads with the system's curl (Windows 10 and later, macOS, Linux desktops): an HTTPS client of our own
    /// would make the launcher three times bigger, for one download.
    /// </summary>
    private static async Task<string?> Fetch(string url, string destination, CancellationToken cancel)
    {
        try
        {
            var (code, _, error) = await Run("curl", ["-fsSL", "--proto", "=https,http", "-o", destination, url], Path.GetDirectoryName(destination)!, cancel);
            return code == 0 ? null : $"tinyprobe could not be downloaded from {url}: {error.Trim()}";
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return "curl is needed to download tinyprobe; install tinyprobe yourself (https://github.com/kikutano/tinyprobe#install) and start the app again";
        }
    }

    /// <summary>`tinyprobe update` on the app's own copy; a tinyprobe on the PATH belongs to the user, who updates it.</summary>
    public async Task<(int Code, string Output)> UpdateOwnCopy(CancellationToken cancel)
    {
        if (Current is not { Source: "app" } current) return (2, "Only the app's own copy of tinyprobe is updated from here.");
        var (code, output, error) = await Run(current.Path, ["update"], paths.Data, cancel);
        await Locate();
        return (code, (output + error).Trim());
    }

    /// <summary>Starts tinyprobe with its arguments as they are: no shell, whatever they contain.</summary>
    public static ProcessStartInfo StartInfo(string executable, IEnumerable<string> arguments, string directory)
    {
        var info = new ProcessStartInfo(executable)
        {
            WorkingDirectory = directory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        return info;
    }

    public static async Task<(int Code, string Output, string Error)> Run(string executable, IEnumerable<string> arguments, string directory, CancellationToken cancel)
    {
        using var process = Process.Start(StartInfo(executable, arguments, directory))!;
        var output = process.StandardOutput.ReadToEndAsync(cancel);
        var error = process.StandardError.ReadToEndAsync(cancel);
        try
        {
            await process.WaitForExitAsync(cancel);
        }
        catch (OperationCanceledException)
        {
            process.Kill(entireProcessTree: true);
            throw;
        }
        return (process.ExitCode, await output, await error);
    }
}
