using System.Diagnostics;
using System.Reflection;

namespace Tinyprobe.App;

/// <summary>What the app does on the user's desktop: open the browser, and add the tinyprobe icon.</summary>
internal static class Desktop
{
    public static bool OpenBrowser(string url)
    {
        try
        {
            var info = OperatingSystem.IsWindows()
                ? new ProcessStartInfo(url) { UseShellExecute = true }
                : new ProcessStartInfo(OperatingSystem.IsMacOS() ? "open" : "xdg-open") { UseShellExecute = false, RedirectStandardError = true, RedirectStandardOutput = true };
            if (!OperatingSystem.IsWindows()) info.ArgumentList.Add(url);
            using var process = Process.Start(info);
            return process is not null;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }

    public static bool CanAddIcon => OperatingSystem.IsWindows() || OperatingSystem.IsMacOS() || OperatingSystem.IsLinux();

    /// <summary>
    /// Copies the launcher into the data folder and points the icon at that copy, so the icon keeps working when
    /// the download is deleted. The icon opens a console window, which is how the app is stopped.
    /// Returns null when it worked, or what went wrong.
    /// </summary>
    public static string? AddIcon(AppPaths paths)
    {
        var running = Environment.ProcessPath;
        if (running is null) return "the app does not know where it was started from";
        try
        {
            Directory.CreateDirectory(paths.App);
            var installed = Path.Combine(paths.App, Path.GetFileName(running));
            if (!Workspace.SamePath(Path.GetFullPath(running), Path.GetFullPath(installed))) File.Copy(running, installed, overwrite: true);

            if (OperatingSystem.IsWindows()) return WindowsShortcuts(installed);
            if (OperatingSystem.IsMacOS()) return MacApplication(paths, installed);
            return LinuxDesktopEntry(paths, installed);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return $"the icon could not be added ({e.GetType().Name})";
        }
    }

    // A .lnk is a COM object: PowerShell writes it, so the launcher needs no COM interop.
    private static string? WindowsShortcuts(string installed)
    {
        const string script = """
            $shell = New-Object -ComObject WScript.Shell
            $exe = $env:TINYPROBE_APP_EXE
            foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
              $link = $shell.CreateShortcut((Join-Path $folder 'tinyprobe.lnk'))
              $link.TargetPath = $exe
              $link.WorkingDirectory = Split-Path $exe
              $link.IconLocation = "$exe,0"
              $link.Description = 'tinyprobe: call endpoints and run workflows'
              $link.Save()
            }
            """;
        var info = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (var argument in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script }) info.ArgumentList.Add(argument);
        info.Environment["TINYPROBE_APP_EXE"] = installed;
        using var process = Process.Start(info);
        if (process is null) return "PowerShell could not be started";
        var error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        return process.ExitCode == 0 ? null : $"the shortcuts could not be created: {error.Trim()}";
    }

    // A .app whose program opens Terminal on the launcher: the window shows the app is running, and closing it stops it.
    [System.Runtime.Versioning.SupportedOSPlatform("macos")]
    private static string? MacApplication(AppPaths paths, string installed)
    {
        var bundle = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Applications", "tinyprobe.app", "Contents");
        Directory.CreateDirectory(Path.Combine(bundle, "MacOS"));
        Directory.CreateDirectory(Path.Combine(bundle, "Resources"));
        File.WriteAllText(Path.Combine(bundle, "Info.plist"), """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>CFBundleName</key><string>tinyprobe</string>
              <key>CFBundleIdentifier</key><string>io.github.kikutano.tinyprobe-app</string>
              <key>CFBundleExecutable</key><string>tinyprobe</string>
              <key>CFBundleIconFile</key><string>icon</string>
              <key>CFBundlePackageType</key><string>APPL</string>
            </dict>
            </plist>
            """);
        var program = Path.Combine(bundle, "MacOS", "tinyprobe");
        File.WriteAllText(program, $"#!/bin/sh\nexec open -a Terminal {Quote(installed)}\n");
        File.SetUnixFileMode(program, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        WriteResource("media/icon.icns", Path.Combine(bundle, "Resources", "icon.icns"));
        return null;
    }

    private static string? LinuxDesktopEntry(AppPaths paths, string installed)
    {
        var icon = Path.Combine(paths.Data, "icon.png");
        WriteResource("media/icon.png", icon);
        var data = Environment.GetEnvironmentVariable("XDG_DATA_HOME") is { Length: > 0 } xdg
            ? xdg
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share");
        var applications = Path.Combine(data, "applications");
        Directory.CreateDirectory(applications);
        File.WriteAllText(Path.Combine(applications, "tinyprobe-app.desktop"), $"""
            [Desktop Entry]
            Type=Application
            Name=tinyprobe
            Comment=Call endpoints and run tinyprobe workflows
            Exec={Quote(installed)}
            Icon={icon}
            Terminal=true
            Categories=Development;
            """ + "\n");
        return null;
    }

    private static string Quote(string path) => "\"" + path.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";

    private static void WriteResource(string name, string destination)
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
            ?? throw new IOException($"The resource {name} is missing.");
        using var output = File.Create(destination);
        resource.CopyTo(output);
    }
}
