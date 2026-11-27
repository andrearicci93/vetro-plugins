using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// The trusted xattr is kernel-protected even when the directory belongs to Vetro.
internal class PlaybackBinding
{
    const string Attribute = "trusted.ambilight.primary";
    readonly string directory;
    string verified;
    public PlaybackBinding(string directory) { this.directory = directory; }

    [DllImport("libc.so.6")] static extern IntPtr lgetxattr(string path, string name, byte[] value, UIntPtr size);
    [DllImport("libc.so.6")] static extern int lsetxattr(string path, string name, byte[] value, UIntPtr size, int flags);

    internal virtual string Identity()
    {
        try
        {
            var boot = Guid.Parse(File.ReadAllText("/proc/sys/kernel/random/boot_id").Trim());
            var start = new ProcessStartInfo("/usr/bin/stat",
                "-L -c %d:%i:%t:%T /sys/class/sound/pcmC0D5c /dev/snd/pcmC0D5c") {
                UseShellExecute = false, RedirectStandardOutput = true
            };
            using (var stat = Process.Start(start))
            {
                if (!stat.WaitForExit(1500))
                {
                    try { stat.Kill(); }
                    catch (InvalidOperationException) {}
                    catch (System.ComponentModel.Win32Exception) {}
                    return null;
                }
                string nodes = stat.StandardOutput.ReadToEnd().Trim();
                if (stat.ExitCode != 0 || nodes.Split('\n').Length != 2) return null;
                return boot.ToString() + "\n" + nodes;
            }
        }
        catch (IOException) { return null; }
        catch (FormatException) { return null; }
        catch (InvalidOperationException) { return null; }
        catch (System.ComponentModel.Win32Exception) { return null; }
    }
    internal void Remember(string identity)
    {
        if (verified == identity) return;
        verified = identity;
        if (directory == null) return;
        var bytes = Encoding.ASCII.GetBytes(identity);
        lsetxattr(directory, Attribute, bytes, (UIntPtr)bytes.Length, 0);
    }
    internal bool Matches(string identity)
    {
        if (verified == identity) return true;
        if (directory == null) return false;
        var bytes = new byte[256];
        long size = lgetxattr(directory, Attribute, bytes, (UIntPtr)bytes.Length).ToInt64();
        return size > 0 && size <= bytes.Length && Encoding.ASCII.GetString(bytes, 0, (int)size) == identity;
    }
}
