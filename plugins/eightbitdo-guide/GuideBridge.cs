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
    static string selectedName = Name;
    static StateFiles stateFiles;
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

    static bool MatchesController(ushort bus, ushort vendor, ushort product, string name, string physicalName)
    {
        return bus == 5 && vendor == 0x2dc8 && product == 0x6012
            && (name == Name || name == "8BitDo Ultimate") && physicalName != Phys;
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
                string deviceName = Text(Query(fd, 6, 128));
                if (MatchesController(BitConverter.ToUInt16(id, 0), BitConverter.ToUInt16(id, 2), BitConverter.ToUInt16(id, 4), deviceName, Text(location)))
                {
                    selectedName = deviceName;
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
            if (stateFiles != null)
                stateFiles.WriteStatus("{\"running\":" + (running ? "true" : "false") + ",\"connected\":" + (grabbed ? "true" : "false") + ",\"mode\":\"proxy\",\"preview\":" + (previewSeconds > 0 ? "true" : "false") + ",\"node\":\"" + (node ?? "") + "\",\"presses\":" + presses + ",\"emitted\":" + shown + ",\"frames\":" + frames + ",\"lastResult\":\"" + safe + "\"}");
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

    // Linux 4.1 uinput_user_dev: name[80], input_id[8], ff_effects_max,
    // then ABS_CNT=64 arrays: absmax, absmin, absfuzz, absflat.
    static byte[] LegacySetup(byte[] id, string name, Dictionary<int, byte[]> axes)
    {
        byte[] dev = new byte[1116];
        byte[] title = Encoding.ASCII.GetBytes(name);
        Array.Copy(title, 0, dev, 0, Math.Min(title.Length, 79));
        Array.Copy(id, 0, dev, 80, 8);
        foreach (var axis in axes)
        {
            Array.Copy(axis.Value, 8, dev, 92 + axis.Key * 4, 4);
            Array.Copy(axis.Value, 4, dev, 348 + axis.Key * 4, 4);
            Array.Copy(axis.Value, 12, dev, 604 + axis.Key * 4, 4);
            Array.Copy(axis.Value, 16, dev, 860 + axis.Key * 4, 4);
        }
        return dev;
    }

    static void SetLegacyAxes(int ui, Dictionary<int, byte[]> axes)
    {
        byte[] name = new byte[128];
        Require(IoBytes(ui, 0x8080552c, name), "legacy-sysname");
        string sysname = Text(name);
        int number;
        if (!sysname.StartsWith("input") || !int.TryParse(sysname.Substring(5), out number) || number < 0)
            throw new IOException("legacy-invalid-sysname");
        int fd = -1;
        for (int attempt = 0; attempt < 20 && fd < 0; attempt++)
        {
            foreach (string child in Directory.GetDirectories("/sys/class/input/" + sysname))
            {
                string leaf = Path.GetFileName(child);
                if (leaf.StartsWith("event") && int.TryParse(leaf.Substring(5), out number) && number >= 0)
                {
                    fd = open("/dev/input/" + leaf, 2 | NonBlock | CloseExec, 0);
                    if (fd >= 0) break;
                }
            }
            if (fd < 0) Thread.Sleep(50);
        }
        if (fd < 0) throw new IOException("legacy-evdev-open");
        try
        {
            foreach (var axis in axes)
            {
                // Configure only our newly created clone, never the physical pad.
                Require(IoBytes(fd, 0x401845c0u + (uint)axis.Key, axis.Value), "legacy-axis-calibration");
                byte[] actual = Query(fd, 0x40 + axis.Key, 24);
                for (int field = 4; field < 24; field += 4)
                    if (BitConverter.ToInt32(actual, field) != BitConverter.ToInt32(axis.Value, field))
                        throw new IOException("legacy-axis-calibration-mismatch");
            }
        }
        finally { close(fd); }
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
            byte[] version = new byte[4];
            Require(IoBytes(ui, 0x8004552d, version), "uinput-version");
            bool modern = BitConverter.ToUInt32(version, 0) >= 5;
            var axisInfo = new Dictionary<int, byte[]>();
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
                    byte[] info = Query(physical, 0x40 + i, 24);
                    axisInfo.Add(i, info);
                    if (modern)
                    {
                        byte[] setup = new byte[28];
                        setup[0] = (byte)i;
                        Array.Copy(info, 0, setup, 4, 24);
                        Require(IoBytes(ui, 0x401c5504, setup), "axis-setup");
                    }
                }

            byte[] id = Query(physical, 2, 8);
            if (modern)
            {
                byte[] dev = new byte[92];
                Array.Copy(id, dev, 8);
                byte[] title = Encoding.ASCII.GetBytes(selectedName);
                Array.Copy(title, 0, dev, 8, title.Length);
                Require(IoBytes(ui, 0x405c5503, dev), "device-setup");
            }
            else
            {
                byte[] dev = LegacySetup(id, selectedName, axisInfo);
                if (write(ui, dev, (UIntPtr)dev.Length).ToInt64() != dev.Length)
                    throw new IOException("legacy-device-setup");
            }
            Require(IoString(ui, 0x4004556c, Phys), "device-identity");
            Require(IoInt(ui, 0x5501, 0), "device-create");
            if (!modern)
            {
                SetLegacyAxes(ui, axisInfo);
                // Seed current axes before consumers enumerate the legacy clone.
                var initial = new List<Ev>();
                foreach (var axis in axisInfo)
                    initial.Add(new Ev(3, axis.Key, BitConverter.ToInt32(axis.Value, 0)));
                initial.Add(new Ev(0, 0, 0));
                byte[] packet = Pack(initial);
                if (write(ui, packet, (UIntPtr)packet.Length).ToInt64() != packet.Length)
                    throw new IOException("legacy-axis-initial-state");
            }
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
        if (!MatchesController(5, 0x2dc8, 0x6012, Name, "")
            || !MatchesController(5, 0x2dc8, 0x6012, "8BitDo Ultimate", "")
            || MatchesController(3, 0x2dc8, 0x6012, Name, "")
            || MatchesController(5, 0x045e, 0x6012, Name, "")
            || MatchesController(5, 0x2dc8, 0x6013, Name, "")
            || MatchesController(5, 0x2dc8, 0x6012, "Xbox Wireless Controller", "")
            || MatchesController(5, 0x2dc8, 0x6012, Name, Phys))
            return 7;
        Console.WriteLine("Both observed Bluetooth names accepted; wrong bus/IDs/name and proxy rejected");
        byte[] legacyId = { 5, 0, 0xc8, 0x2d, 0x12, 0x60, 0x11, 0 };
        byte[] info = new byte[24];
        Array.Copy(BitConverter.GetBytes(-32768), 0, info, 4, 4);
        Array.Copy(BitConverter.GetBytes(32767), 0, info, 8, 4);
        Array.Copy(BitConverter.GetBytes(16), 0, info, 12, 4);
        Array.Copy(BitConverter.GetBytes(128), 0, info, 16, 4);
        var legacyAxes = new Dictionary<int, byte[]> { { 0, info }, { 63, info } };
        byte[] legacy = LegacySetup(legacyId, "8BitDo Ultimate", legacyAxes);
        if (legacy.Length != 1116 || legacy[0] != (byte)'8'
            || BitConverter.ToUInt16(legacy, 80) != 5 || BitConverter.ToUInt16(legacy, 84) != 0x6012
            || BitConverter.ToInt32(legacy, 88) != 0
            || BitConverter.ToInt32(legacy, 92) != 32767 || BitConverter.ToInt32(legacy, 348) != -32768
            || BitConverter.ToInt32(legacy, 604) != 16 || BitConverter.ToInt32(legacy, 860) != 128
            || BitConverter.ToInt32(legacy, 1112) != 128)
            return 8;
        Console.WriteLine("Legacy uinput layout, signed axis ranges and fuzz/flat checks passed");
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
        if (args.Length == 1 && args[0] == "--self-test-files")
            return StateFiles.SelfTest();
        if (IntPtr.Size != 4 || !BitConverter.IsLittleEndian)
        {
            Console.Error.WriteLine("This helper requires a 32-bit little-endian TV runtime.");
            return 2;
        }

        if (args.Length == 1 && args[0] == "--check-platform")
            return 0;
        string statePath = null;
        bool statusOnly = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--state-dir" && i + 1 < args.Length)
                statePath = args[++i];
            else if (args[i] == "--status")
                statusOnly = true;
            else if (args[i] == "--preview-seconds" && i + 1 < args.Length)
            {
                if (!int.TryParse(args[++i], out previewSeconds) || previewSeconds < 1 || previewSeconds > 300)
                    return 2;
            }
            else
                return 2;
        }

        if (statePath == null || (statusOnly && previewSeconds != 0))
        {
            Console.Error.WriteLine("Pass --state-dir with the Shard's private runtime folder.");
            return 2;
        }

        int locked = -1;
        bool started = false, failed = false;
        try
        {
            stateFiles = StateFiles.Open(statePath);
            if (statusOnly)
            {
                Console.WriteLine(stateFiles.ReadStatus());
                return 0;
            }

            locked = stateFiles.OpenLock();
            if (flock(locked, 2 | 4) < 0)
                return 0;
            started = true;
            AppDomain.CurrentDomain.ProcessExit += (s, e) =>
            {
                quitting = true;
                Cleanup();
                last = "stopped";
                Save(false);
            };
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
        catch (Exception error)
        {
            failed = true;
            last = error.Message;
            Console.Error.WriteLine(last);
            return 1;
        }
        finally
        {
            Cleanup();
            if (started)
            {
                if (!failed)
                    last = previewSeconds > 0 ? "preview-ended" : "stopped";
                Save(false);
            }

            if (locked >= 0)
                close(locked);
            if (stateFiles != null)
                stateFiles.Dispose();
            stateFiles = null;
        }
    }
}
