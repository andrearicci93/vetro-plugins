using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

// Linux filesystem operations only; independent of the input-event ABI.
// A pinned private directory and openat/renameat avoid following state-file links.
internal sealed class StateFiles : IDisposable
{
    const int CloseExec = 0x80000;
    // ARM/ARM64 override these Linux flags (asm/fcntl.h); x86/x64 use generic values.
    static readonly bool Arm = RuntimeInformation.ProcessArchitecture == Architecture.Arm || RuntimeInformation.ProcessArchitecture == Architecture.Arm64;
    static readonly int NoFollow = Arm ? 0x8000 : 0x20000;
    static readonly int DirectoryOnly = Arm ? 0x4000 : 0x10000;
    const int NonBlock = 0x800, Create = 0x40, Exclusive = 0x80;
    int directory = -1;
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int open(string path, int flags, uint mode);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int openat(int dir, string path, int flags, uint mode);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int fchmod(int fd, uint mode);
    [DllImport("libc.so.6")]
    static extern int close(int fd);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern IntPtr read(int fd, byte[] data, UIntPtr count);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern IntPtr write(int fd, byte[] data, UIntPtr count);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int renameat(int oldDir, string oldName, int newDir, string newName);
    [DllImport("libc.so.6")]
    static extern int unlinkat(int dir, string name, int flags);
    [DllImport("libc.so.6", SetLastError = true)]
    static extern int symlink(string target, string name);
    static IOException Error(string operation)
    {
        return new IOException(operation + "-errno-" + Marshal.GetLastWin32Error());
    }

    public static StateFiles Open(string path)
    {
        if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path))
            throw new IOException("absolute-state-directory-required");
        int fd = open(path, DirectoryOnly | NoFollow | CloseExec, 0);
        if (fd < 0)
            throw Error("state-directory-open");
        try
        {
            // Operate on the pinned inode, never a path that could have been swapped.
            // Vetro owns this folder so its installer can still update/remove it.
            if (fchmod(fd, 448) < 0)
                throw Error("state-directory-private");
            return new StateFiles
            {
                directory = fd
            };
        }
        catch
        {
            close(fd);
            throw;
        }
    }

    public int OpenLock()
    {
        int fd = openat(directory, "guide.lock", 2 | Create | NoFollow | NonBlock | CloseExec, 384);
        if (fd < 0)
            throw Error("state-lock-open");
        return fd;
    }

    public void WriteStatus(string json)
    {
        string temporary = ".status-" + Guid.NewGuid().ToString("N");
        int fd = openat(directory, temporary, 1 | Create | Exclusive | NoFollow | CloseExec, 384);
        if (fd < 0)
            throw Error("state-status-create");
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            if (write(fd, bytes, (UIntPtr)bytes.Length).ToInt64() != bytes.Length)
                throw Error("state-status-write");
            close(fd);
            fd = -1;
            // Replaces a pre-existing symlink itself, rather than opening its target.
            if (renameat(directory, temporary, directory, "status.json") < 0)
                throw Error("state-status-rename");
        }
        finally
        {
            if (fd >= 0)
                close(fd);
            unlinkat(directory, temporary, 0);
        }
    }

    public string ReadStatus()
    {
        int fd = openat(directory, "status.json", NoFollow | NonBlock | CloseExec, 0);
        if (fd < 0)
        {
            if (Marshal.GetLastWin32Error() == 2)
                return "{}";
            throw Error("state-status-open");
        }

        try
        {
            byte[] bytes = new byte[8193];
            long count = read(fd, bytes, (UIntPtr)bytes.Length).ToInt64();
            if (count < 0 || count > 8192)
                throw Error("state-status-read");
            return Encoding.UTF8.GetString(bytes, 0, (int)count);
        }
        finally
        {
            close(fd);
        }
    }

    public void Dispose()
    {
        int fd = directory;
        directory = -1;
        if (fd >= 0)
            close(fd);
    }

    static void Reject(Action operation)
    {
        try
        {
            operation();
        }
        catch (IOException)
        {
            return;
        }

        throw new Exception("Unsafe state-file operation was accepted");
    }

    public static int SelfTest()
    {
        string root = Path.Combine(Path.GetTempPath(), "guide-files-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        string path = Path.Combine(root, "runtime"), victim = Path.Combine(root, "victim");
        Directory.CreateDirectory(path);
        File.WriteAllText(victim, "untouched");
        try
        {
            using (StateFiles files = Open(path))
            {
                string status = Path.Combine(path, "status.json"), locked = Path.Combine(path, "guide.lock");
                if (symlink(victim, status) < 0)
                    throw Error("test-link");
                Reject(() => files.ReadStatus());
                files.WriteStatus("{\"running\":true}");
                if (files.ReadStatus() != "{\"running\":true}" || File.ReadAllText(victim) != "untouched")
                    throw new Exception("Atomic state write followed a symlink");
                if (symlink(victim, locked) < 0)
                    throw Error("test-lock-link");
                Reject(() =>
                {
                    int fd = files.OpenLock();
                    close(fd);
                });
                File.Delete(locked);
                int normalLock = files.OpenLock();
                close(normalLock);
                string alias = Path.Combine(root, "alias");
                if (symlink(path, alias) < 0)
                    throw Error("test-directory-link");
                Reject(() =>
                {
                    using (StateFiles ignored = Open(alias))
                    {
                    }
                });
                File.Delete(alias);
                if (File.ReadAllText(victim) != "untouched")
                    throw new Exception("A link target was modified");
            }

            Console.WriteLine("Private state directory, atomic status writes, and directory/status/lock symlink refusal checks passed");
            return 0;
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
