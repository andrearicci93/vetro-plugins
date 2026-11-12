using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;

internal static class Program
{
    // Linux ARM32 UAPI constants: input.h/uinput.h. Keep the guard in Main
    // before any evdev grab: this helper encodes 16-byte input_event records.
    const string Name = "8BitDo Ultimate 2 Wireless", Phys = "vetro-8bitdo-guide-proxy";
    const string StatusPath = "/tmp/vetro-8bitdo-guide-status.json";
    const int Guide = 316, NonBlock = 0x800, CloseExec = 0x80000;
    static int physical = -1, output = -1;
    static volatile bool quitting;
    static bool grabbed;
    static uint presses, shown, frames;
    static string last = "waiting", node;
    static readonly Stopwatch lifetime = Stopwatch.StartNew();
    static int previewSeconds;
    static bool Expired
    {
        get
        {
            return quitting || (previewSeconds > 0 && lifetime.Elapsed.TotalSeconds >= previewSeconds);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PollFd
    {
        public int fd;
        public short events, revents;
    }

    struct Ev
    {
        public ushort type, code;
        public int value;
        public Ev(int t, int c, int v)
        {
            type = (ushort)t;
            code = (ushort)c;
            value = v;
        }
    }

    [DllImport("libc.so.6", SetLastError = true)]
    static extern int open(string name, int flags, int mode);
    [DllImport("libc.so.6")]
    static extern int close(int fd);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int flock(int fd, int op);
    [DllImport("libc.so.6", EntryPoint = "ioctl", SetLastError = true)]
    static extern int IoInt(int fd, uint code, int arg);
    [DllImport("libc.so.6", EntryPoint = "ioctl", SetLastError = true)]
    static extern int IoBytes(int fd, uint code, [In, Out] byte[] arg);
    [DllImport("libc.so.6", EntryPoint = "ioctl", SetLastError = true)]
    static extern int IoString(int fd, uint code, string arg);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern IntPtr read(int fd, [Out] byte[] data, UIntPtr count);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern IntPtr write(int fd, byte[] data, UIntPtr count);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int poll([In, Out] PollFd[] fds, uint count, int timeout);
    [DllImport("libc.so.6")]
    static extern int rename(string from, string to);
    static uint ReadCode(int n, int size)
    {
        return 0x80004500u | ((uint)size << 16) | (uint)n;
    }

    static bool Bit(byte[] mask, int bit)
    {
        return bit >= 0 && bit < mask.Length * 8 && (mask[bit / 8] & (1 << (bit % 8))) != 0;
    }

    static byte[] Query(int fd, int n, int size)
    {
        byte[] b = new byte[size];
        if (IoBytes(fd, ReadCode(n, size), b) < 0)
            throw new IOException("input-query-" + n);
        return b;
    }

    static void Require(int result, string operation)
    {
        if (result < 0)
            throw new IOException(operation + "-errno-" + Marshal.GetLastWin32Error());
    }

    static string Text(byte[] b)
    {
        return Encoding.UTF8.GetString(b).TrimEnd('\0');
    }

    static int Find()
    {
        for (int i = 0; i < 128; i++)
        {
            string path = "/dev/input/event" + i;
            int fd = open(path, NonBlock | CloseExec, 0);
            if (fd < 0)
                continue;
            try
            {
                byte[] id = Query(fd, 2, 8), location = new byte[128];
                IoBytes(fd, ReadCode(7, 128), location); // many Bluetooth devices have no phys string
                if (BitConverter.ToUInt16(id, 0) == 5 && BitConverter.ToUInt16(id, 2) == 0x2dc8 && BitConverter.ToUInt16(id, 4) == 0x6012 && Text(Query(fd, 6, 128)) == Name && Text(location) != Phys)
                {
                    node = path;
                    return fd;
                }
            }
            catch
            {
            }

            close(fd);
        }

        node = null;
        return -1;
    }

    static void Save(bool running)
    {
        try
        {
            string safe = last.Replace("\\", "_").Replace("\"", "_").Replace("\n", " ");
            File.WriteAllText(StatusPath + ".new", "{\"running\":" + (running ? "true" : "false") + ",\"connected\":" + (grabbed ? "true" : "false") + ",\"mode\":\"proxy\",\"preview\":" + (previewSeconds > 0 ? "true" : "false") + ",\"node\":\"" + (node ?? "") + "\",\"presses\":" + presses + ",\"emitted\":" + shown + ",\"frames\":" + frames + ",\"lastResult\":\"" + safe + "\"}");
            rename(StatusPath + ".new", StatusPath);
        }
        catch
        {
        }
    }

    static void Cleanup()
    {
        int fd = Interlocked.Exchange(ref physical, -1);
        grabbed = false;
        if (fd >= 0)
        {
            IoInt(fd, 0x40044590, 0);
            close(fd);
        }

        int ui = Interlocked.Exchange(ref output, -1);
        if (ui >= 0)
        {
            IoInt(ui, 0x5502, 0);
            close(ui);
        }
    }

    static bool LauncherRunning()
    {
        try
        {
            int pid = int.Parse(File.ReadAllText("/home/owner/tvlauncher.pid").Trim());
            return pid > 1 && File.ReadAllText("/proc/" + pid + "/cmdline").Contains("tvlauncher-dotnet.dll");
        }
        catch
        {
            return false;
        }
    }

    static bool Fifo(string command)
    {
        int fd = open("/home/owner/tvlauncher.fifo", 1 | NonBlock | CloseExec, 0);
        if (fd < 0)
            return false;
        try
        {
            byte[] b = Encoding.ASCII.GetBytes(command + "\n");
            return write(fd, b, (UIntPtr)b.Length).ToInt64() == b.Length;
        }
        finally
        {
            close(fd);
        }
    }

    static void Show()
    {
        presses++;
        if (!LauncherRunning())
        {
            last = "launcher-off";
            return;
        }

        // No Samsung Guide event is forwarded, so no Smart Hub close or timing race.
        if (Fifo("hide"))
        {
            Thread.Sleep(150);
            if (Fifo("show"))
            {
                shown++;
                last = "launcher-shown";
                Save(true);
                return;
            }
        }

        last = "show-error";
        Save(true);
    }

    static int Clone(byte[] keys, byte[] axes)
    {
        byte[] types = Query(physical, 0x20, 8);
        for (int i = 0; i < 64; i++)
            if (Bit(types, i) && i != 0 && i != 1 && i != 3 && i != 4)
                throw new IOException("unsupported-event-type-" + i);
        if (Bit(axes, 47))
            throw new IOException("multitouch-not-supported");
        int ui = open("/dev/uinput", 1 | NonBlock | CloseExec, 0);
        if (ui < 0)
            throw new IOException("uinput-open");
        bool ok = false;
        try
        {
            foreach (int type in new[]
            {
                1,
                3,
                4
            }

            )
                if (Bit(types, type))
                    Require(IoInt(ui, 0x40045564, type), "event-capability");
            for (int i = 0; i < 768; i++)
                if (Bit(keys, i))
                    Require(IoInt(ui, 0x40045565, i), "key-capability");
            byte[] msc = Query(physical, 0x24, 8);
            for (int i = 0; i < 64; i++)
                if (Bit(msc, i))
                    Require(IoInt(ui, 0x40045568, i), "msc-capability");
            byte[] props = Query(physical, 9, 8);
            for (int i = 0; i < 64; i++)
                if (Bit(props, i))
                    Require(IoInt(ui, 0x4004556e, i), "input-property");
            for (int i = 0; i < 64; i++)
                if (Bit(axes, i))
                {
                    Require(IoInt(ui, 0x40045567, i), "axis-capability");
                    byte[] setup = new byte[28];
                    setup[0] = (byte)i;
                    Array.Copy(Query(physical, 0x40 + i, 24), 0, setup, 4, 24);
                    Require(IoBytes(ui, 0x401c5504, setup), "axis-setup");
                }

            byte[] dev = new byte[92];
            Array.Copy(Query(physical, 2, 8), dev, 8);
            byte[] title = Encoding.ASCII.GetBytes(Name);
            Array.Copy(title, 0, dev, 8, title.Length);
            Require(IoBytes(ui, 0x405c5503, dev), "device-setup");
            Require(IoString(ui, 0x4004556c, Phys), "device-identity");
            Require(IoInt(ui, 0x5501, 0), "device-create");
            ok = true;
            return ui;
        }
        finally
        {
            if (!ok)
                close(ui);
        }
    }

    static byte[] Pack(List<Ev> events)
    {
        byte[] b = new byte[events.Count * 16];
        for (int i = 0; i < events.Count; i++)
        {
            int o = i * 16;
            Ev e = events[i];
            b[o + 8] = (byte)e.type;
            b[o + 9] = (byte)(e.type >> 8);
            b[o + 10] = (byte)e.code;
            b[o + 11] = (byte)(e.code >> 8);
            Array.Copy(BitConverter.GetBytes(e.value), 0, b, o + 12, 4);
        }

        return b;
    }

    static void Send(List<Ev> events)
    {
        if (events.Count == 0)
            return;
        byte[] b = Pack(events);
        long n = write(output, b, (UIntPtr)b.Length).ToInt64();
        if (n != b.Length)
            throw new IOException("proxy-write");
        frames++;
    }

    static bool Filter(Ev e, List<Ev> frame, ref bool held)
    {
        if (e.type == 1 && e.code == Guide)
        {
            if (frame.Count > 0 && frame[frame.Count - 1].type == 4 && frame[frame.Count - 1].code == 4)
                frame.RemoveAt(frame.Count - 1);
            if (e.value == 1)
                held = true;
            else if (e.value == 0 && held)
            {
                held = false;
                return true;
            }

            return false;
        }

        frame.Add(e);
        return false;
    }

    static bool Sync(byte[] keys, byte[] axes)
    {
        byte[] state = Query(physical, 0x18, 96);
        var frame = new List<Ev>();
        for (int i = 0; i < 768; i++)
            if (Bit(keys, i) && i != Guide)
                frame.Add(new Ev(1, i, Bit(state, i) ? 1 : 0));
        for (int i = 0; i < 64; i++)
            if (Bit(axes, i))
                frame.Add(new Ev(3, i, BitConverter.ToInt32(Query(physical, 0x40 + i, 24), 0)));
        frame.Add(new Ev(0, 0, 0));
        Send(frame);
        return Bit(state, Guide);
    }

    static void Route(byte[] keys, byte[] axes)
    {
        byte[] bytes = new byte[4096];
        // Clear pre-grab events; reconstruct the full current button/axis state.
        for (int i = 0; i < 32; i++)
            if (read(physical, bytes, (UIntPtr)bytes.Length).ToInt64() < 0)
                break;
        bool held = Sync(keys, axes), dropped = false, show = false;
        var frame = new List<Ev>();
        var check = Stopwatch.StartNew();
        var saved = Stopwatch.StartNew();
        PollFd[] p =
        {
            new PollFd
            {
                fd = physical,
                events = 1
            }
        };
        while (!Expired)
        {
            if (check.ElapsedMilliseconds > 2000)
            {
                if (!LauncherRunning())
                    return;
                check.Restart();
            }

            p[0].revents = 0;
            int n = poll(p, 1, 250);
            if (n < 0)
            {
                if (Marshal.GetLastWin32Error() == 4)
                    continue;
                return;
            }

            if (n == 0)
                continue;
            if ((p[0].revents & 0x38) != 0)
                return;
            long count = read(physical, bytes, (UIntPtr)bytes.Length).ToInt64();
            if (count < 0)
            {
                int err = Marshal.GetLastWin32Error();
                if (err == 4 || err == 11)
                    continue;
                return;
            }

            if (count == 0 || count % 16 != 0)
                return;
            for (int o = 0; o < count; o += 16)
            {
                Ev e = new Ev(BitConverter.ToUInt16(bytes, o + 8), BitConverter.ToUInt16(bytes, o + 10), BitConverter.ToInt32(bytes, o + 12));
                if (e.type == 0 && e.code == 3)
                {
                    dropped = true;
                    frame.Clear();
                    show = false;
                    continue;
                }

                if (dropped)
                {
                    if (e.type == 0 && e.code == 0)
                    {
                        held = Sync(keys, axes);
                        dropped = false;
                    }

                    continue;
                }

                show = Filter(e, frame, ref held) || show;
                if (e.type == 0 && e.code == 0)
                {
                    Send(frame);
                    frame.Clear();
                    if (show)
                    {
                        Show();
                        show = false;
                    }
                }

                if (frame.Count > 512)
                    throw new IOException("missing-input-sync");
            }

            if (saved.ElapsedMilliseconds > 2000)
            {
                Save(true);
                saved.Restart();
            }
        }
    }

    static int SelfTest()
    {
        bool held = false;
        var f = new List<Ev>();
        Filter(new Ev(4, 4, 0x90001), f, ref held);
        Filter(new Ev(1, 304, 1), f, ref held);
        Filter(new Ev(3, 0, -12345), f, ref held);
        Filter(new Ev(4, 4, 0x9000d), f, ref held);
        if (Filter(new Ev(1, Guide, 1), f, ref held))
            return 1;
        Filter(new Ev(1, Guide, 2), f, ref held);
        Filter(new Ev(4, 4, 0x9000d), f, ref held);
        if (!Filter(new Ev(1, Guide, 0), f, ref held))
            return 2;
        if (Filter(new Ev(1, Guide, 0), f, ref held))
            return 3;
        Filter(new Ev(1, 304, 0), f, ref held);
        Filter(new Ev(0, 0, 0), f, ref held);
        if (f.Count != 5 || f[0].value != 0x90001 || f[1].code != 304 || f[2].value != -12345 || f[3].value != 0 || f[4].type != 0)
            return 4;
        byte[] packed = Pack(f);
        if (packed.Length != 80 || BitConverter.ToInt32(packed, 44) != -12345)
            return 5;
        foreach (Ev e in f)
            if (e.type == 1 && e.code == Guide)
                return 6;
        Console.WriteLine("Guide/scancode suppression, mixed button+axis passthrough, press/repeat/release, and 32-bit framing checks passed");
        return 0;
    }

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--self-test")
            return SelfTest();
        if (IntPtr.Size != 4 || !BitConverter.IsLittleEndian)
        {
            Console.Error.WriteLine("This helper requires a 32-bit little-endian TV runtime.");
            return 2;
        }
        if (args.Length == 1 && args[0] == "--check-platform")
            return 0;
        if (args.Length > 0 && (args.Length != 2 || args[0] != "--preview-seconds" || !int.TryParse(args[1], out previewSeconds) || previewSeconds < 1 || previewSeconds > 300))
            return 2;
        int locked = open("/tmp/vetro-8bitdo-guide.lock", 2 | 0x40 | CloseExec, 384);
        if (locked < 0)
            return 1;
        if (flock(locked, 2 | 4) < 0)
        {
            close(locked);
            return 0;
        }

        AppDomain.CurrentDomain.ProcessExit += (s, e) =>
        {
            quitting = true;
            Cleanup();
            last = "stopped";
            Save(false);
        };
        try
        {
            Save(true);
            while (!Expired)
            {
                if (!LauncherRunning())
                {
                    last = "launcher-off";
                    Save(true);
                    Thread.Sleep(500);
                    continue;
                }

                physical = Find();
                if (physical < 0)
                {
                    last = "waiting";
                    Save(true);
                    Thread.Sleep(500);
                    continue;
                }

                try
                {
                    byte[] keys = Query(physical, 0x21, 96), axes = Query(physical, 0x23, 8);
                    output = Clone(keys, axes);
                    Thread.Sleep(1000);
                    if (Expired)
                        break;
                    Require(IoInt(physical, 0x40044590, 1), "controller-grab");
                    grabbed = true;
                    last = "ready";
                    Save(true);
                    Route(keys, axes);
                }
                catch (Exception e)
                {
                    last = e.Message;
                }
                finally
                {
                    Cleanup();
                    Save(true);
                }

                if (!Expired)
                    Thread.Sleep(1000);
            }

            return 0;
        }
        finally
        {
            Cleanup();
            last = previewSeconds > 0 ? "preview-ended" : "stopped";
            Save(false);
            close(locked);
        }
    }
}
