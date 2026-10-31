using System.Text.Json;

namespace Tinyprobe.App;

/// <summary>Where the app keeps its own files: settings, its copy of tinyprobe, the installed launcher.</summary>
internal sealed class AppPaths(string data)
{
    public string Data { get; } = data;
    public string Config => Path.Combine(Data, "config.json");
    public string Instance => Path.Combine(Data, "instance.json");
    public string Bin => Path.Combine(Data, "bin");
    public string App => Path.Combine(Data, "app");

    public static AppPaths Default()
    {
        var overridden = Environment.GetEnvironmentVariable("TINYPROBE_APP_DATA");
        if (!string.IsNullOrEmpty(overridden)) return new AppPaths(Path.GetFullPath(overridden));
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (OperatingSystem.IsWindows())
            return new AppPaths(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "tinyprobe-app"));
        if (OperatingSystem.IsMacOS())
            return new AppPaths(Path.Combine(home, "Library", "Application Support", "tinyprobe-app"));
        var xdg = Environment.GetEnvironmentVariable("XDG_DATA_HOME");
        return new AppPaths(Path.Combine(string.IsNullOrEmpty(xdg) ? Path.Combine(home, ".local", "share") : xdg, "tinyprobe-app"));
    }

    /// <summary>Writes a file only this user can read: it may hold the secret of the running app.</summary>
    public static void WritePrivate(string path, byte[] content)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.WriteAllBytes(temporary, []);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.WriteAllBytes(temporary, content);
        File.Move(temporary, path, overwrite: true);
    }
}

/// <summary>
/// The app's settings: its port, the folders it may open, and whether the icon was offered. Folders leave the
/// list only when the user removes them, since the launcher reads and writes files only inside them.
/// </summary>
internal sealed class Config
{
    public const int DefaultPort = 4747;
    private const int MaxFolders = 20;

    private readonly AppPaths _paths;
    private readonly object _lock = new();
    private readonly List<string> _folders = [];

    private Config(AppPaths paths) => _paths = paths;

    public int Port { get; private set; } = DefaultPort;

    /// <summary>offer (not asked yet), created or declined.</summary>
    public string Shortcut { get; private set; } = "offer";

    public IReadOnlyList<string> Folders
    {
        get { lock (_lock) return [.. _folders]; }
    }

    public static Config Load(AppPaths paths)
    {
        var config = new Config(paths);
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllBytes(paths.Config));
            var root = document.RootElement;
            if (root.TryGetProperty("port", out var port) && port.TryGetInt32(out var number) && number is > 0 and < 65536) config.Port = number;
            if (root.TryGetProperty("shortcut", out var shortcut) && shortcut.GetString() is { } value) config.Shortcut = value;
            if (root.TryGetProperty("folders", out var folders) && folders.ValueKind == JsonValueKind.Array)
                foreach (var folder in folders.EnumerateArray())
                    if (folder.GetString() is { Length: > 0 } path) config._folders.Add(path);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            // A first start, or a broken file: the defaults are fine.
        }
        return config;
    }

    public void SetPort(int port)
    {
        lock (_lock) Port = port;
        Save();
    }

    public void SetShortcut(string value)
    {
        lock (_lock) Shortcut = value;
        Save();
    }

    /// <summary>The folder moves to the top of the list, as the most recent one.</summary>
    public void AddFolder(string folder)
    {
        lock (_lock)
        {
            _folders.RemoveAll(f => Workspace.SamePath(f, folder));
            _folders.Insert(0, folder);
            if (_folders.Count > MaxFolders) _folders.RemoveRange(MaxFolders, _folders.Count - MaxFolders);
        }
        Save();
    }

    public void RemoveFolder(string folder)
    {
        lock (_lock) _folders.RemoveAll(f => Workspace.SamePath(f, folder));
        Save();
    }

    public bool IsFolder(string folder)
    {
        lock (_lock) return _folders.Any(f => Workspace.SamePath(f, folder));
    }

    private void Save()
    {
        byte[] json;
        lock (_lock)
        {
            json = Json.Write(w =>
            {
                w.WriteStartObject();
                w.WriteNumber("port", Port);
                w.WriteString("shortcut", Shortcut);
                w.WriteStartArray("folders");
                foreach (var folder in _folders) w.WriteStringValue(folder);
                w.WriteEndArray();
                w.WriteEndObject();
            });
        }
        try
        {
            AppPaths.WritePrivate(_paths.Config, json);
        }
        catch (IOException)
        {
            // Settings are a convenience: the app keeps working without them.
        }
    }
}
