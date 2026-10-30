// Fake `codex exec --experimental-json` used ONLY by offline tests.
// It emits the JSONL event protocol the TypeScript SDK parses, without any
// model call. Behaviour knobs (env):
//   FAKE_CODEX_LOG          file to append a JSON argv record to
//   FAKE_CODEX_FAIL=1       exit 1 immediately (no events) with stderr text
//   FAKE_CODEX_CRASH_MID=1  emit thread.started then exit 1 (crash mid-first-turn)
//   FAKE_CODEX_THREAD_ID    fixed thread id to report (default: derived from --cd)
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;

class FakeCodex
{
    static string JsonEscape(string s)
    {
        var b = new StringBuilder(s.Length + 8);
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': b.Append("\\\\"); break;
                case '"': b.Append("\\\""); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < ' ') b.Append("\\u" + ((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.ToString();
    }

    static int Main(string[] args)
    {
        var log = Environment.GetEnvironmentVariable("FAKE_CODEX_LOG");
        if (!string.IsNullOrEmpty(log))
        {
            var rec = new StringBuilder("{\"argv\":[");
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) rec.Append(',');
                rec.Append('"').Append(JsonEscape(args[i])).Append('"');
            }
            rec.Append("]}\n");
            File.AppendAllText(log, rec.ToString());
        }

        if (Environment.GetEnvironmentVariable("FAKE_CODEX_FAIL") == "1")
        {
            Console.Error.WriteLine("fake codex failure requested");
            return 1;
        }

        string resumeId = null;
        string workdir = "";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "resume" && i + 1 < args.Length) resumeId = args[i + 1];
            if (args[i] == "--cd" && i + 1 < args.Length) workdir = args[i + 1];
        }

        string prompt = "";
        try { prompt = Console.In.ReadToEnd() ?? ""; } catch { }

        if (Environment.GetEnvironmentVariable("FAKE_CODEX_CRASH_MID") == "1" && resumeId == null)
        {
            Console.Out.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"thread_crash_mid\"}");
            Console.Out.Flush();
            return 1;
        }

        string threadId = Environment.GetEnvironmentVariable("FAKE_CODEX_THREAD_ID");
        if (string.IsNullOrEmpty(threadId))
        {
            using (var md5 = MD5.Create())
            {
                var hash = md5.ComputeHash(Encoding.UTF8.GetBytes(workdir));
                var sb = new StringBuilder();
                for (int i = 0; i < 6; i++) sb.Append(hash[i].ToString("x2"));
                threadId = "thread_" + sb;
            }
        }

        var stdout = Console.Out;
        if (resumeId == null)
        {
            stdout.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"" + JsonEscape(threadId) + "\"}");
        }
        stdout.WriteLine("{\"type\":\"turn.started\"}");
        stdout.WriteLine("{\"type\":\"item.completed\",\"item\":{\"id\":\"item_1\",\"type\":\"agent_message\",\"text\":\"FAKE_ECHO: " + JsonEscape(prompt.Trim()) + "\"}}");
        stdout.WriteLine("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"output_tokens\":5,\"reasoning_output_tokens\":0}}");
        stdout.Flush();
        return 0;
    }
}
