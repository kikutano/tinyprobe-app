using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Tinyprobe.App;

/// <summary>A request as the page sends it: one per connection, with a small head and a bounded body.</summary>
internal sealed class HttpRequest
{
    public required string Method { get; init; }
    public required string Path { get; init; }
    public required IReadOnlyDictionary<string, string> Query { get; init; }
    public required IReadOnlyDictionary<string, string> Headers { get; init; }
    public required byte[] Body { get; init; }

    public string? Header(string name) => Headers.TryGetValue(name, out var value) ? value : null;

    public string? Cookie(string name)
    {
        foreach (var pair in (Header("Cookie") ?? "").Split(';'))
        {
            var equals = pair.IndexOf('=');
            if (equals > 0 && pair[..equals].Trim() == name) return pair[(equals + 1)..].Trim();
        }
        return null;
    }
}

/// <summary>
/// The answer to one request. Every response closes the connection: the page is on the same machine, so
/// a new connection per request costs nothing, and it keeps the server free of keep-alive state.
/// </summary>
internal sealed class HttpResponse(Stream stream)
{
    public bool Started { get; private set; }

    public List<(string Name, string Value)> Headers { get; } = [];

    public async Task Send(int status, string contentType, ReadOnlyMemory<byte> body)
    {
        await WriteHead(status, contentType, body.Length);
        await stream.WriteAsync(body);
    }

    public Task Text(int status, string text) => Send(status, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes(text));

    public Task Json(int status, byte[] json) => Send(status, "application/json; charset=utf-8", json);

    /// <summary>Starts a body of unknown length, written as it comes and ended by closing the connection.</summary>
    public async Task<Stream> Stream(int status, string contentType)
    {
        await WriteHead(status, contentType, null);
        return stream;
    }

    private async Task WriteHead(int status, string contentType, int? length)
    {
        if (Started) throw new InvalidOperationException("The response has already started.");
        Started = true;
        var head = new StringBuilder();
        head.Append("HTTP/1.1 ").Append(status).Append(' ').Append(Reason(status)).Append("\r\n");
        head.Append("Content-Type: ").Append(contentType).Append("\r\n");
        if (length is not null) head.Append("Content-Length: ").Append(length).Append("\r\n");
        head.Append("Cache-Control: no-store\r\n");
        head.Append("X-Content-Type-Options: nosniff\r\n");
        head.Append("Referrer-Policy: no-referrer\r\n");
        head.Append("Connection: close\r\n");
        foreach (var (name, value) in Headers) head.Append(name).Append(": ").Append(value).Append("\r\n");
        head.Append("\r\n");
        await stream.WriteAsync(Encoding.UTF8.GetBytes(head.ToString()));
    }

    private static string Reason(int status) => status switch
    {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Content Too Large",
        _ => "Error"
    };
}

/// <summary>
/// A minimal HTTP/1.1 server on 127.0.0.1. HttpListener would triple the size of the launcher (6.2 MB against
/// 2.0 MB, measured on 2026-10-30) for features the page does not use.
/// </summary>
internal sealed class HttpServer
{
    private const int MaxHead = 64 * 1024;
    private const int MaxBody = 16 * 1024 * 1024;

    private readonly TcpListener _listener;
    private readonly Func<HttpRequest, HttpResponse, CancellationToken, Task> _handler;

    private HttpServer(TcpListener listener, Func<HttpRequest, HttpResponse, CancellationToken, Task> handler)
    {
        _listener = listener;
        _handler = handler;
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;

    /// <summary>Listens on the loopback interface only, or returns null when the port is taken.</summary>
    public static HttpServer? Listen(int port, Func<HttpRequest, HttpResponse, CancellationToken, Task> handler)
    {
        var listener = new TcpListener(IPAddress.Loopback, port);
        // Without this, a port another program also binds on all interfaces could be shared on Windows.
        listener.ExclusiveAddressUse = true;
        try
        {
            listener.Start();
            return new HttpServer(listener, handler);
        }
        catch (SocketException)
        {
            listener.Dispose();
            return null;
        }
    }

    public async Task Serve(CancellationToken stop)
    {
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(stop);
                _ = Handle(client);
            }
        }
        catch (OperationCanceledException)
        {
        }
        finally
        {
            _listener.Stop();
        }
    }

    private async Task Handle(TcpClient client)
    {
        using (client)
        {
            client.NoDelay = true;
            var stream = client.GetStream();
            HttpRequest? request;
            try
            {
                request = await Read(stream);
            }
            catch (IOException)
            {
                return;
            }

            var response = new HttpResponse(stream);
            if (request is null)
            {
                await Try(() => response.Text(400, "Bad request"));
                return;
            }

            // The page closes the connection when a run is stopped or the tab is closed: that cancels the run.
            using var gone = new CancellationTokenSource();
            var watch = WatchClose(client.Client, gone);
            try
            {
                await _handler(request, response, gone.Token);
            }
            catch (Exception) when (!response.Started)
            {
                await Try(() => response.Text(500, "The app could not answer this request."));
            }
            catch (Exception)
            {
                // The page went away in the middle of a streamed answer: nothing to tell it.
            }
            finally
            {
                client.Client.Shutdown(SocketShutdown.Both);
            }
            await watch;
        }
    }

    private static async Task Try(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (IOException)
        {
        }
    }

    private static async Task WatchClose(Socket socket, CancellationTokenSource gone)
    {
        var one = new byte[1];
        try
        {
            while (await socket.ReceiveAsync(one, SocketFlags.None) > 0)
            {
            }
        }
        catch (Exception)
        {
        }
        try
        {
            gone.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    internal static async Task<HttpRequest?> Read(Stream stream)
    {
        var received = new MemoryStream();
        var chunk = new byte[8192];
        int headEnd;
        while ((headEnd = received.GetBuffer().AsSpan(0, (int)received.Length).IndexOf("\r\n\r\n"u8)) < 0)
        {
            if (received.Length > MaxHead) return null;
            var read = await stream.ReadAsync(chunk);
            if (read == 0) return null;
            received.Write(chunk, 0, read);
        }

        var bytes = received.GetBuffer().AsMemory(0, (int)received.Length);
        var lines = Encoding.UTF8.GetString(bytes.Span[..headEnd]).Split("\r\n");
        var start = lines[0].Split(' ');
        if (start.Length != 3 || !start[2].StartsWith("HTTP/1.", StringComparison.Ordinal)) return null;

        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) return null;
            headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
        }

        var length = 0;
        if (headers.TryGetValue("Content-Length", out var text) && (!int.TryParse(text, out length) || length < 0)) return null;
        if (length > MaxBody || headers.ContainsKey("Transfer-Encoding")) return null;

        var body = new byte[length];
        var already = Math.Min(bytes.Length - (headEnd + 4), length);
        bytes.Slice(headEnd + 4, already).CopyTo(body);
        var filled = already;
        while (filled < length)
        {
            var read = await stream.ReadAsync(body.AsMemory(filled));
            if (read == 0) return null;
            filled += read;
        }

        var target = start[1];
        var question = target.IndexOf('?');
        var path = question < 0 ? target : target[..question];
        return new HttpRequest
        {
            Method = start[0],
            Path = Uri.UnescapeDataString(path),
            Query = ParseQuery(question < 0 ? "" : target[(question + 1)..]),
            Headers = headers,
            Body = body
        };
    }

    internal static Dictionary<string, string> ParseQuery(string query)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = pair.IndexOf('=');
            var name = equals < 0 ? pair : pair[..equals];
            var value = equals < 0 ? "" : pair[(equals + 1)..];
            values[Decode(name)] = Decode(value);
        }
        return values;

        static string Decode(string text) => Uri.UnescapeDataString(text.Replace('+', ' '));
    }
}
