using System.Security.Cryptography;

namespace Tinyprobe.App;

/// <summary>
/// Who may use the launcher. The launcher opens the browser on a one-time link; the link becomes an HttpOnly,
/// SameSite=Strict cookie, so another web page open in the same browser can neither read it nor send it.
/// </summary>
internal sealed class Sessions
{
    public const string Cookie = "tinyprobe_app";
    private static readonly TimeSpan TicketLife = TimeSpan.FromMinutes(2);

    private readonly object _lock = new();
    private readonly Dictionary<string, DateTime> _tickets = new(StringComparer.Ordinal);
    private readonly HashSet<string> _sessions = new(StringComparer.Ordinal);

    public string NewTicket()
    {
        var ticket = Secret();
        lock (_lock) _tickets[ticket] = DateTime.UtcNow + TicketLife;
        return ticket;
    }

    /// <summary>A ticket works once, within two minutes; it returns the new session, or null.</summary>
    public string? Redeem(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket)) return null;
        lock (_lock)
        {
            if (!_tickets.Remove(ticket, out var expires) || expires < DateTime.UtcNow) return null;
            var session = Secret();
            _sessions.Add(session);
            return session;
        }
    }

    public bool IsValid(string? session)
    {
        if (string.IsNullOrEmpty(session)) return false;
        lock (_lock) return _sessions.Contains(session);
    }

    public static string Secret() => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));
}
