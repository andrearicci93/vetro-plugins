using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace VetroKeyboardHelper
{
    internal static class Program
    {
        private const int HdWidth = 1920;
        private const int HdHeight = 1080;
        private const int MinFrameIntervalMs = 45; // Thermal safety floor (~22 FPS max)

        private static volatile bool _running = true;

        private static int Main(string[] args)
        {
            try
            {
                Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs e)
                {
                    e.Cancel = true;
                    _running = false;
                };

                string mode = null;
                int port = 0;
                int timeoutSec = 60;
                int quality = 92;
                string outPath = null;
                StructAbi abi = StructAbi.Auto;
                ChromaOrder chroma = ChromaOrder.Nv12;

                for (int i = 0; i < args.Length; i++)
                {
                    string a = args[i];
                    if (a == "--self-test" || a == "--check-platform" || a == "--probe" ||
                        a == "--serve" || a == "--oneshot-hd")
                    {
                        mode = a;
                    }
                    else if (a == "--port" && i + 1 < args.Length)
                    {
                        if (!int.TryParse(args[++i], out port) || port < 1 || port > 65535)
                        {
                            return FailJson("Invalid --port");
                        }
                    }
                    else if (a == "--timeout" && i + 1 < args.Length)
                    {
                        if (!int.TryParse(args[++i], out timeoutSec) || timeoutSec < 5 || timeoutSec > 3600)
                        {
                            return FailJson("Invalid --timeout");
                        }
                    }
                    else if (a == "--quality" && i + 1 < args.Length)
                    {
                        if (!int.TryParse(args[++i], out quality) || quality < 20 || quality > 95)
                        {
                            return FailJson("Invalid --quality");
                        }
                    }
                    else if (a == "--out" && i + 1 < args.Length)
                    {
                        outPath = args[++i];
                    }
                    else if (a == "--abi" && i + 1 < args.Length)
                    {
                        abi = CaptureBufferLayout.ParseAbi(args[++i]);
                    }
                    else if (a == "--chroma" && i + 1 < args.Length)
                    {
                        chroma = CaptureBufferLayout.ParseChroma(args[++i]);
                    }
                }

                if (mode == "--self-test") return RunSelfTest();
                if (mode == "--check-platform") return RunCheckPlatform();
                if (mode == "--probe") return FastExitIfLinux(RunProbe(abi, chroma));
                if (mode == "--oneshot-hd") return FastExitIfLinux(RunOneshotHd(outPath, quality, abi, chroma));
                if (mode == "--serve") return FastExitIfLinux(RunServe(port, timeoutSec, abi, chroma));

                Console.Error.WriteLine("Usage: hardware-streamer [--self-test | --check-platform | --probe | --serve --port P | --oneshot-hd --out FILE]");
                return 2;
            }
            catch (Exception ex)
            {
                return FailJson(ex.Message);
            }
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void LibcExitDelegate(int status);

        private static int FastExitIfLinux(int code)
        {
            try { Console.Out.Flush(); } catch { }
            try { Console.Error.Flush(); } catch { }
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                IntPtr h;
                string loadedFrom;
                if (NativeLibLoader.TryLoadAny(new string[] { "libc.so.6", "libc" }, out h, out loadedFrom))
                {
                    IntPtr pExit;
                    string sym;
                    if (NativeLibLoader.TryGetExportAny(h, new string[] { "_exit" }, out pExit, out sym))
                    {
                        LibcExitDelegate fn = Marshal.GetDelegateForFunctionPointer<LibcExitDelegate>(pExit);
                        fn(code);
                    }
                }
            }
            return code;
        }

        private static int FailJson(string reason)
        {
            Console.WriteLine("{\"ok\":false,\"reason\":\"" + EscapeJson(reason ?? "error") + "\"}");
            return 1;
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            StringBuilder sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char ch = s[i];
                if (ch == '\\') sb.Append("\\\\");
                else if (ch == '"') sb.Append("\\\"");
                else if (ch == '\r') sb.Append("\\r");
                else if (ch == '\n') sb.Append("\\n");
                else if (ch == '\t') sb.Append("\\t");
                else if (ch >= 32) sb.Append(ch);
            }
            return sb.ToString();
        }

        internal static void WriteBinaryFrameHeader(byte[] header8, int jpegLen, int width, int height)
        {
            header8[0] = (byte)((jpegLen >> 24) & 0xFF);
            header8[1] = (byte)((jpegLen >> 16) & 0xFF);
            header8[2] = (byte)((jpegLen >> 8) & 0xFF);
            header8[3] = (byte)(jpegLen & 0xFF);
            header8[4] = (byte)((width >> 8) & 0xFF);
            header8[5] = (byte)(width & 0xFF);
            header8[6] = (byte)((height >> 8) & 0xFF);
            header8[7] = (byte)(height & 0xFF);
        }

        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        private static byte ClampByte(int val)
        {
            if (val <= 0) return 0;
            if (val >= 255) return 255;
            return (byte)val;
        }

        internal static int CompositeWaylandWithHardware(byte[] bgra, int outW, int outH, CapturedYuvFrame hw)
        {
            if (bgra == null || hw == null || hw.Width < 2 || hw.Height < 2) return 0;
            int hwW = hw.Width;
            int hwH = hw.Height;
            int yStride = hw.YStride > 0 ? hw.YStride : hwW;
            int cw = hwW / 2;
            int ch = (hw.Subsampling == CaptureSubsampling.Yuv422) ? hwH : (hwH / 2);
            if (cw < 2 || ch < 2) return 0;

            int[] x0Lut = new int[outW];
            int[] x1Lut = new int[outW];
            int[] wxLut = new int[outW];
            int[] cx0Lut = new int[outW];
            int[] cx1Lut = new int[outW];
            int[] wcxLut = new int[outW];

            for (int x = 0; x < outW; x++)
            {
                int fxFp = ((x * (hwW - 1)) << 8) / (outW - 1);
                int lx0 = fxFp >> 8;
                x0Lut[x] = lx0;
                x1Lut[x] = (lx0 + 1 < hwW) ? (lx0 + 1) : (hwW - 1);
                wxLut[x] = fxFp & 0xFF;

                int fcxFp = ((x * (cw - 1)) << 8) / (outW - 1);
                int lcx = fcxFp >> 8;
                cx0Lut[x] = lcx * 2;
                cx1Lut[x] = ((lcx + 1 < cw) ? (lcx + 1) : (cw - 1)) * 2;
                wcxLut[x] = fcxFp & 0xFF;
            }

            bool isNv21 = (hw.ChromaOrder == ChromaOrder.Nv21);
            byte[] yPlane = hw.YPlane;
            byte[] cPlane = hw.CPlane;
            int blendedCount = 0;

            for (int y = 0; y < outH; y++)
            {
                int rowByteOffset = y * outW * 4;
                int fyFp = ((y * (hwH - 1)) << 8) / (outH - 1);
                int y0 = fyFp >> 8;
                int y1 = (y0 + 1 < hwH) ? (y0 + 1) : (hwH - 1);
                int wy = fyFp & 0xFF;
                int iwy = 256 - wy;
                int yRow0 = y0 * yStride;
                int yRow1 = y1 * yStride;

                int fcFp = ((y * (ch - 1)) << 8) / (outH - 1);
                int cy0 = fcFp >> 8;
                int cy1 = (cy0 + 1 < ch) ? (cy0 + 1) : (ch - 1);
                int wcy = fcFp & 0xFF;
                int iwcy = 256 - wcy;
                int cRow0 = cy0 * yStride;
                int cRow1 = cy1 * yStride;

                for (int x = 0; x < outW; x++)
                {
                    int byteIdx = rowByteOffset + x * 4;
                    byte a = bgra[byteIdx + 3];
                    if (a == 255) continue;

                    blendedCount++;
                    int wx = wxLut[x];
                    int iwx = 256 - wx;
                    int x0 = x0Lut[x];
                    int x1 = x1Lut[x];

                    int yTop = (yPlane[yRow0 + x0] * iwx + yPlane[yRow0 + x1] * wx) >> 8;
                    int yBot = (yPlane[yRow1 + x0] * iwx + yPlane[yRow1 + x1] * wx) >> 8;
                    int yVal = (yTop * iwy + yBot * wy) >> 8;

                    int wcx = wcxLut[x];
                    int iwcx = 256 - wcx;
                    int cx0 = cx0Lut[x];
                    int cx1 = cx1Lut[x];

                    int c0Top = (cPlane[cRow0 + cx0] * iwcx + cPlane[cRow0 + cx1] * wcx) >> 8;
                    int c0Bot = (cPlane[cRow1 + cx0] * iwcx + cPlane[cRow1 + cx1] * wcx) >> 8;
                    int c0Val = (c0Top * iwcy + c0Bot * wcy) >> 8;

                    int c1Top = (cPlane[cRow0 + cx0 + 1] * iwcx + cPlane[cRow0 + cx1 + 1] * wcx) >> 8;
                    int c1Bot = (cPlane[cRow1 + cx0 + 1] * iwcx + cPlane[cRow1 + cx1 + 1] * wcx) >> 8;
                    int c1Val = (c1Top * iwcy + c1Bot * wcy) >> 8;

                    int uVal = isNv21 ? c1Val : c0Val;
                    int vVal = isNv21 ? c0Val : c1Val;
                    // BT.709 Studio/Limited Range to RGB (matches Samsung libsec-video-capture HD output)
                    int cVal = 298 * (yVal - 16);
                    int d = uVal - 128;
                    int e = vVal - 128;
                    int vr = ClampByte((cVal + 459 * e + 128) >> 8);
                    int vg = ClampByte((cVal - 55 * d - 136 * e + 128) >> 8);
                    int vb = ClampByte((cVal + 541 * d + 128) >> 8);

                    if (a == 0)
                    {
                        bgra[byteIdx] = (byte)vb;
                        bgra[byteIdx + 1] = (byte)vg;
                        bgra[byteIdx + 2] = (byte)vr;
                        bgra[byteIdx + 3] = 255;
                    }
                    else
                    {
                        // Wayland SHM buffers use premultiplied alpha
                        int inv = 255 - a;
                        bgra[byteIdx] = ClampByte(bgra[byteIdx] + ((vb * inv + 127) / 255));
                        bgra[byteIdx + 1] = ClampByte(bgra[byteIdx + 1] + ((vg * inv + 127) / 255));
                        bgra[byteIdx + 2] = ClampByte(bgra[byteIdx + 2] + ((vr * inv + 127) / 255));
                        bgra[byteIdx + 3] = 255;
                    }
                }
            }
            return blendedCount;
        }

        private static byte[] _hdBgraBuf;

        private static bool TryReadWaylandBgraStdout(out byte[] bgra)
        {
            int expectedBytes = HdWidth * HdHeight * 4;
            if (_hdBgraBuf == null || _hdBgraBuf.Length != expectedBytes)
            {
                _hdBgraBuf = new byte[expectedBytes];
            }
            bgra = _hdBgraBuf;
            Process gstProc = null;
            Timer killTimer = null;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "/usr/bin/gst-launch-1.0",
                    Arguments = "-q waylandsrc num-buffers=1 ! video/x-raw,format=BGRA,width=" + HdWidth + ",height=" + HdHeight + " ! fdsink fd=1",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                psi.Environment["WAYLAND_DISPLAY"] = "wayland-0";
                psi.Environment["XDG_RUNTIME_DIR"] = "/run";
                gstProc = Process.Start(psi);
                if (gstProc == null) return false;
                Process startedProc = gstProc;
                killTimer = new Timer(delegate(object state)
                {
                    try { if (!startedProc.HasExited) startedProc.Kill(); } catch { }
                }, null, 4000, Timeout.Infinite);
                gstProc.BeginErrorReadLine();

                Stream stdout = gstProc.StandardOutput.BaseStream;
                int offset = 0;
                Stopwatch sw = Stopwatch.StartNew();
                while (offset < expectedBytes)
                {
                    if (sw.ElapsedMilliseconds > 4000)
                    {
                        try { gstProc.Kill(); } catch { }
                        return false;
                    }
                    int read = stdout.Read(bgra, offset, expectedBytes - offset);
                    if (read <= 0) break;
                    offset += read;
                }
                if (!gstProc.WaitForExit(1000))
                {
                    try { gstProc.Kill(); } catch { }
                }
                return offset == expectedBytes;
            }
            catch
            {
                if (gstProc != null)
                {
                    try { if (!gstProc.HasExited) gstProc.Kill(); } catch { }
                }
                return false;
            }
            finally
            {
                if (killTimer != null) killTimer.Dispose();
                if (gstProc != null) gstProc.Dispose();
            }
        }

        private static bool TryCaptureHdComposite(
            ICaptureBackend backend,
            TurboJpegEncoder encoder,
            int quality,
            ref CapturedYuvFrame hwFrame,
            out byte[] jpegBytes,
            out int jpegLen,
            out int outW,
            out int outH)
        {
            jpegBytes = null;
            jpegLen = 0;
            outW = HdWidth;
            outH = HdHeight;

            string hwErr;
            bool hwOk = backend.TryCapture(SecVideoCaptureBackend.DefaultCaptureWidth,
                SecVideoCaptureBackend.DefaultCaptureHeight, ref hwFrame, out hwErr);

            byte[] bgra;
            bool waylandOk = TryReadWaylandBgraStdout(out bgra);

            if (waylandOk)
            {
                if (hwOk) CompositeWaylandWithHardware(bgra, HdWidth, HdHeight, hwFrame);
                outW = HdWidth;
                outH = HdHeight;
                return encoder.TryEncodeBgrx(bgra, HdWidth, HdHeight, quality, out jpegBytes, out jpegLen);
            }

            if (hwOk)
            {
                outW = hwFrame.Width;
                outH = hwFrame.Height;
                return encoder.TryEncodeYuv(hwFrame, quality, out jpegBytes, out jpegLen);
            }

            return false;
        }

        private static bool CheckLumaVariance(byte[] yPlane, int yLen)
        {
            if (yPlane == null || yLen < 64) return false;
            byte minY = 255;
            byte maxY = 0;
            int step = Math.Max(1, yLen / 512);
            for (int i = 0; i < yLen; i += step)
            {
                byte v = yPlane[i];
                if (v < minY) minY = v;
                if (v > maxY) maxY = v;
            }
            return (maxY > 0) || (minY != maxY);
        }

        private static int RunCheckPlatform()
        {
            bool secLib, secSym, tjLib, tjSym;
            string secPath, secSymName, tjPath;
            SecVideoCaptureBackend.ProbeAvailability(out secLib, out secPath, out secSym, out secSymName);
            TurboJpegEncoder.ProbeAvailability(out tjLib, out tjPath, out tjSym);

            string json = "{"
                + "\"ok\":true"
                + ",\"arch\":\"" + EscapeJson(RuntimeInformation.OSArchitecture.ToString()) + "\""
                + ",\"ptrSize\":" + IntPtr.Size
                + ",\"endian\":\"" + (BitConverter.IsLittleEndian ? "little" : "big") + "\""
                + ",\"runtime\":\"" + EscapeJson(Environment.Version.ToString()) + "\""
                + ",\"secLib\":" + (secLib ? "true" : "false")
                + ",\"secPath\":\"" + EscapeJson(secPath ?? "") + "\""
                + ",\"secSym\":" + (secSym ? "true" : "false")
                + ",\"secSymName\":\"" + EscapeJson(secSymName ?? "") + "\""
                + ",\"tjLib\":" + (tjLib ? "true" : "false")
                + ",\"tjPath\":\"" + EscapeJson(tjPath ?? "") + "\""
                + ",\"tjSym\":" + (tjSym ? "true" : "false")
                + "}";
            Console.WriteLine(json);
            return 0;
        }

        private static int RunProbe(StructAbi abi, ChromaOrder chroma)
        {
            ICaptureBackend backend = null;
            TurboJpegEncoder encoder = null;
            try
            {
                string err;
                if (!CaptureBackendRegistry.TryCreateDefault(abi, chroma, out backend, out err))
                {
                    return FailJson(err);
                }
                if (!TurboJpegEncoder.TryCreate(out encoder, out err))
                {
                    return FailJson(err);
                }

                CapturedYuvFrame frame = new CapturedYuvFrame();
                if (!backend.TryCapture(SecVideoCaptureBackend.DefaultCaptureWidth,
                    SecVideoCaptureBackend.DefaultCaptureHeight, ref frame, out err))
                {
                    return FailJson(err ?? "capture_failed");
                }
                if (!CheckLumaVariance(frame.YPlane, frame.YLength))
                {
                    return FailJson("blank_zero_luma_buffer");
                }

                byte[] jpeg;
                int jpegLen;
                if (!encoder.TryEncodeYuv(frame, 70, out jpeg, out jpegLen) ||
                    jpegLen < 32 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 ||
                    jpeg[jpegLen - 2] != 0xFF || jpeg[jpegLen - 1] != 0xD9)
                {
                    return FailJson("invalid_jpeg_encode");
                }

                string subs = (frame.Subsampling == CaptureSubsampling.Yuv422) ? "422" : "420";
                string chromaName = (chroma == ChromaOrder.Nv21) ? "nv21" : "nv12";
                Console.WriteLine("{"
                    + "\"ok\":true"
                    + ",\"backend\":\"" + EscapeJson(backend.Name) + "\""
                    + ",\"abi\":\"" + EscapeJson(backend.AbiName) + "\""
                    + ",\"arch\":\"" + EscapeJson(RuntimeInformation.OSArchitecture.ToString()) + "\""
                    + ",\"ptrSize\":" + IntPtr.Size
                    + ",\"width\":" + frame.Width
                    + ",\"height\":" + frame.Height
                    + ",\"subsampling\":\"" + subs + "\""
                    + ",\"chroma\":\"" + chromaName + "\""
                    + ",\"jpegBytes\":" + jpegLen
                    + "}");
                return 0;
            }
            finally
            {
                if (encoder != null) encoder.Dispose();
                if (backend != null) backend.Dispose();
            }
        }

        internal static bool TryWriteNewFileAtomic(string outPath, byte[] data, int length, out string error)
        {
            error = null;
            if (string.IsNullOrEmpty(outPath))
            {
                error = "missing_out_path";
                return false;
            }
            if (File.Exists(outPath))
            {
                error = "output_exists";
                return false;
            }
            string tmpOut = outPath + ".new";
            bool createdTmp = false;
            try
            {
                // CreateNew maps to O_CREAT | O_EXCL on Linux, refusing pre-existing files and symlinks
                using (FileStream fs = new FileStream(tmpOut, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    createdTmp = true;
                    fs.Write(data, 0, length);
                }
                File.Move(tmpOut, outPath);
                createdTmp = false;
                return true;
            }
            catch (Exception ex)
            {
                error = "write_failed:" + ex.Message;
                return false;
            }
            finally
            {
                if (createdTmp)
                {
                    try
                    {
                        if (File.Exists(tmpOut)) File.Delete(tmpOut);
                    }
                    catch { }
                }
            }
        }

        private static int RunOneshotHd(string outPath, int quality, StructAbi abi, ChromaOrder chroma)
        {
            if (string.IsNullOrEmpty(outPath)) return FailJson("Missing --out");
            ICaptureBackend backend = null;
            TurboJpegEncoder encoder = null;
            try
            {
                string err;
                if (!CaptureBackendRegistry.TryCreateDefault(abi, chroma, out backend, out err)) return FailJson(err);
                if (!TurboJpegEncoder.TryCreate(out encoder, out err)) return FailJson(err);

                CapturedYuvFrame hwFrame = new CapturedYuvFrame();
                byte[] jpeg;
                int jpegLen, outW, outH;
                if (!TryCaptureHdComposite(backend, encoder, quality, ref hwFrame, out jpeg, out jpegLen, out outW, out outH))
                {
                    return FailJson("oneshot_hd_failed");
                }

                string writeErr;
                if (!TryWriteNewFileAtomic(outPath, jpeg, jpegLen, out writeErr))
                {
                    return FailJson(writeErr ?? "oneshot_write_failed");
                }
                Console.WriteLine("{\"ok\":true,\"width\":" + outW + ",\"height\":" + outH + ",\"bytes\":" + jpegLen + "}");
                return 0;
            }
            finally
            {
                if (encoder != null) encoder.Dispose();
                if (backend != null) backend.Dispose();
            }
        }

        private static readonly char[] SpaceSep = new char[] { ' ' };

        private static int RunServe(int port, int timeoutSec, StructAbi abi, ChromaOrder chroma)
        {
            if (port < 1 || port > 65535) return FailJson("Missing valid --port");

            ICaptureBackend backend = null;
            TurboJpegEncoder encoder = null;
            TcpClient client = null;
            try
            {
                string err;
                if (!CaptureBackendRegistry.TryCreateDefault(abi, chroma, out backend, out err)) return FailJson(err);
                if (!TurboJpegEncoder.TryCreate(out encoder, out err)) return FailJson(err);

                client = new TcpClient();
                client.NoDelay = true;
                client.Connect("127.0.0.1", port);
                client.ReceiveTimeout = timeoutSec * 1000;
                client.SendTimeout = 5000;

                string rawToken = Environment.GetEnvironmentVariable("VETRO_STREAM_TOKEN");
                string streamToken = string.IsNullOrEmpty(rawToken) ? null : rawToken.Trim();
                if (!string.IsNullOrEmpty(streamToken))
                {
                    for (int ti = 0; ti < streamToken.Length; ti++)
                    {
                        char c = streamToken[ti];
                        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '-'))
                        {
                            return FailJson("invalid_stream_token");
                        }
                    }
                }

                NetworkStream netStream = client.GetStream();
                string readyLine = string.IsNullOrEmpty(streamToken)
                    ? ("READY " + backend.Name + " " + backend.AbiName + "\n")
                    : ("READY " + streamToken + " " + backend.Name + " " + backend.AbiName + "\n");
                byte[] readyBytes = Encoding.ASCII.GetBytes(readyLine);
                netStream.Write(readyBytes, 0, readyBytes.Length);
                netStream.Flush();

                StreamReader reader = new StreamReader(netStream, Encoding.ASCII);
                CapturedYuvFrame hwFrame = new CapturedYuvFrame();
                byte[] sendBuf = new byte[256 * 1024];
                byte[] zeroHeader = new byte[8];
                Stopwatch paceWatch = Stopwatch.StartNew();
                long lastCapMs = -MinFrameIntervalMs;

                while (_running)
                {
                    string line;
                    try
                    {
                        line = reader.ReadLine();
                    }
                    catch
                    {
                        break;
                    }
                    if (line == null) break;
                    line = line.Trim();
                    if (line.Length == 0) continue;
                    if (line == "QUIT") break;

                    if (line.StartsWith("CAP ", StringComparison.Ordinal))
                    {
                        string[] parts = line.Split(SpaceSep, StringSplitOptions.RemoveEmptyEntries);
                        int reqW = (parts.Length >= 2) ? ParseClamped(parts[1], 64, 1920, 720) : 720;
                        int reqH = (parts.Length >= 3) ? ParseClamped(parts[2], 64, 1080, 576) : 576;
                        int q = (parts.Length >= 4) ? ParseClamped(parts[3], 20, 95, 55) : 55;

                        long elapsed = paceWatch.ElapsedMilliseconds - lastCapMs;
                        if (elapsed < MinFrameIntervalMs)
                        {
                            Thread.Sleep((int)(MinFrameIntervalMs - elapsed));
                        }
                        lastCapMs = paceWatch.ElapsedMilliseconds;

                        byte[] jpeg;
                        int jpegLen;
                        string capErr;
                        if (backend.TryCapture(reqW, reqH, ref hwFrame, out capErr) &&
                            encoder.TryEncodeYuv(hwFrame, q, out jpeg, out jpegLen) && jpegLen > 0)
                        {
                            int total = 8 + jpegLen;
                            if (sendBuf.Length < total) sendBuf = new byte[total];
                            WriteBinaryFrameHeader(sendBuf, jpegLen, hwFrame.Width, hwFrame.Height);
                            Buffer.BlockCopy(jpeg, 0, sendBuf, 8, jpegLen);
                            netStream.Write(sendBuf, 0, total);
                        }
                        else
                        {
                            netStream.Write(zeroHeader, 0, 8);
                        }
                        netStream.Flush();
                    }
                    else if (line.StartsWith("HD", StringComparison.Ordinal))
                    {
                        string[] parts = line.Split(SpaceSep, StringSplitOptions.RemoveEmptyEntries);
                        int q = (parts.Length >= 2) ? ParseClamped(parts[1], 20, 95, 92) : 92;

                        byte[] jpeg;
                        int jpegLen, outW, outH;
                        if (TryCaptureHdComposite(backend, encoder, q, ref hwFrame, out jpeg, out jpegLen, out outW, out outH) && jpegLen > 0)
                        {
                            int total = 8 + jpegLen;
                            if (sendBuf.Length < total) sendBuf = new byte[total];
                            WriteBinaryFrameHeader(sendBuf, jpegLen, outW, outH);
                            Buffer.BlockCopy(jpeg, 0, sendBuf, 8, jpegLen);
                            netStream.Write(sendBuf, 0, total);
                        }
                        else
                        {
                            netStream.Write(zeroHeader, 0, 8);
                        }
                        netStream.Flush();
                    }
                }
                return 0;
            }
            finally
            {
                if (client != null) client.Dispose();
                if (encoder != null) encoder.Dispose();
                if (backend != null) backend.Dispose();
            }
        }

        private static int ParseClamped(string s, int lo, int hi, int fallback)
        {
            int v;
            if (!int.TryParse(s, out v)) return fallback;
            if (v < lo) return lo;
            if (v > hi) return hi;
            return v;
        }

        private static void Assert(bool cond, string msg)
        {
            if (!cond) throw new Exception("Self-test failed: " + msg);
        }

        private static int RunSelfTest()
        {
            // 1. Struct layouts for 32-bit and 64-bit ABIs
            CaptureBufferLayout l32 = CaptureBufferLayout.GetLayout(StructAbi.Ilp32, 4);
            Assert(l32.StructSize == 24 && l32.YPtrOff == 16 && l32.CPtrOff == 20 && !l32.LenIsPtrSized, "Ilp32 layout");
            CaptureBufferLayout l64i = CaptureBufferLayout.GetLayout(StructAbi.Lp64Int, 8);
            Assert(l64i.StructSize == 32 && l64i.YPtrOff == 16 && l64i.CPtrOff == 24 && !l64i.LenIsPtrSized, "Lp64Int layout");
            CaptureBufferLayout l64s = CaptureBufferLayout.GetLayout(StructAbi.Lp64SizeT, 8);
            Assert(l64s.StructSize == 40 && l64s.CLenOff == 8 && l64s.ActWOff == 16 && l64s.YPtrOff == 24 && l64s.CPtrOff == 32 && l64s.LenIsPtrSized, "Lp64SizeT layout");

            // 2. Geometry & subsampling detection (including Novatek unchanged input buffer capacity + 4:2:2 padded stride)
            int aw, ah, ys, yl, cl;
            CaptureSubsampling sub;
            Assert(SecVideoCaptureBackend.TryComputeFrameGeometry(960, 540, 960 * 540, 960 * 540 / 2, 720, 540, 960 * 540, 960 * 540 / 2, false,
                out aw, out ah, out ys, out yl, out cl, out sub) && aw == 720 && ah == 540 && ys == 720 && yl == 720 * 540 && sub == CaptureSubsampling.Yuv420, "420 clamped width geom");
            Assert(SecVideoCaptureBackend.TryComputeFrameGeometry(720, 576, 720 * 576, 720 * 576 / 2, 720, 576, 768 * 576, 768 * 576, true,
                out aw, out ah, out ys, out yl, out cl, out sub) && ys == 768 && sub == CaptureSubsampling.Yuv422, "422 padded stride geom");
            Assert(!SecVideoCaptureBackend.TryComputeFrameGeometry(720, 576, 720 * 576, 720 * 576 / 2, 0, 0, 0, 0, true,
                out aw, out ah, out ys, out yl, out cl, out sub), "reject zero dims when strict");

            // 3. BT.709 Limited -> BT.601 Full conversion (NV12/NV21, YUV420/YUV422: green, red, black, white)
            Assert(TurboJpegEncoder.LumaLimToFull[16] == 0 && TurboJpegEncoder.LumaLimToFull[235] == 255 && TurboJpegEncoder.LumaLimToFull[126] == 128, "LumaLimToFull LUT");

            CapturedYuvFrame convFrame = new CapturedYuvFrame();
            convFrame.Width = 2;
            convFrame.Height = 2;
            convFrame.YStride = 2;
            convFrame.YLength = 4;
            convFrame.CLength = 2;
            convFrame.Subsampling = CaptureSubsampling.Yuv420;
            convFrame.ChromaOrder = ChromaOrder.Nv12;
            convFrame.YPlane = new byte[] { 173, 173, 173, 173 };
            convFrame.CPlane = new byte[] { 42, 26 };
            byte[] cyDst = new byte[4];
            byte[] cuDst = new byte[2];
            byte[] cvDst = new byte[2];
            TurboJpegEncoder.ConvertBt709LimitedToBt601Full(convFrame, cyDst, cuDst, cvDst);
            Assert(cyDst[0] >= 149 && cyDst[0] <= 152 && cuDst[0] >= 42 && cuDst[0] <= 46 && cvDst[0] >= 19 && cvDst[0] <= 23, "BT709->BT601 NV12 420 green");

            convFrame.ChromaOrder = ChromaOrder.Nv21;
            convFrame.CPlane = new byte[] { 26, 42 };
            TurboJpegEncoder.ConvertBt709LimitedToBt601Full(convFrame, cyDst, cuDst, cvDst);
            Assert(cyDst[0] >= 149 && cyDst[0] <= 152 && cuDst[0] >= 42 && cuDst[0] <= 46 && cvDst[0] >= 19 && cvDst[0] <= 23, "BT709->BT601 NV21 420 green");

            convFrame.Subsampling = CaptureSubsampling.Yuv422;
            convFrame.ChromaOrder = ChromaOrder.Nv12;
            convFrame.CLength = 4;
            convFrame.YPlane = new byte[] { 63, 63, 63, 63 };
            convFrame.CPlane = new byte[] { 102, 240, 102, 240 };
            TurboJpegEncoder.ConvertBt709LimitedToBt601Full(convFrame, cyDst, cuDst, cvDst);
            Assert(cyDst[0] >= 75 && cyDst[0] <= 78 && cyDst[2] == cyDst[0] && cuDst[1] >= 83 && cuDst[1] <= 87 && cvDst[1] >= 253, "BT709->BT601 422 red");

            convFrame.Subsampling = CaptureSubsampling.Yuv420;
            convFrame.CLength = 2;
            convFrame.YPlane = new byte[] { 16, 235, 16, 235 };
            convFrame.CPlane = new byte[] { 128, 128 };
            TurboJpegEncoder.ConvertBt709LimitedToBt601Full(convFrame, cyDst, cuDst, cvDst);
            Assert(cyDst[0] == 0 && cyDst[1] == 255 && cuDst[0] == 128 && cvDst[0] == 128, "BT709->BT601 black/white");

            // 4. 8-byte binary wire header roundtrip
            byte[] hdr = new byte[8];
            WriteBinaryFrameHeader(hdr, 0x010203, 1920, 1080);
            Assert(hdr[0] == 0x00 && hdr[1] == 0x01 && hdr[2] == 0x02 && hdr[3] == 0x03, "header length");
            Assert(((hdr[4] << 8) | hdr[5]) == 1920 && ((hdr[6] << 8) | hdr[7]) == 1080, "header dims");

            // 5. Alpha compositing BGRA over BT.709 limited-range YUV (Y=235 -> 255 full white, green -> ~0,255,0)
            CapturedYuvFrame hw = new CapturedYuvFrame();
            hw.Width = 4;
            hw.Height = 4;
            hw.YStride = 4;
            hw.YPlane = new byte[16];
            for (int i = 0; i < 16; i++) hw.YPlane[i] = 235;
            hw.CPlane = new byte[8];
            for (int i = 0; i < 8; i++) hw.CPlane[i] = 128;
            hw.Subsampling = CaptureSubsampling.Yuv420;
            hw.ChromaOrder = ChromaOrder.Nv12;

            byte[] bgra = new byte[4 * 4 * 4];
            // Pixel 0: alpha=0 (video hole -> limited Y=235 expands to 255 pure white)
            bgra[0] = 0; bgra[1] = 0; bgra[2] = 0; bgra[3] = 0;
            // Pixel 1: alpha=255 (opaque red UI -> stays exact red)
            bgra[4] = 10; bgra[5] = 20; bgra[6] = 250; bgra[7] = 255;
            int blended = CompositeWaylandWithHardware(bgra, 4, 4, hw);
            Assert(blended == 15, "composite blended count");
            Assert(bgra[0] == 255 && bgra[1] == 255 && bgra[2] == 255 && bgra[3] == 255, "transparent pixel shows video");
            Assert(bgra[4] == 10 && bgra[5] == 20 && bgra[6] == 250 && bgra[7] == 255, "opaque pixel preserved");

            for (int i = 0; i < 16; i++) hw.YPlane[i] = 173;
            for (int i = 0; i < 8; i += 2) { hw.CPlane[i] = 42; hw.CPlane[i + 1] = 26; }
            Array.Clear(bgra, 0, bgra.Length);
            CompositeWaylandWithHardware(bgra, 4, 4, hw);
            Assert(bgra[0] <= 2 && bgra[1] >= 253 && bgra[2] <= 2 && bgra[3] == 255, "BT709 composite pure green");

            // 6. Exclusive atomic file creation refuses pre-existing target and .new files
            string testDir = Path.Combine(Path.GetTempPath(), "vetro-hs-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(testDir);
            try
            {
                string target = Path.Combine(testDir, "shot.jpg");
                byte[] sample = new byte[] { 0xFF, 0xD8, 0xFF, 0xD9 };
                string wErr;
                Assert(TryWriteNewFileAtomic(target, sample, sample.Length, out wErr) && File.Exists(target), "atomic create succeeds");
                Assert(!TryWriteNewFileAtomic(target, sample, sample.Length, out wErr), "atomic create refuses existing target");

                string target2 = Path.Combine(testDir, "shot2.jpg");
                File.WriteAllBytes(target2 + ".new", sample);
                Assert(!TryWriteNewFileAtomic(target2, sample, sample.Length, out wErr), "atomic create refuses existing .new");
            }
            finally
            {
                try { Directory.Delete(testDir, true); } catch { }
            }

            Console.WriteLine("SELF_TEST_OK");
            return 0;
        }
    }
}
