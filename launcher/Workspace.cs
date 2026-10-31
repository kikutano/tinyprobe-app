namespace Tinyprobe.App;

/// <summary>The folders the page works in, and the rule that it never reaches outside them.</summary>
internal static class Workspace
{
    /// <summary>Folders that hold no tests and can be huge.</summary>
    private static readonly string[] Skipped = [".git", ".hg", ".svn", "node_modules", "bin", "obj", ".dev", ".vs", ".idea", ".vscode"];

    /// <summary>Beyond this, the listing stops: a folder with more YAML files is a whole project, not its tests.</summary>
    public const int MaxFiles = 500;

    private static StringComparison Comparison =>
        OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static bool SamePath(string a, string b) => string.Equals(a.TrimEnd(Path.DirectorySeparatorChar), b.TrimEnd(Path.DirectorySeparatorChar), Comparison);

    /// <summary>The full path with every symbolic link resolved, so a link cannot lead out of a folder.</summary>
    public static string RealPath(string path) => RealPath(path, 0);

    private static string RealPath(string path, int depth)
    {
        if (depth > 32) throw new IOException("Too many symbolic links.");
        var full = Path.GetFullPath(path);
        var root = Path.GetPathRoot(full)!;
        var current = root;
        foreach (var part in full[root.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            var next = Path.Combine(current, part);
            FileSystemInfo info = Directory.Exists(next) ? new DirectoryInfo(next) : new FileInfo(next);
            if (info.Exists && info.LinkTarget is not null && info.ResolveLinkTarget(returnFinalTarget: true) is { } target)
                next = RealPath(target.FullName, depth + 1);
            current = next;
        }
        return current;
    }

    public static bool IsInside(string path, string folder)
    {
        var root = folder.TrimEnd(Path.DirectorySeparatorChar);
        return SamePath(path, root) || path.StartsWith(root + Path.DirectorySeparatorChar, Comparison);
    }

    /// <summary>The full path of a file the page names, or null when it is not inside the folder.</summary>
    public static string? Inside(string folder, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.Contains('\0')) return null;
        string full;
        try
        {
            full = RealPath(Path.Combine(folder, relative));
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            return null;
        }
        return IsInside(full, folder) && !SamePath(full, folder) ? full : null;
    }

    /// <summary>The layout of `tinyprobe init` and of the guide: a project's tests live in its `tinyprobe/` folder.</summary>
    public static string OpenTarget(string folder)
    {
        var tests = Path.Combine(folder, "tinyprobe");
        return Directory.Exists(tests) ? RealPath(tests) : folder;
    }

    /// <summary>The YAML files of a folder, as paths relative to it with `/`, in ordinal order like `tinyprobe run`.</summary>
    public static (List<string> Files, bool Truncated) YamlFiles(string folder)
    {
        var files = new List<string>();
        var pending = new Stack<string>();
        pending.Push(folder);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFileSystemEntries(directory).ToList();
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (var entry in entries)
            {
                var name = Path.GetFileName(entry);
                if (Directory.Exists(entry))
                {
                    // Links to folders are not followed: they could loop or lead outside.
                    if (!Skipped.Contains(name, StringComparer.OrdinalIgnoreCase) && new DirectoryInfo(entry).LinkTarget is null) pending.Push(entry);
                }
                else if (name.EndsWith(".yaml", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".yml", StringComparison.OrdinalIgnoreCase))
                {
                    files.Add(Path.GetRelativePath(folder, entry).Replace('\\', '/'));
                    if (files.Count >= MaxFiles) return (Sorted(files), true);
                }
            }
        }
        return (Sorted(files), false);

        static List<string> Sorted(List<string> files)
        {
            files.Sort(StringComparer.Ordinal);
            return files;
        }
    }

    /// <summary>The same rules as the VS Code extension: a top-level `endpoints:`, `steps:` or `sequence:`.</summary>
    public static bool IsTinyprobeFile(string text)
    {
        foreach (var line in text.Split('\n'))
            foreach (var key in (string[])["endpoints", "steps", "sequence"])
                if (line.StartsWith(key, StringComparison.Ordinal) && line.AsSpan(key.Length).TrimStart(" \t").StartsWith(":")) return true;
        return false;
    }

    /// <summary>`env.yaml`, `env.local.yaml`, `env-dev.yaml`, `environment.yaml`...</summary>
    public static bool IsEnvironmentFile(string relative)
    {
        var name = relative[(relative.LastIndexOf('/') + 1)..].ToLowerInvariant();
        var extension = name.EndsWith(".yaml", StringComparison.Ordinal) ? 5 : name.EndsWith(".yml", StringComparison.Ordinal) ? 4 : 0;
        if (extension == 0) return false;
        var stem = name[..^extension];
        var rest = stem.StartsWith("environment", StringComparison.Ordinal) ? stem[11..] : stem.StartsWith("env", StringComparison.Ordinal) ? stem[3..] : null;
        return rest is not null && (rest.Length == 0 || rest[0] is '.' or '_' or '-');
    }
}
