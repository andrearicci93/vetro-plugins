using System;
using System.Runtime.InteropServices;

namespace VetroKeyboardHelper
{
    internal enum ChromaOrder
    {
        Nv12 = 0,
        Nv21 = 1
    }

    internal enum CaptureSubsampling
    {
        Yuv420 = 0,
        Yuv422 = 1
    }

    internal enum StructAbi
    {
        Auto = 0,
        Ilp32 = 1,
        Lp64Int = 2,
        Lp64SizeT = 3
    }

    internal sealed class CaptureBufferLayout
    {
        public StructAbi Abi { get; private set; }
        public string Name { get; private set; }
        public int StructSize { get; private set; }
        public int YLenOff { get; private set; }
        public int CLenOff { get; private set; }
        public int ActWOff { get; private set; }
        public int ActHOff { get; private set; }
        public int YPtrOff { get; private set; }
        public int CPtrOff { get; private set; }
        public bool LenIsPtrSized { get; private set; }

        private CaptureBufferLayout()
        {
        }

        public static StructAbi ParseAbi(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return StructAbi.Auto;
            string s = raw.Trim().ToLowerInvariant();
            if (s == "auto") return StructAbi.Auto;
            if (s == "ilp32" || s == "32") return StructAbi.Ilp32;
            if (s == "lp64-int" || s == "lp64") return StructAbi.Lp64Int;
            if (s == "lp64-sizet" || s == "lp64-size_t") return StructAbi.Lp64SizeT;
            throw new ArgumentException("Unknown ABI layout: " + raw);
        }

        public static ChromaOrder ParseChroma(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return ChromaOrder.Nv12;
            string s = raw.Trim().ToLowerInvariant();
            if (s == "nv12") return ChromaOrder.Nv12;
            if (s == "nv21") return ChromaOrder.Nv21;
            throw new ArgumentException("Unknown chroma order: " + raw);
        }

        public static CaptureBufferLayout GetLayout(StructAbi abi, int ptrSize)
        {
            StructAbi effective = abi;
            if (effective == StructAbi.Auto)
            {
                effective = (ptrSize == 4) ? StructAbi.Ilp32 : StructAbi.Lp64Int;
            }
            if (effective == StructAbi.Ilp32)
            {
                CaptureBufferLayout l32 = new CaptureBufferLayout();
                l32.Abi = StructAbi.Ilp32;
                l32.Name = "ilp32";
                l32.StructSize = 24;
                l32.YLenOff = 0;
                l32.CLenOff = 4;
                l32.ActWOff = 8;
                l32.ActHOff = 12;
                l32.YPtrOff = 16;
                l32.CPtrOff = 20;
                l32.LenIsPtrSized = false;
                return l32;
            }
            if (effective == StructAbi.Lp64Int)
            {
                CaptureBufferLayout l64i = new CaptureBufferLayout();
                l64i.Abi = StructAbi.Lp64Int;
                l64i.Name = "lp64-int";
                l64i.StructSize = 32;
                l64i.YLenOff = 0;
                l64i.CLenOff = 4;
                l64i.ActWOff = 8;
                l64i.ActHOff = 12;
                l64i.YPtrOff = 16;
                l64i.CPtrOff = 24;
                l64i.LenIsPtrSized = false;
                return l64i;
            }
            CaptureBufferLayout l64s = new CaptureBufferLayout();
            l64s.Abi = StructAbi.Lp64SizeT;
            l64s.Name = "lp64-sizet";
            l64s.StructSize = 40;
            l64s.YLenOff = 0;
            l64s.CLenOff = 8;
            l64s.ActWOff = 16;
            l64s.ActHOff = 20;
            l64s.YPtrOff = 24;
            l64s.CPtrOff = 32;
            l64s.LenIsPtrSized = true;
            return l64s;
        }
    }

    internal sealed class CapturedYuvFrame
    {
        public int Width;
        public int Height;
        public int YStride;
        public byte[] YPlane = new byte[0];
        public int YLength;
        public byte[] CPlane = new byte[0];
        public int CLength;
        public CaptureSubsampling Subsampling;
        public ChromaOrder ChromaOrder;
    }

    internal interface ICaptureBackend : IDisposable
    {
        string Name { get; }
        string AbiName { get; }
        bool TryCapture(int reqW, int reqH, ref CapturedYuvFrame frame, out string error);
    }

    internal static class NativeLibLoader
    {
        public static bool TryLoadAny(string[] candidates, out IntPtr handle, out string loadedFrom)
        {
            for (int i = 0; i < candidates.Length; i++)
            {
                IntPtr h;
                if (NativeLibrary.TryLoad(candidates[i], out h))
                {
                    handle = h;
                    loadedFrom = candidates[i];
                    return true;
                }
            }
            handle = IntPtr.Zero;
            loadedFrom = null;
            return false;
        }

        public static bool TryGetExportAny(IntPtr handle, string[] symbols, out IntPtr fnPtr, out string symbolName)
        {
            for (int i = 0; i < symbols.Length; i++)
            {
                IntPtr p;
                if (NativeLibrary.TryGetExport(handle, symbols[i], out p))
                {
                    fnPtr = p;
                    symbolName = symbols[i];
                    return true;
                }
            }
            fnPtr = IntPtr.Zero;
            symbolName = null;
            return false;
        }
    }

    internal sealed class SecVideoCaptureBackend : ICaptureBackend
    {
        public const int DefaultCaptureWidth = 720;
        public const int DefaultCaptureHeight = 576;
        private const int NativePlaneCapacity = 1920 * 1080 * 2;
        // Allocate generous 256-byte zeroed struct buffer because Samsung's capture library may write trailing driver metadata past offset 24.
        private const int CapStructAllocBytes = 256;

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int ApiCaptureScreenDelegate(int width, int height, IntPtr bufPtr);

        private static readonly string[] LibCandidates = new string[]
        {
            "libsec-video-capture.so.0",
            "/usr/lib/libsec-video-capture.so.0",
            "/usr/lib64/libsec-video-capture.so.0",
            "libsec-video-capture.so",
            "/usr/lib/libsec-video-capture.so",
            "/usr/lib64/libsec-video-capture.so"
        };

        private static readonly string[] SymbolCandidates = new string[]
        {
            "api_capture_screen",
            "secvideo_api_capture_screen"
        };

        private readonly IntPtr _libHandle;
        private readonly ApiCaptureScreenDelegate _captureFn;
        private readonly CaptureBufferLayout _layout;
        private readonly ChromaOrder _chromaOrder;
        private readonly string _loadedFrom;
        private readonly string _symbolName;
        private IntPtr _capStructPtr;
        private IntPtr _nativeYPtr;
        private IntPtr _nativeCPtr;
        private bool _disposed;

        public string Name { get { return "secvideo"; } }
        public string AbiName { get { return _layout.Name; } }
        public string LoadedFrom { get { return _loadedFrom; } }
        public string SymbolName { get { return _symbolName; } }

        private SecVideoCaptureBackend(
            IntPtr libHandle,
            ApiCaptureScreenDelegate captureFn,
            CaptureBufferLayout layout,
            ChromaOrder chromaOrder,
            string loadedFrom,
            string symbolName)
        {
            _libHandle = libHandle;
            _captureFn = captureFn;
            _layout = layout;
            _chromaOrder = chromaOrder;
            _loadedFrom = loadedFrom;
            _symbolName = symbolName;
            _capStructPtr = Marshal.AllocHGlobal(CapStructAllocBytes);
            _nativeYPtr = Marshal.AllocHGlobal(NativePlaneCapacity);
            _nativeCPtr = Marshal.AllocHGlobal(NativePlaneCapacity);
        }

        public static bool TryCreate(StructAbi abi, ChromaOrder chromaOrder, out SecVideoCaptureBackend backend, out string error)
        {
            backend = null;
            IntPtr libHandle;
            string loadedFrom;
            if (!NativeLibLoader.TryLoadAny(LibCandidates, out libHandle, out loadedFrom))
            {
                error = "libsec-video-capture.so.0 not found";
                return false;
            }

            IntPtr fnPtr;
            string symbolName;
            if (!NativeLibLoader.TryGetExportAny(libHandle, SymbolCandidates, out fnPtr, out symbolName))
            {
                NativeLibrary.Free(libHandle);
                error = "api_capture_screen symbol not found in " + loadedFrom;
                return false;
            }

            CaptureBufferLayout layout = CaptureBufferLayout.GetLayout(abi, IntPtr.Size);
            if ((IntPtr.Size == 4 && layout.LenIsPtrSized) ||
                (IntPtr.Size == 4 && layout.StructSize != 24))
            {
                NativeLibrary.Free(libHandle);
                error = "ABI " + layout.Name + " incompatible with 32-bit process";
                return false;
            }

            ApiCaptureScreenDelegate fn = Marshal.GetDelegateForFunctionPointer<ApiCaptureScreenDelegate>(fnPtr);
            backend = new SecVideoCaptureBackend(libHandle, fn, layout, chromaOrder, loadedFrom, symbolName);
            error = null;
            return true;
        }

        public static void ProbeAvailability(out bool libraryFound, out string loadedFrom, out bool symbolFound, out string symbolName)
        {
            IntPtr h;
            libraryFound = NativeLibLoader.TryLoadAny(LibCandidates, out h, out loadedFrom);
            symbolFound = false;
            symbolName = null;
            if (libraryFound)
            {
                IntPtr p;
                symbolFound = NativeLibLoader.TryGetExportAny(h, SymbolCandidates, out p, out symbolName);
                NativeLibrary.Free(h);
            }
        }

        private void PrepareCapBuffer(int reqW, int reqH)
        {
            int yLen = reqW * reqH;
            int cLen = yLen / 2;
            for (int i = 0; i < CapStructAllocBytes; i += 4)
            {
                Marshal.WriteInt32(_capStructPtr, i, 0);
            }
            if (_layout.LenIsPtrSized)
            {
                Marshal.WriteIntPtr(_capStructPtr, _layout.YLenOff, new IntPtr(yLen));
                Marshal.WriteIntPtr(_capStructPtr, _layout.CLenOff, new IntPtr(cLen));
            }
            else
            {
                Marshal.WriteInt32(_capStructPtr, _layout.YLenOff, yLen);
                Marshal.WriteInt32(_capStructPtr, _layout.CLenOff, cLen);
            }
            Marshal.WriteInt32(_capStructPtr, _layout.ActWOff, 0);
            Marshal.WriteInt32(_capStructPtr, _layout.ActHOff, 0);
            Marshal.WriteIntPtr(_capStructPtr, _layout.YPtrOff, _nativeYPtr);
            Marshal.WriteIntPtr(_capStructPtr, _layout.CPtrOff, _nativeCPtr);
        }

        public static bool TryComputeFrameGeometry(
            int reqW,
            int reqH,
            int allocYLen,
            int allocCLen,
            int rawW,
            int rawH,
            int reportedYLen,
            int reportedCLen,
            bool requireExplicitDims,
            out int actW,
            out int actH,
            out int yStride,
            out int yLen,
            out int cLen,
            out CaptureSubsampling subsamp)
        {
            actW = 0;
            actH = 0;
            yStride = 0;
            yLen = 0;
            cLen = 0;
            subsamp = CaptureSubsampling.Yuv420;

            bool rawValid = (rawW >= 64 && rawW <= 7680 && (rawW & 1) == 0 &&
                             rawH >= 64 && rawH <= 4320 && (rawH & 1) == 0);
            if (!rawValid && requireExplicitDims)
            {
                return false;
            }
            actW = rawValid ? rawW : reqW;
            actH = rawValid ? rawH : reqH;
            if (actW < 64 || actW > 7680 || actH < 64 || actH > 4320 || ((actW & 1) != 0) || ((actH & 1) != 0))
            {
                return false;
            }

            int minYLen = actW * actH;
            // Only treat struct length fields as driver-reported if the driver actually changed them from our input capacities.
            bool driverSetYLen = (reportedYLen != allocYLen) && (reportedYLen >= minYLen) && (reportedYLen <= NativePlaneCapacity);
            yLen = driverSetYLen ? reportedYLen : minYLen;
            if (yLen % actH == 0 && (yLen / actH) >= actW)
            {
                yStride = yLen / actH;
            }
            else
            {
                yStride = actW;
            }

            int expected422 = yStride * actH;
            int expected420 = (yStride * actH) / 2;
            bool driverSetCLen = (reportedCLen != allocCLen) && (reportedCLen >= expected420) && (reportedCLen <= NativePlaneCapacity);
            if (driverSetCLen && reportedCLen >= expected422)
            {
                subsamp = CaptureSubsampling.Yuv422;
                cLen = reportedCLen;
            }
            else
            {
                subsamp = CaptureSubsampling.Yuv420;
                cLen = driverSetCLen ? reportedCLen : expected420;
            }
            return true;
        }

        public bool TryCapture(int reqW, int reqH, ref CapturedYuvFrame frame, out string error)
        {
            if (_disposed)
            {
                error = "Backend disposed";
                return false;
            }

            // Clamp requests above Novatek hardware capture limits cleanly to full-frame 720x576 instead of partial height crop.
            int w = (reqW > DefaultCaptureWidth || reqH > DefaultCaptureHeight) ? DefaultCaptureWidth : ClampEven(reqW, 64, DefaultCaptureWidth);
            int h = (reqW > DefaultCaptureWidth || reqH > DefaultCaptureHeight) ? DefaultCaptureHeight : ClampEven(reqH, 64, DefaultCaptureHeight);
            int allocYLen = w * h;
            int allocCLen = allocYLen / 2;

            PrepareCapBuffer(w, h);
            int ret = _captureFn(w, h, _capStructPtr);
            if (ret != 0 && (w != DefaultCaptureWidth || h != DefaultCaptureHeight))
            {
                w = DefaultCaptureWidth;
                h = DefaultCaptureHeight;
                allocYLen = w * h;
                allocCLen = allocYLen / 2;
                PrepareCapBuffer(w, h);
                ret = _captureFn(w, h, _capStructPtr);
            }
            if (ret != 0)
            {
                error = _symbolName + " returned " + ret;
                return false;
            }

            int rawW = Marshal.ReadInt32(_capStructPtr, _layout.ActWOff);
            int rawH = Marshal.ReadInt32(_capStructPtr, _layout.ActHOff);
            int repYLen = _layout.LenIsPtrSized
                ? (int)Math.Min(NativePlaneCapacity, Math.Max(0, Marshal.ReadIntPtr(_capStructPtr, _layout.YLenOff).ToInt64()))
                : Marshal.ReadInt32(_capStructPtr, _layout.YLenOff);
            int repCLen = _layout.LenIsPtrSized
                ? (int)Math.Min(NativePlaneCapacity, Math.Max(0, Marshal.ReadIntPtr(_capStructPtr, _layout.CLenOff).ToInt64()))
                : Marshal.ReadInt32(_capStructPtr, _layout.CLenOff);

            IntPtr outYPtr = Marshal.ReadIntPtr(_capStructPtr, _layout.YPtrOff);
            IntPtr outCPtr = Marshal.ReadIntPtr(_capStructPtr, _layout.CPtrOff);
            if (outYPtr == IntPtr.Zero || outCPtr == IntPtr.Zero || outYPtr == outCPtr)
            {
                error = "Invalid plane pointers from capture ABI " + _layout.Name;
                return false;
            }

            int actW, actH, yStride, yLen, cLen;
            CaptureSubsampling subsamp;
            bool requireExplicit = (_layout.Abi != StructAbi.Ilp32);
            if (!TryComputeFrameGeometry(w, h, allocYLen, allocCLen, rawW, rawH, repYLen, repCLen, requireExplicit,
                out actW, out actH, out yStride, out yLen, out cLen, out subsamp))
            {
                error = "Invalid geometry raw=" + rawW + "x" + rawH + " for ABI " + _layout.Name;
                return false;
            }

            if (frame == null) frame = new CapturedYuvFrame();
            if (frame.YPlane.Length < yLen) frame.YPlane = new byte[yLen];
            if (frame.CPlane.Length < cLen) frame.CPlane = new byte[cLen];

            Marshal.Copy(outYPtr, frame.YPlane, 0, yLen);
            Marshal.Copy(outCPtr, frame.CPlane, 0, cLen);

            frame.Width = actW;
            frame.Height = actH;
            frame.YStride = yStride;
            frame.YLength = yLen;
            frame.CLength = cLen;
            frame.Subsampling = subsamp;
            frame.ChromaOrder = _chromaOrder;
            error = null;
            return true;
        }

        private static int ClampEven(int val, int minVal, int maxVal)
        {
            if (val < minVal) val = minVal;
            if (val > maxVal) val = maxVal;
            return val & ~1;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (_capStructPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(_capStructPtr);
                _capStructPtr = IntPtr.Zero;
            }
            if (_nativeYPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(_nativeYPtr);
                _nativeYPtr = IntPtr.Zero;
            }
            if (_nativeCPtr != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(_nativeCPtr);
                _nativeCPtr = IntPtr.Zero;
            }
            // Deliberately avoid dlclose on libsec-video-capture.so.0: Samsung's capture library can deadlock on unload; OS reclaims handles on process exit.
        }
    }

    internal sealed class TurboJpegEncoder : IDisposable
    {
        public const int TJSAMP_444 = 0;
        public const int TJSAMP_422 = 1;
        public const int TJSAMP_420 = 2;
        public const int TJPF_BGRX = 3;
        public const int TJFLAG_NOREALLOC = 1024;
        public const int TJFLAG_FASTDCT = 2048;

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr TjInitCompressDelegate();
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int TjDestroyDelegate(IntPtr handle);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate IntPtr TjAllocDelegate(int bytes);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate void TjFreeDelegate(IntPtr buffer);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate UIntPtr TjBufSizeDelegate(int width, int height, int jpegSubsamp);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int TjCompressFromYUVPlanesDelegate(
            IntPtr handle,
            IntPtr[] srcPlanes,
            int width,
            int[] strides,
            int height,
            int subsamp,
            ref IntPtr jpegBuf,
            ref UIntPtr jpegSize,
            int jpegQual,
            int flags);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        private delegate int TjCompress2Delegate(
            IntPtr handle,
            IntPtr srcBuf,
            int width,
            int pitch,
            int height,
            int pixelFormat,
            ref IntPtr jpegBuf,
            ref UIntPtr jpegSize,
            int jpegSubsamp,
            int jpegQual,
            int flags);

        private static readonly string[] LibCandidates = new string[]
        {
            "libturbojpeg.so.0",
            "/usr/lib/libturbojpeg.so.0",
            "/usr/lib64/libturbojpeg.so.0",
            "libturbojpeg.so",
            "/usr/lib/libturbojpeg.so",
            "/usr/lib64/libturbojpeg.so"
        };

        private readonly IntPtr _libHandle;
        private readonly IntPtr _tjHandle;
        private readonly TjDestroyDelegate _tjDestroy;
        private readonly TjAllocDelegate _tjAlloc;
        private readonly TjFreeDelegate _tjFree;
        private readonly TjBufSizeDelegate _tjBufSize;
        private readonly TjCompressFromYUVPlanesDelegate _tjCompressYuv;
        private readonly TjCompress2Delegate _tjCompress2;

        private IntPtr _outBuf;
        private uint _outBufCapacity;
        private byte[] _yFullPlane = new byte[0];
        private byte[] _uPlane = new byte[0];
        private byte[] _vPlane = new byte[0];
        private byte[] _jpegScratch = new byte[0];
        private readonly int[] _strides = new int[3];
        private readonly IntPtr[] _planes = new IntPtr[3];
        private bool _disposed;

        // Samsung libsec-video-capture outputs BT.709 studio/limited range (Y in [16..235], C in [16..240]); JFIF TurboJPEG expects BT.601 full [0..255].
        internal static readonly byte[] LumaLimToFull = BuildLumaLimToFullLut();
        private const double ChromaLimToFullScale = 255.0 / 224.0;
        private static readonly int[] Cb709ToY601Q8 = BuildLinearQ8Lut(0.101579 * ChromaLimToFullScale);
        private static readonly int[] Cr709ToY601Q8 = BuildLinearQ8Lut(0.196076 * ChromaLimToFullScale);
        private static readonly int[] Cb709ToCb601Q8 = BuildLinearQ8Lut(0.989854 * ChromaLimToFullScale);
        private static readonly int[] Cr709ToCb601Q8 = BuildLinearQ8Lut(-0.110653 * ChromaLimToFullScale);
        private static readonly int[] Cb709ToCr601Q8 = BuildLinearQ8Lut(-0.072452 * ChromaLimToFullScale);
        private static readonly int[] Cr709ToCr601Q8 = BuildLinearQ8Lut(0.983398 * ChromaLimToFullScale);

        private static int[] BuildLinearQ8Lut(double factor)
        {
            int[] lut = new int[256];
            double scaled = factor * 256.0;
            for (int i = 0; i < 256; i++)
            {
                lut[i] = (int)Math.Round(scaled * (i - 128));
            }
            return lut;
        }

        private static byte ClampByte(int v)
        {
            if (v <= 0) return 0;
            if (v >= 255) return 255;
            return (byte)v;
        }

        private static byte[] BuildLumaLimToFullLut()
        {
            byte[] lut = new byte[256];
            for (int i = 0; i < 256; i++)
            {
                int v = (int)Math.Round((i - 16) * 255.0 / 219.0);
                lut[i] = (byte)(v <= 0 ? 0 : (v >= 255 ? 255 : v));
            }
            return lut;
        }

        private TurboJpegEncoder(
            IntPtr libHandle,
            IntPtr tjHandle,
            TjDestroyDelegate tjDestroy,
            TjAllocDelegate tjAlloc,
            TjFreeDelegate tjFree,
            TjBufSizeDelegate tjBufSize,
            TjCompressFromYUVPlanesDelegate tjCompressYuv,
            TjCompress2Delegate tjCompress2)
        {
            _libHandle = libHandle;
            _tjHandle = tjHandle;
            _tjDestroy = tjDestroy;
            _tjAlloc = tjAlloc;
            _tjFree = tjFree;
            _tjBufSize = tjBufSize;
            _tjCompressYuv = tjCompressYuv;
            _tjCompress2 = tjCompress2;

            EnsureOutBuffer(1920, 1080);
        }

        public static bool TryCreate(out TurboJpegEncoder encoder, out string error)
        {
            encoder = null;
            IntPtr libHandle;
            string loadedFrom;
            if (!NativeLibLoader.TryLoadAny(LibCandidates, out libHandle, out loadedFrom))
            {
                error = "libturbojpeg.so.0 not found";
                return false;
            }

            IntPtr pInit, pDestroy, pAlloc, pFree, pBufSize, pCompYuv, pComp2;
            string sym;
            if (!NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjInitCompress" }, out pInit, out sym) ||
                !NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjDestroy" }, out pDestroy, out sym) ||
                !NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjAlloc" }, out pAlloc, out sym) ||
                !NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjFree" }, out pFree, out sym) ||
                !NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjBufSize" }, out pBufSize, out sym) ||
                !NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjCompressFromYUVPlanes" }, out pCompYuv, out sym) ||
                !NativeLibLoader.TryGetExportAny(libHandle, new string[] { "tjCompress2" }, out pComp2, out sym))
            {
                NativeLibrary.Free(libHandle);
                error = "Required TurboJPEG exports missing from " + loadedFrom;
                return false;
            }

            TjInitCompressDelegate fnInit = Marshal.GetDelegateForFunctionPointer<TjInitCompressDelegate>(pInit);
            IntPtr tjHandle = fnInit();
            if (tjHandle == IntPtr.Zero)
            {
                NativeLibrary.Free(libHandle);
                error = "tjInitCompress returned null";
                return false;
            }

            encoder = new TurboJpegEncoder(
                libHandle,
                tjHandle,
                Marshal.GetDelegateForFunctionPointer<TjDestroyDelegate>(pDestroy),
                Marshal.GetDelegateForFunctionPointer<TjAllocDelegate>(pAlloc),
                Marshal.GetDelegateForFunctionPointer<TjFreeDelegate>(pFree),
                Marshal.GetDelegateForFunctionPointer<TjBufSizeDelegate>(pBufSize),
                Marshal.GetDelegateForFunctionPointer<TjCompressFromYUVPlanesDelegate>(pCompYuv),
                Marshal.GetDelegateForFunctionPointer<TjCompress2Delegate>(pComp2));
            error = null;
            return true;
        }

        public static void ProbeAvailability(out bool libraryFound, out string loadedFrom, out bool symbolsFound)
        {
            IntPtr h;
            libraryFound = NativeLibLoader.TryLoadAny(LibCandidates, out h, out loadedFrom);
            symbolsFound = false;
            if (libraryFound)
            {
                IntPtr p;
                string sym;
                symbolsFound =
                    NativeLibLoader.TryGetExportAny(h, new string[] { "tjInitCompress" }, out p, out sym) &&
                    NativeLibLoader.TryGetExportAny(h, new string[] { "tjCompressFromYUVPlanes" }, out p, out sym) &&
                    NativeLibLoader.TryGetExportAny(h, new string[] { "tjCompress2" }, out p, out sym);
                NativeLibrary.Free(h);
            }
        }

        private void EnsureOutBuffer(int width, int height)
        {
            ulong needed = _tjBufSize(width, height, TJSAMP_444).ToUInt64();
            if (needed < 1024 * 1024) needed = 1024 * 1024;
            if (needed <= _outBufCapacity && _outBuf != IntPtr.Zero) return;

            uint cap = (uint)Math.Min(needed, 32UL * 1024UL * 1024UL);
            IntPtr next = _tjAlloc((int)cap);
            if (next == IntPtr.Zero) throw new OutOfMemoryException("tjAlloc failed for " + cap + " bytes");
            if (_outBuf != IntPtr.Zero) _tjFree(_outBuf);
            _outBuf = next;
            _outBufCapacity = cap;
        }

        public static void ConvertBt709LimitedToBt601Full(CapturedYuvFrame frame, byte[] yDst, byte[] uDst, byte[] vDst)
        {
            byte[] ySrc = frame.YPlane;
            byte[] cSrc = frame.CPlane;
            byte[] yLut = LumaLimToFull;
            int[] cbToY = Cb709ToY601Q8;
            int[] crToY = Cr709ToY601Q8;
            int[] cbToCb = Cb709ToCb601Q8;
            int[] crToCb = Cr709ToCb601Q8;
            int[] cbToCr = Cb709ToCr601Q8;
            int[] crToCr = Cr709ToCr601Q8;

            bool isNv21 = (frame.ChromaOrder == ChromaOrder.Nv21);
            bool is422 = (frame.Subsampling == CaptureSubsampling.Yuv422);
            int yStride = frame.YStride;
            int cStride = yStride / 2;
            int cRowBytes = cStride * 2;
            int cRows = is422 ? frame.Height : (frame.Height / 2);
            int yLen = frame.YLength;
            int cLen = frame.CLength;

            for (int cy = 0; cy < cRows; cy++)
            {
                int cSrcRow = cy * cRowBytes;
                int cDstRow = cy * cStride;
                int yRow0 = (is422 ? cy : (cy * 2)) * yStride;
                int yRow1 = is422 ? -1 : (yRow0 + yStride);

                for (int cx = 0; cx < cStride; cx++)
                {
                    int uvIdx = cSrcRow + (cx * 2);
                    if (uvIdx + 1 >= cLen) break;

                    byte c0 = cSrc[uvIdx];
                    byte c1 = cSrc[uvIdx + 1];
                    byte uRaw = isNv21 ? c1 : c0;
                    byte vRaw = isNv21 ? c0 : c1;

                    uDst[cDstRow + cx] = ClampByte(128 + ((cbToCb[uRaw] + crToCb[vRaw] + 128) >> 8));
                    vDst[cDstRow + cx] = ClampByte(128 + ((cbToCr[uRaw] + crToCr[vRaw] + 128) >> 8));

                    int yDelta = (cbToY[uRaw] + crToY[vRaw] + 128) >> 8;
                    int x0 = cx * 2;
                    int idx0 = yRow0 + x0;
                    if (idx0 + 1 < yLen)
                    {
                        yDst[idx0] = ClampByte(yLut[ySrc[idx0]] + yDelta);
                        yDst[idx0 + 1] = ClampByte(yLut[ySrc[idx0 + 1]] + yDelta);
                    }
                    else if (idx0 < yLen)
                    {
                        yDst[idx0] = ClampByte(yLut[ySrc[idx0]] + yDelta);
                    }

                    if (!is422)
                    {
                        int idx1 = yRow1 + x0;
                        if (idx1 + 1 < yLen)
                        {
                            yDst[idx1] = ClampByte(yLut[ySrc[idx1]] + yDelta);
                            yDst[idx1 + 1] = ClampByte(yLut[ySrc[idx1 + 1]] + yDelta);
                        }
                        else if (idx1 < yLen)
                        {
                            yDst[idx1] = ClampByte(yLut[ySrc[idx1]] + yDelta);
                        }
                    }
                }
            }
        }

        public bool TryEncodeYuv(CapturedYuvFrame frame, int quality, out byte[] jpegData, out int jpegLen)
        {
            jpegData = null;
            jpegLen = 0;
            if (_disposed || frame == null) return false;

            int q = Clamp(quality, 20, 95);
            EnsureOutBuffer(frame.Width, frame.Height);

            if (_yFullPlane.Length < frame.YLength) _yFullPlane = new byte[frame.YLength];
            int chromaLen = frame.CLength / 2;
            if (_uPlane.Length < chromaLen) _uPlane = new byte[chromaLen];
            if (_vPlane.Length < chromaLen) _vPlane = new byte[chromaLen];
            ConvertBt709LimitedToBt601Full(frame, _yFullPlane, _uPlane, _vPlane);

            int cStride = frame.YStride / 2;
            _strides[0] = frame.YStride;
            _strides[1] = cStride;
            _strides[2] = cStride;

            int tjSubsamp = (frame.Subsampling == CaptureSubsampling.Yuv422) ? TJSAMP_422 : TJSAMP_420;
            int flags = TJFLAG_NOREALLOC;
            if (q < 85) flags |= TJFLAG_FASTDCT;

            GCHandle hY = default(GCHandle);
            GCHandle hU = default(GCHandle);
            GCHandle hV = default(GCHandle);
            try
            {
                hY = GCHandle.Alloc(_yFullPlane, GCHandleType.Pinned);
                hU = GCHandle.Alloc(_uPlane, GCHandleType.Pinned);
                hV = GCHandle.Alloc(_vPlane, GCHandleType.Pinned);
                _planes[0] = hY.AddrOfPinnedObject();
                _planes[1] = hU.AddrOfPinnedObject();
                _planes[2] = hV.AddrOfPinnedObject();

                UIntPtr sz = new UIntPtr(_outBufCapacity);
                IntPtr outRef = _outBuf;
                int rc = _tjCompressYuv(_tjHandle, _planes, frame.Width, _strides, frame.Height, tjSubsamp,
                    ref outRef, ref sz, q, flags);
                ulong outLen = sz.ToUInt64();
                if (rc != 0 || outLen < 4 || outLen > _outBufCapacity) return false;

                jpegLen = (int)outLen;
                if (_jpegScratch.Length < jpegLen) _jpegScratch = new byte[jpegLen];
                Marshal.Copy(outRef, _jpegScratch, 0, jpegLen);
                jpegData = _jpegScratch;
                return true;
            }
            finally
            {
                if (hY.IsAllocated) hY.Free();
                if (hU.IsAllocated) hU.Free();
                if (hV.IsAllocated) hV.Free();
            }
        }

        public bool TryEncodeBgrx(byte[] bgra, int width, int height, int quality, out byte[] jpegData, out int jpegLen)
        {
            jpegData = null;
            jpegLen = 0;
            if (_disposed || bgra == null || bgra.Length < width * height * 4) return false;

            int q = Clamp(quality, 20, 95);
            EnsureOutBuffer(width, height);

            GCHandle hBgra = default(GCHandle);
            try
            {
                hBgra = GCHandle.Alloc(bgra, GCHandleType.Pinned);
                UIntPtr sz = new UIntPtr(_outBufCapacity);
                IntPtr outRef = _outBuf;
                int flags = TJFLAG_NOREALLOC;
                if (q < 85) flags |= TJFLAG_FASTDCT;

                int rc = _tjCompress2(_tjHandle, hBgra.AddrOfPinnedObject(), width, width * 4, height,
                    TJPF_BGRX, ref outRef, ref sz, TJSAMP_420, q, flags);
                ulong outLen = sz.ToUInt64();
                if (rc != 0 || outLen < 4 || outLen > _outBufCapacity) return false;

                jpegLen = (int)outLen;
                if (_jpegScratch.Length < jpegLen) _jpegScratch = new byte[jpegLen];
                Marshal.Copy(outRef, _jpegScratch, 0, jpegLen);
                jpegData = _jpegScratch;
                return true;
            }
            finally
            {
                if (hBgra.IsAllocated) hBgra.Free();
            }
        }

        private static int Clamp(int v, int lo, int hi)
        {
            if (v < lo) return lo;
            if (v > hi) return hi;
            return v;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            if (_outBuf != IntPtr.Zero)
            {
                _tjFree(_outBuf);
                _outBuf = IntPtr.Zero;
            }
            if (_tjHandle != IntPtr.Zero)
            {
                _tjDestroy(_tjHandle);
            }
            if (_libHandle != IntPtr.Zero)
            {
                NativeLibrary.Free(_libHandle);
            }
        }
    }

    internal static class CaptureBackendRegistry
    {
        public static bool TryCreateDefault(StructAbi abi, ChromaOrder chroma, out ICaptureBackend backend, out string error)
        {
            SecVideoCaptureBackend sec;
            bool ok = SecVideoCaptureBackend.TryCreate(abi, chroma, out sec, out error);
            backend = sec;
            return ok;
        }
    }
}
