using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Tinyprobe.App;

/// <summary>Hand-written JSON, as in tinyprobe: no reflection, so Native AOT keeps the launcher small.</summary>
internal static class Json
{
    private static readonly JsonWriterOptions Options = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    public static byte[] Write(Action<Utf8JsonWriter> write)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer, Options)) write(writer);
        return buffer.WrittenSpan.ToArray();
    }

    public static byte[] Error(string message) => Write(w =>
    {
        w.WriteStartObject();
        w.WriteString("error", message);
        w.WriteEndObject();
    });

    /// <summary>Writes the output of tinyprobe as it is, or null when it is not JSON (bad arguments, a crash).</summary>
    public static void WriteRaw(Utf8JsonWriter writer, string name, string json)
    {
        writer.WritePropertyName(name);
        try
        {
            using var document = JsonDocument.Parse(json);
            document.RootElement.WriteTo(writer);
        }
        catch (JsonException)
        {
            writer.WriteNullValue();
        }
    }

    public static string? String(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
