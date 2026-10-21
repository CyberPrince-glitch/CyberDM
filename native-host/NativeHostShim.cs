using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

// Electron's Windows GUI process does not reliably receive Chromium's stdin
// pipe. Keep the native-messaging protocol in this small console process and
// hand requests to the desktop app through its existing request/ack files.
internal static class NativeHostShim
{
    private const int MaxMessageBytes = 1024 * 1024;

    private static int Main(string[] args)
    {
        var appPath = ResolveAppPath(args);
        if (appPath == null)
            return Reply(false, "CyberDM.exe path is missing or invalid. Reinstall the browser bridge and check its app path.");

        // Do not let a burst of browser download events launch hundreds of
        // Electron instances at once. One native handoff may launch CyberDM;
        // concurrent requests are rejected while the browser keeps its copy.
        using (var launchGate = new Mutex(false, @"Local\CyberDM.NativeMessagingGate"))
        {
            bool ownsLaunchGate = false;
            try
            {
                try { ownsLaunchGate = launchGate.WaitOne(0); }
                catch (AbandonedMutexException) { ownsLaunchGate = true; }
                if (!ownsLaunchGate)
                    return Reply(false, "CyberDM is busy handling another browser download. The browser download is still available.");

                var input = Console.OpenStandardInput();
                var header = ReadExact(input, 4);
                if (header == null) return Reply(false, "No browser request received");
                var messageLength = BitConverter.ToUInt32(header, 0);
                if (messageLength == 0 || messageLength > MaxMessageBytes)
                    return Reply(false, "Invalid native message size");

                var message = ReadExact(input, (int)messageLength);
                if (message == null) return Reply(false, "Incomplete browser request");
                var requestJson = Encoding.UTF8.GetString(message).Trim();
                if (requestJson.Length < 2 || requestJson[0] != '{' || requestJson[requestJson.Length - 1] != '}')
                    return Reply(false, "Invalid native message JSON");

                var requestId = Guid.NewGuid().ToString();
                var requestPath = Path.Combine(UserDataPath(), "native-requests", requestId + ".json");
                Directory.CreateDirectory(Path.GetDirectoryName(requestPath));
                var payload = requestJson.Substring(0, requestJson.Length - 1) +
                    ",\"requestId\":\"" + requestId + "\"}";
                File.WriteAllText(requestPath, payload, new UTF8Encoding(false));

                var start = new ProcessStartInfo
                {
                    FileName = appPath,
                    Arguments = "--cyberdm-request=" + requestId,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(Path.GetFullPath(appPath))
                };
                Process.Start(start);

                var ackPath = Path.Combine(UserDataPath(), "native-acks", requestId + ".json");
                var deadline = DateTime.UtcNow.AddSeconds(40);
                while (DateTime.UtcNow < deadline)
                {
                    if (File.Exists(ackPath))
                    {
                        var ack = File.ReadAllText(ackPath, Encoding.UTF8);
                        File.Delete(ackPath);
                        return ReplyRaw(ack);
                    }
                    Thread.Sleep(100);
                }

                if (File.Exists(requestPath)) File.Delete(requestPath);
                return Reply(false, "CyberDM did not accept the download in time");
            }
            catch (Exception error)
            {
                return Reply(false, error.Message);
            }
            finally
            {
                if (ownsLaunchGate) launchGate.ReleaseMutex();
            }
        }
    }

    private static string UserDataPath()
    {
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "cyberdm");
    }

    private static string ResolveAppPath(string[] args)
    {
        foreach (var arg in args)
        {
            var candidate = (arg ?? "").Trim().Trim('"');
            if (candidate.Length > 0 && File.Exists(candidate)) return Path.GetFullPath(candidate);
        }

        var configuredPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "CyberDM", "cyberdm-app-path.txt");
        try
        {
            var candidate = File.ReadAllText(configuredPath, Encoding.UTF8).Trim().Trim('"');
            if (candidate.Length > 0 && File.Exists(candidate)) return Path.GetFullPath(candidate);
        }
        catch { }
        return null;
    }

    private static byte[] ReadExact(Stream input, int count)
    {
        var result = new byte[count];
        var offset = 0;
        while (offset < count)
        {
            var read = input.Read(result, offset, count - offset);
            if (read == 0) return null;
            offset += read;
        }
        return result;
    }

    private static int Reply(bool success, string error)
    {
        var escaped = error.Replace("\\", "\\\\").Replace("\"", "\\\"")
            .Replace("\r", "\\r").Replace("\n", "\\n");
        return ReplyRaw("{\"success\":" + (success ? "true" : "false") +
            ",\"error\":\"" + escaped + "\"}");
    }

    private static int ReplyRaw(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var output = Console.OpenStandardOutput();
        var header = BitConverter.GetBytes((uint)body.Length);
        output.Write(header, 0, header.Length);
        output.Write(body, 0, body.Length);
        output.Flush();
        return 0;
    }
}
