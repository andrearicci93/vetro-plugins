using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;

// Update is called only by Main. A stop request stays latched until the old
// owner has exited, even if the next frame requests picture capture again.
internal sealed class PictureWorker
{
    private readonly Action<Func<bool>> capture;
    private readonly Action release;
    private System.Threading.Thread owner;
    private volatile bool stopRequested;
    internal PictureWorker(Action<Func<bool>> capture, Action release)
    {
        this.capture = capture;
        this.release = release;
    }
    internal void Update(bool wanted)
    {
        if (!wanted) stopRequested = true;
        if (owner != null)
        {
            if (!owner.Join(0)) return;
            owner = null;
        }
        if (!wanted) return;
        stopRequested = false;
        owner = new System.Threading.Thread(delegate() {
            try { capture(() => !stopRequested); }
            finally { release(); }
        }) { IsBackground = true };
        owner.Start();
    }
}

internal static class WledAmbiPpi
{
    [DllImport("libvconf.so.0", EntryPoint="vconf_get_int", CharSet=CharSet.Ansi)]
    private static extern int VconfGetInt(string key, out int value);
    [DllImport("libdl.so.2", EntryPoint = "dlopen", CharSet = CharSet.Ansi)]
    private static extern IntPtr dlopen(string filename, int flags);
    [DllImport("libdl.so.2", EntryPoint = "dlclose")]
    private static extern int dlclose(IntPtr handle);
    [DllImport("libdl.so.2", EntryPoint = "dlsym", CharSet = CharSet.Ansi)]
    private static extern IntPtr dlsym(IntPtr handle, string symbol);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int CondFn(IntPtr buf);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PosFn(int slot, int x, int y);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int PixFn(int slot, IntPtr buf);
    private static PosFn _pos; private static PixFn _pix;
    private static int _slots, _blkW, _blkH, _sleepMs, _fullW, _fullH;
    private static IntPtr _colBuf;
    private static bool _ppiReady, _ppiDead;

    private static bool PpiVeInit()
    {
        if (_ppiReady) return true;
        if (_ppiDead) return false;   // lib nao tem a API nessa firmware: tenta uma vez so
        IntPtr lib = dlopen("/usr/lib/libvideoenhance.so", 2);
        if (lib == IntPtr.Zero) lib = dlopen("libvideoenhance.so", 1);
        if (lib == IntPtr.Zero) { Console.WriteLine("ppiVe: dlopen fail"); return false; }
        IntPtr fc = dlsym(lib, "cs_ve_get_rgb_measure_condition");
        IntPtr fp = dlsym(lib, "cs_ve_set_rgb_measure_position");
        IntPtr fx = dlsym(lib, "cs_ve_get_rgb_measure_pixel");
        if (fc == IntPtr.Zero || fp == IntPtr.Zero || fx == IntPtr.Zero)
        { _ppiDead = true; try { dlclose(lib); } catch {} Console.WriteLine("ppiVe: dlsym fail (API ausente nesta firmware)"); return false; }
        IntPtr cb = Marshal.AllocHGlobal(256);
        Marshal.Copy(new byte[256], 0, cb, 256);
        int rc = Marshal.GetDelegateForFunctionPointer<CondFn>(fc)(cb);
        if (rc < 0) { Marshal.FreeHGlobal(cb); _ppiDead = true; try { dlclose(lib); } catch {} Console.WriteLine("ppiVe: cond rc=" + rc); return false; }
        _slots = Marshal.ReadInt32(cb, 0); _blkW = Marshal.ReadInt32(cb, 4);
        _blkH = Marshal.ReadInt32(cb, 8); _sleepMs = Marshal.ReadInt32(cb, 12);
        _fullW = Marshal.ReadInt32(cb, 16); _fullH = Marshal.ReadInt32(cb, 20);
        Marshal.FreeHGlobal(cb);
        if (_slots <= 0 || _fullW <= 0) { _ppiDead = true; try { dlclose(lib); } catch {} Console.WriteLine("ppiVe: bad cond"); return false; }
        if (_slots > 16) _slots = 16;
        if (_sleepMs < 1) _sleepMs = 20;
        _pos = Marshal.GetDelegateForFunctionPointer<PosFn>(fp);
        _pix = Marshal.GetDelegateForFunctionPointer<PixFn>(fx);
        _colBuf = Marshal.AllocHGlobal(256);
        _ppiReady = true;
        Console.WriteLine("ppiVe ready: slots=" + _slots + " block=" + _blkW + "x" + _blkH +
            " settle=" + _sleepMs + "ms full=" + _fullW + "x" + _fullH);
        return true;
    }

    // Test opposite borders on the uncropped panel. Keep the previous crop
    // through fades and require the same boundary on two different scan lines.
    private sealed class Border
    {
        private static readonly double[] Depth = {0.018, 0.065, 0.115, 0.155, 0.205, 0.255};
        public double Inset;
        private int depth, candidate = -1, votes, line;
        public void Probe(bool vertical)
        {
            double cross = line == 0 ? 0.36 : 0.64;
            int bright = 0, dark = 0;
            for (int first = 0; first < 2; first += _slots)
            {
                int count = Math.Min(_slots, 2 - first);
                for (int i = 0; i < count; i++)
                {
                    double pos = first+i == 0 ? Depth[depth] : 1-Depth[depth];
                    if (_pos(i,(int)((vertical ? cross : pos)*_fullW),(int)((vertical ? pos : cross)*_fullH)) < 0) return;
                }
                System.Threading.Thread.Sleep(_sleepMs);
                for (int i = 0; i < count; i++)
                {
                    if (_pix(i,_colBuf) < 0) return;
                    int peak = Math.Max(Marshal.ReadInt32(_colBuf),Math.Max(Marshal.ReadInt32(_colBuf,4),Marshal.ReadInt32(_colBuf,8))) >> 2;
                    if (peak <= 8) dark++;
                    if (peak >= 20) bright++;
                }
            }
            if (dark == 2 && depth+1 < Depth.Length) { depth++; return; }
            int observed = (depth == 0 ? bright > 0 : bright == 2) ? depth : -1;
            if (observed != candidate) { candidate = observed; votes = 0; }
            if (observed >= 0 && ++votes >= 2)
                Inset = observed == 0 ? 0 : Depth[observed];
            depth = 0;
            line ^= 1;
        }
    }
    private static readonly Border Rows = new Border(), Columns = new Border();

    private static readonly double[][] SpotFrac = new double[][] {
        new double[]{0.10,0.02}, new double[]{0.30,0.02}, new double[]{0.50,0.02}, new double[]{0.70,0.02}, new double[]{0.90,0.02},
        new double[]{0.98,0.15}, new double[]{0.98,0.50}, new double[]{0.98,0.85},
        new double[]{0.90,0.98}, new double[]{0.70,0.98}, new double[]{0.50,0.98}, new double[]{0.30,0.98}, new double[]{0.10,0.98},
        new double[]{0.02,0.85}, new double[]{0.02,0.50}, new double[]{0.02,0.15},
    };

    private static readonly int[] FullRegions = { 5, 3, 5, 3 };

    private static readonly int[] fallbackRgb = new int[SpotFrac.Length * 3];
    private static bool fallbackInitialized;
    private static volatile Tuning tuning = new Tuning();
    private static bool hdr;
    private static long pictureRecoveryUntil;
    private static string recoveryFile;
    private static readonly int[] FourSpots = {2,6,10,14};
    private static readonly int[] EightSpots = {1,3,5,7,9,11,13,15};
    private static readonly int[] FourRegions = {1,1,1,1}, EightRegions = {2,2,2,2};
    private static int ClampByte(int value) { return value < 0 ? 0 : value > 255 ? 255 : value; }
    private static void PpiVeFrame()
    {
        var config = tuning;
        int n = config.Fallback;
        int[] indices = n==4 ? FourSpots : n==8 ? EightSpots : null;
        int[] counts = n==4 ? FourRegions : n==8 ? EightRegions : FullRegions;
        var rgb = fallbackRgb;
        for (int base_ = 0; base_ < n; base_ += _slots)
        {
            int cnt = Math.Min(_slots, n - base_);
            for (int s = 0; s < cnt; s++)
            {
                int x = (int)((Columns.Inset + SpotFrac[indices == null ? base_ + s : indices[base_ + s]][0] * (1 - 2 * Columns.Inset)) * _fullW);
                int y = (int)((Rows.Inset + SpotFrac[indices == null ? base_ + s : indices[base_ + s]][1] * (1 - 2 * Rows.Inset)) * _fullH);
                if (_pos(s, x, y) < 0) throw new InvalidOperationException("Position unavailable");
            }
            System.Threading.Thread.Sleep(_sleepMs);
            for (int s = 0; s < cnt; s++)
            {
                Marshal.Copy(new byte[256], 0, _colBuf, 256);
                if (_pix(s, _colBuf) < 0) throw new InvalidOperationException("Color unavailable");
                {
                    int i = base_ + s;
                    rgb[i * 3] = ClampByte(Marshal.ReadInt32(_colBuf, 0) >> 2);   // 10-bit -> 8-bit
                    rgb[i * 3 + 1] = ClampByte(Marshal.ReadInt32(_colBuf, 4) >> 2);
                    rgb[i * 3 + 2] = ClampByte(Marshal.ReadInt32(_colBuf, 8) >> 2);
                }
            }
            if (base_ + cnt == n || fallbackInitialized) {
                var mapped = MapRegions(rgb, counts);
                if(config.SampleMode=="whole") ApplyWholeStrip(mapped);
                if(config.SampleMode=="side") ApplySides(mapped);
                if(config.SampleMode=="accent" || config.SampleMode=="highlight")
                    SelectSideSamples(mapped, config.SampleMode=="accent");
                Publish(mapped);
            }
        }
        fallbackInitialized = true;

    }

    private static byte[] MapRegions(int[] rgb, int[] spotN)
    {
        // Map the measured regions to their physical edge in strip order.
        var leds = new byte[LedCount * 3];
        int[] counts = { TopN, RightN, BottomN, LeftN };
        int sp = 0, li = 0;
        for (int e = 0; e < 4; e++)
        {
            for (int i = 0; i < counts[e]; i++)
            {
                int si = sp + Math.Min(spotN[e] - 1, i * spotN[e] / counts[e]);
                leds[li * 3] = (byte)rgb[si * 3]; leds[li * 3 + 1] = (byte)rgb[si * 3 + 1]; leds[li * 3 + 2] = (byte)rgb[si * 3 + 2];
                li++;
            }
            sp += spotN[e];
        }
        return leds;
    }

    private const int LedCount = TopN + RightN + BottomN + LeftN;
    private const int TopN = 172, RightN = 97, BottomN = 172, LeftN = 97;

    private static string frameStatus;
    private static uint pictureSignature;
    private static int pictureWidth, pictureHeight;
    private static int nativeWidth, nativeHeight;
    private static int[] sampleColumns, sampleRows;

    // Resolve only the pixels needed by the LED zones and black-bar detector.
    // Pixel centers on the smaller grid map to the nearest native luma sample.
    internal static int[] SampleAxis(int native, int requested)
    {
        int length = Math.Min(native, requested);
        var axis = new int[length];
        for (int i = 0; i < length; i++)
            axis[i] = (2 * i + 1) * native / (2 * length);
        return axis;
    }
    private static int zoneSampleFrame;
    private static double inputChroma, averagedChroma;
    private static double planeMilliseconds;

    private static bool TryReadSourceType(out int source)
    {
        source=0;
        try { return VconfGetInt("memory/system/source_type",out source)==0 && source>=0; }
        catch { return false; }
    }

    private static readonly PictureBorder PictureRows = new PictureBorder();
    private static readonly PictureBorder PictureColumns = new PictureBorder();

    private sealed class PictureBorder
    {
        private int candidate, votes;
        public int Inset { get; private set; }

        public void Reset() { candidate = votes = Inset = 0; }

        public unsafe void Scan(byte* luma, int stride, int[] along, int[] across, bool rows)
        {
            int length = along.Length;
            int observed = 0;
            for (int depth = 0; depth < length / 4; depth++)
            {
                int nearBright = 0, farBright = 0;
                for (int sample = 1; sample <= 15; sample++)
                {
                    int cross = across[sample * across.Length / 16];
                    int near = along[depth], far = along[length - 1 - depth];
                    if (luma[rows ? near * stride + cross : cross * stride + near] > 24) nearBright++;
                    if (luma[rows ? far * stride + cross : cross * stride + far] > 24) farBright++;
                }
                if (nearBright >= 4 || farBright >= 4)
                {
                    if (depth > 1 && (nearBright < 4 || farBright < 4)) return;
                    observed = depth <= 1 ? 0 : depth;
                    if (Math.Abs(candidate - observed) > 2) { candidate = observed; votes = 0; }
                    if (++votes >= 3) Inset = candidate;
                    return;
                }
            }
        }
    }

    private static unsafe bool ReadPlane()
    {
        var config = tuning;
        var frame = TizenAmbilight.VideoPlaneCapture.Capture();
        if (!frame.HasFrame || frame.RetWidth < 384 || frame.RetHeight < 216 || frame.RetWidth > 960 || frame.RetHeight > 540)
        {
            frameStatus = frame.Status;
            return false;
        }
        planeMilliseconds += frame.CaptureMs;
        int widthLimit = TizenAmbilight.VideoPlaneCapture.ReqW;
        int heightLimit = TizenAmbilight.VideoPlaneCapture.ReqH;
        if (nativeWidth != frame.W || nativeHeight != frame.H ||
            pictureWidth != Math.Min(frame.W, widthLimit) || pictureHeight != Math.Min(frame.H, heightLimit))
        {
            nativeWidth = frame.W;
            nativeHeight = frame.H;
            sampleColumns = SampleAxis(nativeWidth, widthLimit);
            sampleRows = SampleAxis(nativeHeight, heightLimit);
            pictureWidth = sampleColumns.Length;
            pictureHeight = sampleRows.Length;
            PictureRows.Reset();
            PictureColumns.Reset();
        }
        byte* luma = (byte*)TizenAmbilight.VideoPlaneCapture.LumaBuffer.ToPointer();
        byte* chroma = (byte*)TizenAmbilight.VideoPlaneCapture.ChromaBuffer.ToPointer();
        bool cropRows = config.Bars == "both" || config.Bars == "rows";
        bool cropColumns = config.Bars == "both" || config.Bars == "columns";
        if (cropRows) PictureRows.Scan(luma, frame.YStride, sampleRows, sampleColumns, true);
        if (cropColumns) PictureColumns.Scan(luma, frame.YStride, sampleColumns, sampleRows, false);
        int left = cropColumns ? Math.Min(PictureColumns.Inset, pictureWidth / 4) : 0;
        int top = cropRows ? Math.Min(PictureRows.Inset, pictureHeight / 4) : 0;
        int width = pictureWidth - 2 * left, height = pictureHeight - 2 * top;
        uint fingerprint = 2166136261;
        for (int j=0;j<frame.YStride*frame.H;j+=251)
            fingerprint = unchecked((fingerprint ^ luma[j])*16777619);
        for (int j=0;j<frame.CStride*frame.H/2;j+=251)
            fingerprint = unchecked((fingerprint ^ chroma[j])*16777619);
        pictureSignature = fingerprint;
        bool measure = (++zoneSampleFrame % 32 == 0);
        int effectiveZones = config.EffectiveZones;
        var zoneColors = new byte[effectiveZones * 3];
        var pixels = new byte[LedCount * 3];
        var sampleY = new int[4];
        var sampleU = new int[4];
        var sampleV = new int[4];
        long wholeY=0, wholeU=0, wholeV=0;
        for (int zone = 0; zone < effectiveZones; zone++)
        {
            int i = zone * LedCount / effectiveZones;
            bool horizontal = i < TopN || (i >= TopN + RightN && i < LedCount - LeftN);
            int x, y, dx = 0, dy = 0;
            if (i < TopN) { x = left + (2*i+1)*width/(2*TopN); y = top+1; dy = 1; }
            else if (i < TopN+RightN) { y = top+(2*(i-TopN)+1)*height/(2*RightN); x = left+width-2; dx = -1; }
            else if (horizontal) { x = left+width-1-(2*(i-TopN-RightN)+1)*width/(2*BottomN); y = top+height-2; dy = -1; }
            else { y = top+height-1-(2*(i-LedCount+LeftN)+1)*height/(2*LeftN); x = left+1; dx = 1; }
            int lum=0, u=0, v=0;
            for (int sample=0; sample<4; sample++)
            {
                int depth = sample*config.Depth/4;
                int px=sampleColumns[Math.Max(0,Math.Min(pictureWidth-1,x+dx*depth))];
                int py=sampleRows[Math.Max(0,Math.Min(pictureHeight-1,y+dy*depth))];
                int uv=(py/2)*frame.CStride+(px & ~1);
                int yValue=luma[py*frame.YStride+px];
                int uValue=chroma[uv], vValue=chroma[uv+1];
                sampleY[sample]=yValue;sampleU[sample]=uValue;sampleV[sample]=vValue;
                if (measure) inputChroma += Math.Sqrt((uValue-128)*(uValue-128)+(vValue-128)*(vValue-128));
            }
            AggregateSamples(config.SampleMode,sampleY,sampleU,sampleV,out lum,out u,out v);
            int l=298*(lum-64), cb=u-512, cr=v-512;
            if (measure) averagedChroma += Math.Sqrt(cb*cb+cr*cr);
            if(config.SampleMode=="whole") {
                wholeY+=lum; wholeU+=u; wholeV+=v;
                continue;
            }
            if (hdr)
            {
                // The reference patches established limited-range codes on this TV.
                int yy = Math.Max(0,Math.Min(255,(int)Math.Round((lum-64)*255.0/876)));
                int uu = 128+(int)Math.Round(cb*255.0/896);
                int vv = 128+(int)Math.Round(cr*255.0/896);
                TizenAmbilight.VideoPlaneCapture.YuvToRgb(yy,uu,vv,1,1,1,1,true,true,
                    out zoneColors[3*zone],out zoneColors[3*zone+1],out zoneColors[3*zone+2]);
            }
            else
            {
                zoneColors[3*zone]=Channel(l+459*cr);
                zoneColors[3*zone+1]=Channel(l-55*cb-136*cr);
                zoneColors[3*zone+2]=Channel(l+541*cb);
            }
        }
        if(config.SampleMode=="whole") {
            int lum=(int)((wholeY+effectiveZones/2)/effectiveZones);
            int u=(int)((wholeU+effectiveZones/2)/effectiveZones);
            int v=(int)((wholeV+effectiveZones/2)/effectiveZones);
            int l=298*(lum-64), cb=u-512, cr=v-512;
            byte red,green,blue;
            if(hdr) {
                int yy=Math.Max(0,Math.Min(255,(int)Math.Round((lum-64)*255.0/876)));
                int uu=128+(int)Math.Round(cb*255.0/896), vv=128+(int)Math.Round(cr*255.0/896);
                TizenAmbilight.VideoPlaneCapture.YuvToRgb(yy,uu,vv,1,1,1,1,true,true,out red,out green,out blue);
            } else {
                red=Channel(l+459*cr); green=Channel(l-55*cb-136*cr); blue=Channel(l+541*cb);
            }
            for(int i=0;i<LedCount;i++){pixels[i*3]=red;pixels[i*3+1]=green;pixels[i*3+2]=blue;}
            Publish(pixels);
            frameStatus=frame.W+"x"+frame.H+" video plane";
            return true;
        }
        for (int i=0;i<LedCount;i++)
        {
            int src = (i * effectiveZones / LedCount) * 3;
            pixels[3*i]=zoneColors[src];pixels[3*i+1]=zoneColors[src+1];pixels[3*i+2]=zoneColors[src+2];
        }
        if(config.SampleMode=="side") ApplySides(pixels);
        Publish(pixels);
        frameStatus = frame.W + "x" + frame.H + " video plane";
        return true;
    }

    private static void AggregateSamples(string sampleMode,int[] ys,int[] us,int[] vs,out int y,out int u,out int v)
    {
        bool accent = sampleMode == "accent";
        if (accent || sampleMode == "highlight")
        {
            int best = 0, bestScore = -1;
            for (int i = 0; i < ys.Length; i++) {
                int cb = us[i] - 128, cr = vs[i] - 128;
                int score = accent ? cb * cb + cr * cr : ys[i];
                if (score > bestScore) { bestScore = score; best = i; }
            }
            y = ys[best] * 4; u = us[best] * 4; v = vs[best] * 4;
            return;
        }
        if(sampleMode=="edge" || sampleMode=="inner")
        {
            int i=sampleMode=="edge"?0:3;
            y=ys[i]*4;u=us[i]*4;v=vs[i]*4;
            return;
        }
        if(sampleMode=="median")
        {
            y=Median4(ys[0],ys[1],ys[2],ys[3])*4;
            u=Median4(us[0],us[1],us[2],us[3])*4;
            v=Median4(vs[0],vs[1],vs[2],vs[3])*4;
            return;
        }
        if(sampleMode=="weighted")
        {
            y=(ys[0]*4+ys[1]*3+ys[2]*2+ys[3]+5)/10*4;
            u=(us[0]*4+us[1]*3+us[2]*2+us[3]+5)/10*4;
            v=(vs[0]*4+vs[1]*3+vs[2]*2+vs[3]+5)/10*4;
            return;
        }
        y=ys[0]+ys[1]+ys[2]+ys[3];
        u=us[0]+us[1]+us[2]+us[3];
        v=vs[0]+vs[1]+vs[2]+vs[3];
    }
    private static int Median4(int a,int b,int c,int d)
    {
        int low=Math.Min(Math.Min(a,b),Math.Min(c,d));
        int high=Math.Max(Math.Max(a,b),Math.Max(c,d));
        return (a+b+c+d-low-high+1)/2;
    }

    private static readonly int[] SideLengths = { TopN, RightN, BottomN, LeftN };
    // The fallback sampler has one depth per spot. Choose among spots on each side.
    private static void SelectSideSamples(byte[] pixels, bool accent)
    {
        int start = 0;
        foreach (int length in SideLengths) {
            int best = start, bestScore = -1;
            for (int i = start; i < start + length; i++) {
                int r = pixels[3*i], g = pixels[3*i+1], b = pixels[3*i+2];
                int score = accent ? Math.Max(r, Math.Max(g,b)) - Math.Min(r, Math.Min(g,b))
                                   : 54*r + 183*g + 19*b;
                if (score > bestScore) { bestScore = score; best = i; }
            }
            for (int i = start; i < start + length; i++)
                Buffer.BlockCopy(pixels, 3*best, pixels, 3*i, 3);
            start += length;
        }
    }
    private static void ApplySides(byte[] pixels)
    {
        int start = 0;
        foreach (int length in SideLengths) {
            for (int channel = 0; channel < 3; channel++) {
                int total = 0;
                for (int i = start; i < start + length; i++) total += pixels[3*i + channel];
                byte average = (byte)((total + length / 2) / length);
                for (int i = start; i < start + length; i++) pixels[3*i + channel] = average;
            }
            start += length;
        }
    }

    private static void ApplyWholeStrip(byte[] pixels)
    {
        int red=0,green=0,blue=0;
        for(int i=0;i<pixels.Length;i+=3){red+=pixels[i];green+=pixels[i+1];blue+=pixels[i+2];}
        int count=pixels.Length/3;
        byte r=(byte)((red+count/2)/count),g=(byte)((green+count/2)/count),b=(byte)((blue+count/2)/count);
        for(int i=0;i<pixels.Length;i+=3){pixels[i]=r;pixels[i+1]=g;pixels[i+2]=b;}
    }

    private static byte Channel(int scaled) { return (byte)Math.Max(0,Math.Min(255,(scaled+512)>>10)); }

    private sealed class SampledPicture
    {
        internal readonly byte[] Colors;
        internal readonly long Ready = Stopwatch.GetTimestamp();
        internal SampledPicture(byte[] colors) { Colors = colors; }
    }

    private static readonly object pictureLock = new object();
    private static volatile SampledPicture latest;
    private static volatile int meanSendDelayUs;

    private static void Publish(byte[] colors)
    {
        lock (pictureLock)
        {
            latest = new SampledPicture(colors);
            System.Threading.Monitor.Pulse(pictureLock);
        }
    }

    private static void WaitForPicture(SampledPicture rendered, int timeout)
    {
        lock (pictureLock)
        {
            if (latest == rendered) System.Threading.Monitor.Wait(pictureLock, timeout);
        }
    }
    private static string statusDir;

    internal static bool HasCaptureHeartbeat(string dir, DateTime? observedAt = null)
    {
        if (String.IsNullOrEmpty(dir)) return false;
        try
        {
            if ((File.GetAttributes(dir) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
                return false;
            var heartbeat = new FileInfo(Path.Combine(dir, "capture-heartbeat"));
            if (!heartbeat.Exists || (heartbeat.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0)
                return false;
            DateTime updated = heartbeat.LastWriteTimeUtc;
            double age = ((observedAt ?? DateTime.UtcNow) - updated).TotalSeconds;
            return age >= 0 && age <= 8;
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    internal static bool WriteRuntimeFile(string dir, string filename, string content)
    {
        if (String.IsNullOrEmpty(dir)) return false;
        try
        {
            var dirAttrs = System.IO.File.GetAttributes(dir);
            if ((dirAttrs & System.IO.FileAttributes.Directory) == 0 || (dirAttrs & System.IO.FileAttributes.ReparsePoint) != 0)
                return false;
            string target = System.IO.Path.Combine(dir, filename);
            if (System.IO.File.Exists(target) && (System.IO.File.GetAttributes(target) & System.IO.FileAttributes.ReparsePoint) != 0)
                return false;
            string tmp = System.IO.Path.Combine(dir, "." + filename + "." + Guid.NewGuid().ToString("N") + ".tmp");
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(content ?? "");
            try
            {
                using (var fs = new System.IO.FileStream(tmp, System.IO.FileMode.CreateNew, System.IO.FileAccess.Write, System.IO.FileShare.None))
                {
                    fs.Write(bytes, 0, bytes.Length);
                }
                System.IO.File.Move(tmp, target, true);
                return true;
            }
            catch
            {
                try { System.IO.File.Delete(tmp); } catch {}
                return false;
            }
        }
        catch (System.IO.IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }
    private static void WriteStatus(string status)
    {
        if (String.IsNullOrEmpty(statusDir)) statusDir = AppContext.BaseDirectory;
        WriteRuntimeFile(statusDir, "rate.txt", status);
    }
    private static void WritePreview(string preview)
    {
        if (String.IsNullOrEmpty(statusDir)) statusDir = AppContext.BaseDirectory;
        WriteRuntimeFile(statusDir, "preview.b64", preview);
    }

    private static bool WantsPicture(Tuning config) { return config.Lighting == "screen" || config.Lighting == "screen-audio"; }

    private static volatile bool samplerUnavailable;
    private static volatile bool pictureFrameReady;
    private static volatile string samplerFailure;
    private static void Capture(Func<bool> wanted)
    {
        bool ppiAvailable = PpiVeInit();
        int scans = 0, changed = 0, phase = 0;

        frameStatus = TizenAmbilight.VideoPlaneCapture.Init();
        bool available = frameStatus == null;
        if (!ppiAvailable && !available)
        {
            WriteStatus("Helper unavailable: neither full-picture nor TV video sampler API is supported");
            samplerUnavailable = true;
            return;
        }
        double deadline = 0;
        var uptime = Stopwatch.StartNew();
        double retryMs = 0, nextHdrRead = 0;
        string hdrFile = System.IO.Path.Combine(AppContext.BaseDirectory,"hdr-state");
        recoveryFile = System.IO.Path.Combine(AppContext.BaseDirectory,"picture-recovery-until");
        int consecutiveFailures = 0, planeErrors = 0, fallbackErrors = 0;
        int sourceType=0, candidateSource=0, candidateVotes=0, nativeReopens=0;
        bool haveSource=TryReadSourceType(out sourceType);
        double nextSourcePoll=0, nextRecoveryReset=0, nextInitRetry=0;
        double longestReadMs = 0;
        var window = Stopwatch.StartNew();
        while (wanted())
        {
            var previous = latest.Colors;
            double started = uptime.Elapsed.TotalMilliseconds;
            if(started>=nextSourcePoll) {
                int observed;
                if(TryReadSourceType(out observed)) {
                    if(!haveSource) { sourceType=observed; haveSource=true; candidateVotes=0; }
                    else if(observed==sourceType) candidateVotes=0;
                    else if(candidateVotes>0 && observed==candidateSource) {
                        candidateVotes++;
                        if(candidateVotes>=2) {
                            int previousSource=sourceType;
                            sourceType=observed; candidateVotes=0;
                            frameStatus=TizenAmbilight.VideoPlaneCapture.Reset();
                            available=frameStatus==null;
                            nativeReopens++;
                            nextRecoveryReset=started+15000;
                            nextInitRetry=started+5000;
                            consecutiveFailures=0; fallbackInitialized=false; retryMs=0;
                            Console.WriteLine("TV source changed "+previousSource+" -> "+sourceType+"; reopened video-plane capture: "+(frameStatus??"ready"));
                        }
                    } else { candidateSource=observed; candidateVotes=1; }
                }
                nextSourcePoll=started+250;
            }
            if(!available && started>=nextInitRetry) {
                frameStatus=TizenAmbilight.VideoPlaneCapture.Init();
                available=frameStatus==null;
                nextInitRetry=started+5000;
            }
            if (started >= nextHdrRead)
            {
                var old = tuning;
                tuning = Tuning.Read(old);
                if (old.Fallback != tuning.Fallback || old.EffectiveZones != tuning.EffectiveZones) fallbackInitialized = false;
                int captureWidth = tuning.CaptureWidth;
                TizenAmbilight.VideoPlaneCapture.SetRequestSize(captureWidth, captureWidth * 9 / 16);
                TizenAmbilight.VideoPlaneCapture.HdrPeakNits = tuning.Reference;
                try {
                    long recoveryDeadline;
                    if(long.TryParse(System.IO.File.ReadAllText(recoveryFile).Trim(),out recoveryDeadline))
                        pictureRecoveryUntil=recoveryDeadline;
                    else pictureRecoveryUntil=0;
                } catch(System.IO.IOException) { pictureRecoveryUntil=0; }
                try { hdr = System.IO.File.ReadAllText(hdrFile).Trim() == "1"; }
                catch (System.IO.IOException) {}
                if(tuning.Hdr!="auto") hdr=tuning.Hdr=="on";
                if(tuning.Bars=="off" || tuning.Bars=="columns") Rows.Inset=0;
                if(tuning.Bars=="off" || tuning.Bars=="rows") Columns.Inset=0;
                nextHdrRead = started + 1000;
            }
            uint oldSignature = pictureSignature;
            bool samplerOnly = tuning.Source=="sampler";
            bool attempt = !samplerOnly && available && started >= retryMs;
            bool full = attempt && ReadPlane();
            if (attempt)
            {
                longestReadMs = Math.Max(longestReadMs, uptime.Elapsed.TotalMilliseconds - started);
                if (full) {
                    pictureFrameReady = true;
                    samplerFailure = null;
                    consecutiveFailures = 0; fallbackInitialized = false;
                    if(pictureRecoveryUntil!=0) {
                        pictureRecoveryUntil=0;
                        try { System.IO.File.Delete(recoveryFile); } catch(System.IO.IOException) {}
                    }
                }
                else
                {
                    planeErrors++;
                    consecutiveFailures++;
                    if(consecutiveFailures>=3 && started>=nextRecoveryReset) {
                        frameStatus=TizenAmbilight.VideoPlaneCapture.Reset();
                        available=frameStatus==null;
                        nativeReopens++;
                        nextRecoveryReset=started+15000;
                        nextInitRetry=started+5000;
                        retryMs=uptime.Elapsed.TotalMilliseconds+500;
                        Console.WriteLine("video-plane recovery reopen "+nativeReopens+": "+(frameStatus??"ready"));
                    }
                    double delay = consecutiveFailures < 3 ? 0 : 500;
                    retryMs = uptime.Elapsed.TotalMilliseconds + delay;
                }
            }
            bool pictureRecovery = pictureRecoveryUntil > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            bool sampled = false;
            if (ppiAvailable && !full && (samplerOnly || (!pictureRecovery && (!available || consecutiveFailures >= 3))))
            {
                try { PpiVeFrame(); sampled=true; }
                catch (InvalidOperationException e) {
                    fallbackErrors++;
                    pictureFrameReady=false;
                    samplerFailure="TV color sampler failed: "+e.Message;
                }
                if(sampled) { pictureFrameReady=true; samplerFailure=null; }
            }
            else if(samplerOnly && !ppiAvailable)
            {
                pictureFrameReady=false;
                samplerFailure="TV color sampler unavailable: API unsupported";
            }
            bool difference = false;
            var colors = latest.Colors;
            for (int i = 0; i < colors.Length && !difference; i++)
                difference = colors[i] != previous[i];
            if (full ? oldSignature != pictureSignature : difference) changed++;
            if (ppiAvailable && !full && phase % 8 == 0 && (tuning.Bars=="both" || tuning.Bars=="rows")) Rows.Probe(true);
            if (ppiAvailable && !full && phase % 8 == 4 && (tuning.Bars=="both" || tuning.Bars=="columns")) Columns.Probe(false);
            phase = (phase + 1) % 8;
            deadline += 1000.0 / (full ? tuning.CaptureHz : 25);
            double remaining = deadline - uptime.Elapsed.TotalMilliseconds;
            if (remaining < -20) deadline = uptime.Elapsed.TotalMilliseconds;
            if (remaining > 0) System.Threading.Thread.Sleep((int)Math.Ceiling(remaining));
            scans++;
            if (window.ElapsedMilliseconds < 5000) continue;
            string status = String.Format("{0}, {1} slots at {2} ms, {7} regions, capture {3:F2}/s, changed {4:F2}/s, {8} output target, top/bottom inset {5:P1}, side inset {6:P1}, plane read {9:F1}ms",
                samplerOnly ? "Selected TV sampler" : frameStatus, _slots, _sleepMs, scans / window.Elapsed.TotalSeconds, changed / window.Elapsed.TotalSeconds, full ? (tuning.Bars=="both" || tuning.Bars=="rows" ? (double)PictureRows.Inset / pictureHeight : 0) : Rows.Inset, full ? (tuning.Bars=="both" || tuning.Bars=="columns" ? (double)PictureColumns.Inset / pictureWidth : 0) : Columns.Inset, full ? tuning.EffectiveZones : tuning.Fallback, tuning.SendHz, planeMilliseconds/scans);
            status += String.Format(", plane errors {0}, fallback errors {1}, longest read {2:F0} ms, UDP errors {3}",
                planeErrors, fallbackErrors, longestReadMs, System.Threading.Interlocked.CompareExchange(ref udpErrors,0,0));
            status += String.Format(", sample to UDP {0:F2} ms", meanSendDelayUs / 1000.0);
            if (full) status += String.Format(", sampling grid {0}x{1}", pictureWidth, pictureHeight);
            if (!samplerOnly) status += String.Format(", requested {0}x{1}", TizenAmbilight.VideoPlaneCapture.ReqW, TizenAmbilight.VideoPlaneCapture.ReqH);
            status += ", WLED " + tuning.Wled;
            status += ", TV input " + (haveSource ? sourceType.ToString() : "unknown") + ", capture reopens " + nativeReopens;
            if(samplerFailure!=null) status += ", " + samplerFailure + ", output suspended until a fresh frame";
            else status += full ? (hdr ? ", HDR10 PQ BT.2020" : ", SDR BT.709") : pictureRecovery ? ", trying full-picture recovery" : ", TV sampled RGB";
            status += ", saturation " + tuning.Saturation + "%, smoothing " + tuning.Smooth + " ms, sampling " + tuning.SampleMode;
            if (inputChroma > 0) status += String.Format(", zone chroma cancellation {0:F1}%",100*(1-averagedChroma/inputChroma));
            if (tuning.Lighting == "screen-audio") status += ", " + TvAudioCapture.Status(tuning);
            inputChroma = averagedChroma = 0;
            longestReadMs = 0;
            planeMilliseconds = 0;
            changed = 0;
            if (WantsPicture(tuning))
                WriteStatus(status);
            scans = 0;
            window.Restart();
        }
    }

    private static int Main(string[] args)
    {
        for(int i=0;i<args.Length;i++)
        {
            if(args[i]=="--check-platform") {
                if(IntPtr.Size!=4 || !BitConverter.IsLittleEndian) { Console.Error.WriteLine("32-bit little-endian runtime required"); return 2; }
                return 0;
            }
            if(args[i]=="--status-dir" && i+1<args.Length) statusDir=args[++i];
        }
        if(IntPtr.Size!=4 || !BitConverter.IsLittleEndian) { Console.Error.WriteLine("32-bit little-endian runtime required"); return 2; }
        if (!HasCaptureHeartbeat(statusDir))
        {
            Console.Error.WriteLine("Capture owner heartbeat missing or expired");
            return 1;
        }
        TvAudioCapture.Binding = new PlaybackBinding(statusDir);
        TvAudioCapture.PlaybackDevice("/proc/asound", TvAudioCapture.Binding);
        tuning = Tuning.Read(tuning);
        Publish(new byte[LedCount * 3]);
        var current = Array.ConvertAll(latest.Colors, value => (double)value);
        var picturePixels = new byte[current.Length];
        SampledPicture rendered = null, timed = null;
        long delayTicks = 0;
        int delayCount = 0;
        var delayWindow = Stopwatch.StartNew();
        var pixels = new byte[tuning.Leds * 3];
        Tuning mappedConfig = null;
        StripPixel[] layout = null;
        var clock = Stopwatch.StartNew();
        double nextPreview = 0;
        double previous = 0;
        double next = 0;
        double nextConfigRead = 0;
        double nextHeartbeatCheck = 0;
        var pictureWorker = new PictureWorker(Capture, TizenAmbilight.VideoPlaneCapture.Release);
        double nextAudioStatus = 0, nextAudioSourcePoll = 0;
        int activeAudioSource = -1, previousObservation = -1;
        double transitionStart = -1000;
        string lastLighting = null, lastReaction = null;
        var transitionFrom = new byte[pixels.Length];
        var pictureGain = new double[tuning.Leds];
        var gainFrom = new double[tuning.Leds];
        using (var udp = new UdpClient())
        {
            System.Net.IPEndPoint endpoint = null;
            string destination = null;
            while (true)
            {
                double now = clock.Elapsed.TotalMilliseconds;
                if (now >= nextHeartbeatCheck)
                {
                    if (!HasCaptureHeartbeat(statusDir))
                    {
                        TvAudioCapture.Update(false, tuning, false);
                        Console.Error.WriteLine("Capture owner heartbeat missing or expired");
                        return 0;
                    }
                    nextHeartbeatCheck = now + 250;
                }
                if (now >= nextConfigRead)
                {
                    tuning = Tuning.Read(tuning);
                    nextConfigRead = now + 200;
                }
                var config = tuning;
                if (config != mappedConfig)
                {
                    layout = MapStrip(config);
                    mappedConfig = config;
                    if (pixels.Length != config.Leds * 3)
                    {
                        pixels = new byte[config.Leds * 3];
                        transitionFrom = new byte[pixels.Length];
                        pictureGain = new double[config.Leds];
                        gainFrom = new double[config.Leds];
                        lastLighting = null;
                        transitionStart = now;
                    }
                }
                string reaction = config.AudioReaction;
                if (config.Lighting != lastLighting || reaction != lastReaction)
                {
                    if (config.Lighting == "screen-audio")
                    {
                        if (lastLighting == "screen-audio") Array.Copy(pictureGain, gainFrom, config.Leds);
                        else for (int i = 0; i < gainFrom.Length; i++) gainFrom[i] = 1;
                    }
                    else Buffer.BlockCopy(pixels, 0, transitionFrom, 0, pixels.Length);
                    transitionStart = now;
                    lastLighting = config.Lighting;
                    lastReaction = reaction;
                }
                double mix = Math.Min(1, (now - transitionStart) / 180);
                mix = mix * mix * (3 - 2 * mix);
                if (samplerUnavailable) return 1;
                pictureWorker.Update(config.HasTarget && WantsPicture(config));
                if (!config.HasTarget)
                {
                    TvAudioCapture.Update(false, config, false);
                    System.Threading.Thread.Sleep(250);
                    continue;
                }
                bool wantsAudio = config.Lighting == "tv-audio" || config.Lighting == "screen-audio";
                bool sourceChanged = false;
                if (wantsAudio && now >= nextAudioSourcePoll)
                {
                    nextAudioSourcePoll = now + 500;
                    int observed;
                    if (TryReadSourceType(out observed))
                    {
                        if (observed == previousObservation)
                        {
                            sourceChanged = activeAudioSource >= 0 && activeAudioSource != observed;
                            activeAudioSource = observed;
                        }
                        previousObservation = observed;
                    }
                }
                if (!wantsAudio) activeAudioSource = previousObservation = -1;
                var audio = TvAudioCapture.Update(wantsAudio, config, sourceChanged);
                if (config.Lighting != "screen" && config.Lighting != "tv-audio" && config.Lighting != "screen-audio")
                {
                    string effectStatus = "Effect active: " + config.Lighting;
                    WriteStatus(effectStatus);
                }
                if (config.Lighting == "tv-audio")
                {
                    RenderReaction(pixels, layout, now, config, audio, false);
                    config.ApplyAudio(pixels);
                    if (now >= nextAudioStatus)
                    {
                        WriteStatus("TV audio sync active, " + TvAudioCapture.Status(config));
                        nextAudioStatus = now + 1000;
                    }
                }
                else
                {
                    double blend = config.Smooth == 0 ? 1 : 1 - Math.Exp(-(now - previous) / config.Smooth);
                    previous = now;
                    rendered = latest;
                    var target = rendered.Colors;
                    if (config.Smooth == 0)
                    {
                        Buffer.BlockCopy(target, 0, picturePixels, 0, target.Length);
                        Array.Copy(target, current, target.Length);
                    }
                    else for (int i = 0; i < current.Length; i++)
                    {
                        current[i] += (target[i] - current[i]) * blend;
                        picturePixels[i] = (byte)Math.Round(current[i]);
                    }
                    config.Apply(picturePixels);
                    for (int i = 0; i < layout.Length; i++)
                    {
                        int sample = layout[i].PictureSample;
                        if (sample < 0) Array.Clear(pixels, i * 3, 3);
                        else Buffer.BlockCopy(picturePixels, sample * 3, pixels, i * 3, 3);
                    }
                    if (config.Lighting == "screen-audio")
                        RenderReaction(pixels, layout, now, config, audio, true, pictureGain, gainFrom, mix);
                }
                if (mix < 1 && config.Lighting != "screen-audio")
                {
                    for (int i = 0; i < pixels.Length; i++)
                        pixels[i] = (byte)Math.Round(transitionFrom[i] + mix * (pixels[i] - transitionFrom[i]));
                }
                int port = config.Protocol=="dnrgb" ? 21324 : 4048;
                try {
                    bool previewDue = now >= nextPreview;
                    byte[] preview = previewDue ? new byte[48 * 3] : null;
                    bool pictureReadyForOutput = !WantsPicture(config) || pictureFrameReady;
                    if (config.Wled != "127.0.0.1" && pictureReadyForOutput)
                    {
                        if (endpoint == null || destination != config.Wled || endpoint.Port != port)
                        {
                            endpoint = new System.Net.IPEndPoint(System.Net.IPAddress.Parse(config.Wled),port);
                            destination = config.Wled;
                        }
                        SendDdp(udp, endpoint, pixels, config, preview);
                        if (WantsPicture(config) && rendered != timed)
                        {
                            delayTicks += Stopwatch.GetTimestamp() - rendered.Ready;
                            delayCount++;
                            timed = rendered;
                            if (delayWindow.ElapsedMilliseconds >= 3000)
                            {
                                meanSendDelayUs = (int)(delayTicks * 1000000.0 / Stopwatch.Frequency / delayCount);
                                delayTicks = 0;
                                delayCount = 0;
                                delayWindow.Restart();
                            }
                        }
                    }
                    if (previewDue) {
                        nextPreview = now + 1000;
                        WritePreview(pictureReadyForOutput ? Convert.ToBase64String(preview) : "");
                    }
                }
                catch (SocketException) { System.Threading.Interlocked.Increment(ref udpErrors); }
                if (config.ImmediatePicture && WantsPicture(config))
                {
                    // A fresh picture wakes the sender. Timeouts still drive audio, smoothing and config reads.
                    double interval = config.Lighting == "screen" && config.Smooth == 0 && mix >= 1
                        ? 100 : 1000.0 / config.SendHz;
                    int timeout = (int)Math.Ceiling(now + interval - clock.Elapsed.TotalMilliseconds);
                    if (timeout > 0) WaitForPicture(rendered, timeout);
                    next = clock.Elapsed.TotalMilliseconds;
                    continue;
                }
                next += 1000.0 / config.SendHz;
                double remaining = next - clock.Elapsed.TotalMilliseconds;
                if (remaining > 0) System.Threading.Thread.Sleep((int)Math.Ceiling(remaining));
                else next = clock.Elapsed.TotalMilliseconds;
            }
        }
    }
    // Indexed in controller order, with coordinates in the installed TV layout.
    private struct StripPixel
    {
        public int PictureSample;
        public double RadialPosition;
        public double PerimeterPosition;
    }

    private static StripPixel[] MapStrip(Tuning config)
    {
        int[] counts = { config.TopCount, config.RightCount, config.BottomCount, config.LeftCount };
        bool?[] enabled = { config.Top, config.Right, config.Bottom, config.Left };
        int corner = config.StartCorner == "top-left" ? 0 :
            config.StartCorner == "top-right" ? counts[0] :
            config.StartCorner == "bottom-right" ? counts[0] + counts[1] : config.Leds - counts[3];
        bool reverse = config.Direction == "reverse";
        // Equal LED pitch makes opposite edge counts two estimates of one dimension.
        // A missing pair provides no estimate for that axis; use the TV aspect then.
        double width = MeanInstalledLength(config.TopCount, config.BottomCount);
        double height = MeanInstalledLength(config.RightCount, config.LeftCount);
        if (width == 0) width = height * 16 / 9;
        if (height == 0) height = width * 9 / 16;
        double nearestEdge = 0.5 * Math.Min(width, height);
        double cornerRadius = 0.5 * Math.Sqrt(width * width + height * height);
        var layout = new StripPixel[config.Leds];
        int logicalStart = 0, sampleStart = 0;
        for (int side = 0; side < counts.Length; side++)
        {
            for (int local = 0; local < counts[side]; local++)
            {
                int logical = logicalStart + local;
                int output = reverse ? corner + config.Offset - 1 - logical : logical - corner - config.Offset;
                output = ((output % config.Leds) + config.Leds) % config.Leds;
                double along = (local + 0.5) / counts[side];
                double x, y;
                switch (side)
                {
                    case 0: x = along; y = 0; break;
                    case 1: x = 1; y = along; break;
                    case 2: x = 1 - along; y = 1; break;
                    default: x = 0; y = 1 - along; break;
                }
                double dx = (x - 0.5) * width;
                double dy = (y - 0.5) * height;
                double radius = Math.Sqrt(dx * dx + dy * dy);
                layout[output].RadialPosition = (radius - nearestEdge) / (cornerRadius - nearestEdge);
                layout[output].PerimeterPosition = (logical + 0.5) / config.Leds;
                layout[output].PictureSample = enabled[side] == false ? -1 :
                    sampleStart + local * SideLengths[side] / counts[side];
            }
            logicalStart += counts[side];
            sampleStart += SideLengths[side];
        }
        return layout;
    }

    private static double MeanInstalledLength(int first, int opposite)
    {
        if (first == 0 || opposite == 0) return Math.Max(first, opposite);
        return (first + opposite) * 0.5;
    }

    // Feather just inside each band's outer radius. Outside it the mask is exactly zero.
    private static double BandCoverage(double front, double radialPosition)
    {
        double t = Math.Max(0, Math.Min(1, (front - radialPosition) / 0.10));
        return t * t * (3 - 2 * t);
    }

    private static void RenderReaction(byte[] pixels, StripPixel[] layout, double now, Tuning config, AudioAnalyzer.Frame audio, bool picture,
        double[] pictureGain = null, double[] gainFrom = null, double mix = 1)
    {
        if (picture && config.AudioBlend == 0)
        {
            for (int i = 0; i < layout.Length; i++) pictureGain[i] = 1;
            return; // The screen renderer already mapped the pixels and cleared disabled sides.
        }
        // Precompute position-independent values once per output frame.
        if (picture && config.AudioSampling != "impact")
        {
            // Frame is a value type. Only the picture renderer gets the extra contrast.
            double lift = 0.72 * audio.PictureAccent;
            // Beat flash can miss accents below the onset detector's trigger threshold.
            audio.Beat = Math.Max(audio.Beat, audio.PictureAccent * 0.85);
            audio.Level += (1 - audio.Level) * lift;
            audio.Ambient += (1 - audio.Ambient) * lift;
            audio.Bass += audio.Bass * (1 - audio.Bass) * lift;
            audio.Mid += audio.Mid * (1 - audio.Mid) * lift;
            audio.Treble += audio.Treble * (1 - audio.Treble) * lift;
        }
        double pulseFront = 0.10 + 1.02 * audio.Level;
        double beat = picture ? audio.Beat : Math.Sqrt(audio.Beat) * audio.Beat;
        double blend = config.AudioBlend / 100.0;
        double strength = blend * (1.5 - 0.5 * blend);
        bool intensityOnly = picture && config.AudioReaction == "intensity";
        // Follow accents more closely than the sustained bed.
        double brightness = intensityOnly ? 0.70 * audio.Level + 0.30 * (config.AudioSampling == "impact" ? audio.Beat : audio.PictureAccent) : 1;
        double bassFront = 1.12 * Math.Sqrt(audio.Bass);
        double midFront = 1.12 * Math.Sqrt(audio.Mid);
        double trebleFront = 1.12 * Math.Sqrt(audio.Treble);
        double activity = Math.Min(1, 10 * Math.Max(audio.Bass, Math.Max(audio.Mid, audio.Treble)));
        for (int i = 0; i < layout.Length; i++)
        {
            if (layout[i].PictureSample < 0)
            {
                Array.Clear(pixels, 3*i, 3);
                continue;
            }
            double radius = layout[i].RadialPosition;
            double amount, r, g, b;
            if (intensityOnly) { amount = brightness; r = g = b = 0; }
            else switch (config.AudioReaction)
            {
                case "pulse":
                    // Smooth the edge of a disk expanding from the center of the picture.
                    double cover = Math.Max(0, Math.Min(1, 0.5 + (pulseFront - radius) / 0.42));
                    amount = audio.Level * cover * cover * (3 - 2 * cover);
                    r = 42 * amount; g = 142 * amount; b = 172 * amount;
                    break;
                case "bass":
                    double wave = 0.5 + 0.5 * Math.Cos(4 * Math.PI * layout[i].PerimeterPosition - now / 650);
                    amount = audio.Bass * (0.20 + 0.80 * wave);
                    r = 24 * amount; g = 90 * amount; b = 145 * amount;
                    break;
                case "beat":
                    amount = beat;
                    r = 164 * amount; g = 196 * amount; b = 210 * amount;
                    break;
                case "ambient":
                    double glow = 0.5 + 0.5 * Math.Cos(2 * Math.PI * layout[i].PerimeterPosition - now / 2100);
                    amount = audio.Ambient * (0.12 + 0.88 * glow * glow);
                    r = 26 * amount; g = 112 * amount; b = 136 * amount;
                    break;
                default:
                    // Three concentric bands share the physical screen center.
                    double lowMask = BandCoverage(bassFront, radius);
                    double midMask = BandCoverage(midFront, radius);
                    double highMask = BandCoverage(trebleFront, radius);
                    amount = activity * Math.Max(lowMask, Math.Max(midMask, highMask));
                    double low = audio.Bass * lowMask;
                    double mid = audio.Mid * midMask;
                    double high = audio.Treble * highMask;
                    double scale = 1 / Math.Max(1, low + mid + high);
                    r = (55*low + 42*mid + 145*high) * scale;
                    g = (78*low + 148*mid + 177*high) * scale;
                    b = (126*low + 137*mid + 180*high) * scale;
                    break;
            }
            int j = 3*i;
            if (picture)
            {
                r = pixels[j]; g = pixels[j+1]; b = pixels[j+2];
                // At full blend, reveal only the area covered by the reaction.
                double gain = CombinedGain(amount, blend, strength);
                if (strength > 0 && mix < 1) gain = gainFrom[i] + (gain - gainFrom[i]) * mix;
                pictureGain[i] = gain;
                r *= gain; g *= gain; b *= gain;
            }
            pixels[j] = (byte)Math.Round(r);
            pixels[j+1] = (byte)Math.Round(g);
            pixels[j+2] = (byte)Math.Round(b);
        }
    }
    internal static double CombinedGain(double amount, double blend, double strength)
    {
        // At the upper end a moderate accent can reveal the full sampled color.
        // The soft knee preserves gradation below the peak and leaves silence dark.
        double x = Math.Min(1, amount / 0.55);
        double vivid = x * x * (3 - 2 * x);
        double response = amount + blend * blend * (vivid - amount);
        return 1 - strength * (1 - response);
    }
    private static int udpErrors;
    private static byte sequence = 1;

    private static void SendDdp(UdpClient udp, System.Net.IPEndPoint endpoint, byte[] rgb, Tuning config, byte[] preview)
    {
        const int ChannelsPerPacket = 1440;
        for (int offset = 0; offset < config.Leds * 3; offset += ChannelsPerPacket)
        {
            int count = Math.Min(ChannelsPerPacket, config.Leds * 3 - offset);
            if (count <= 0) break;
            bool last = offset + count == config.Leds * 3;
            bool raw = config.Protocol=="dnrgb";
            int header = raw ? 4 : 10;
            var packet = new byte[header + count];
            if(raw) {
                packet[0]=4; packet[1]=2;
                packet[2]=(byte)((offset/3)>>8); packet[3]=(byte)(offset/3);
            } else {
            packet[0] = (byte)(last ? 0x41 : 0x40);
            packet[1] = sequence;
            sequence = (byte)(sequence % 15 + 1);
            packet[2] = 0x0B;
            packet[3] = 1;
            packet[4] = (byte)(offset >> 24);
            packet[5] = (byte)(offset >> 16);
            packet[6] = (byte)(offset >> 8);
            packet[7] = (byte)offset;
            packet[8] = (byte)(count >> 8);
            packet[9] = (byte)count;
            }
            Buffer.BlockCopy(rgb, offset, packet, header, count);
            udp.Send(packet, packet.Length, endpoint);
            if (preview != null) {
                for (int i = 0; i < preview.Length / 3; i++) {
                    int index = (i * config.Leds / (preview.Length / 3)) * 3 - offset;
                    if (index >= 0 && index < count) Buffer.BlockCopy(packet, header + index, preview, i * 3, 3);
                }
            }
        }
    }

}
