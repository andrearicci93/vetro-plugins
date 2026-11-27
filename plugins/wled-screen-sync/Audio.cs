using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

// One instance per PCM stream. All envelopes advance on exact 10 ms stereo windows.
internal sealed class AudioAnalyzer
{
    internal const int Frames = 480;
    internal const int BlockBytes = Frames * 4;
    private const double Dt = Frames / 48000.0;
    private static double Coefficient(double hz) { return 1 - Math.Exp(-2 * Math.PI * hz / 48000); }
    private static readonly double Sub = Coefficient(22), Low = Coefficient(115), High = Coefficient(2000);

    private struct Channel
    {
        private double dc, low1, low2, middle;
        public void Add(double sample, ref Energy e)
        {
            dc += Sub * (sample - dc);
            sample -= dc;
            low1 += Low * (sample - low1);
            low2 += Low * (low1 - low2);
            middle += High * (sample - middle);
            double mid = middle - low1, high = sample - middle;
            e.Total += sample * sample;
            e.Bass += low2 * low2;
            e.Mid += mid * mid;
            e.Treble += high * high;
            e.Peak = Math.Max(e.Peak, Math.Abs(sample));
        }
    }
    private struct Energy { public double Total, Bass, Mid, Treble, Peak; }
    private Channel left, right;
    private double reference, gainDb, fast, background, lowFast, lowBackground;
    private double cooldown, hit, hitHold, level, bass, mid, treble, beat, ambient;
    private double pictureBed, pictureBassBed, pictureAccent;
    private bool armed = true;

    internal struct Frame
    {
        public double PictureAccent, Level, Bass, Mid, Treble, Beat, Ambient, Gain;
        public int Rms, Peak;
        public static int Meter(double value) { return (int)Math.Round(255 * Unit(value)); }
        public Frame Fade(double amount)
        {
            Frame f = this;
            f.PictureAccent *= amount; f.Level *= amount; f.Bass *= amount; f.Mid *= amount;
            f.Treble *= amount; f.Beat *= amount; f.Ambient *= amount;
            return f;
        }
    }
    private static double Unit(double x) { return Math.Max(0, Math.Min(1, x)); }
    private static double Follow(double value, double target, double seconds)
    {
        return target + (value - target) * Math.Exp(-Dt / seconds);
    }
    private static double Envelope(double value, double target, double attack, double release)
    {
        return Follow(value, target, target > value ? attack : release);
    }
    private static double Display(double rms, double gain)
    {
        return 1 - Math.Exp(-8 * rms * gain);
    }

    public Frame Analyze(byte[] block, Tuning config)
    {
        Energy e = new Energy();
        for (int i = 0; i < BlockBytes; i += 4)
        {
            left.Add((short)(block[i] | block[i+1] << 8) / 32768.0, ref e);
            right.Add((short)(block[i+2] | block[i+3] << 8) / 32768.0, ref e);
        }
        const double samples = Frames * 2;
        double raw = Math.Sqrt(e.Total / samples);
        // Freeze the reference in silence. Adapt in dB over seconds so individual
        // beats retain their contrast and a pause does not amplify the next word.
        if (raw > 0.003)
        {
            reference = reference == 0 ? raw : Follow(reference, raw, raw > reference ? 0.65 : 2.8);
            double wantedDb = Math.Max(-20, Math.Min(12, 20 * Math.Log10(0.085 / reference)));
            gainDb = Follow(gainDb, wantedDb, wantedDb < gainDb ? 0.7 : 3.0);
        }
        double gain = Math.Pow(10, gainDb / 20);
        double rms = raw * gain, low = Math.Sqrt(e.Bass / samples) * gain;
        double scale = config.AudioSensitivity / 100.0;
        double gate = Unit((rms - 0.0015) / 0.006);
        double full = Display(rms, scale) * gate;

        // Detect rising energy relative to its recent bed, independently of LED FPS.
        fast = Follow(fast, rms, 0.022);
        lowFast = Follow(lowFast, low, 0.028);
        double novelty = Math.Max((fast - background) / (0.025 + background),
                                  (lowFast - lowBackground) / (0.018 + lowBackground));
        background = Follow(background, fast, 0.16);
        lowBackground = Follow(lowBackground, lowFast, 0.20);
        cooldown -= Dt;
        if (novelty < 0.12) armed = true;
        bool loudEnough = config.AudioSampling != "impact" || (rms > 0.055 && e.Peak * gain > 0.13);
        if (armed && cooldown <= 0 && novelty > config.AccentThreshold && rms > 0.013 && loudEnough)
        {
            hit = Unit((0.28 + (novelty - config.AccentThreshold) * 0.8) * scale) * gate;
            hitHold = 0.055;
            cooldown = 0.145;
            armed = false;
        }
        if (hitHold > 0) hitHold -= Dt;
        else hit = Follow(hit, 0, 0.085);

        bool impact = config.AudioSampling == "impact", music = config.AudioSampling == "music";
        double response = Math.Max(0.04, config.AudioResponse / 1000.0);
        double attack = Math.Max(0.015, response * (impact ? 0.18 : music ? 0.32 : 0.50));
        double release = response * (impact ? 0.85 : music ? 1.05 : 1.40);
        // Music keeps the sustained bed below the accents, including on loud masters.
        double target = impact ? hit : music ? Unit(0.63 * full + 0.57 * hit) : full;
        double bandDrive = impact ? hit : music ? 0.76 + 0.24 * hit : 1;
        level = Envelope(level, target, attack, release);
        beat = Envelope(beat, hit, attack * 0.70, release * 0.70);
        bass = Envelope(bass, Display(low, scale) * gate * bandDrive, attack, release);
        mid = Envelope(mid, Display(Math.Sqrt(e.Mid / samples) * gain, scale) * gate * bandDrive, attack, release);
        treble = Envelope(treble, Display(Math.Sqrt(e.Treble / samples) * gain, scale) * gate * bandDrive, attack, release);
        ambient = Envelope(ambient, level, 0.18, 0.42);
        // Track small rhythmic changes on an established sound bed. The absolute
        // level and sustained-bed gates keep silence and isolated hits from pumping.
        pictureBed = Follow(pictureBed, fast, 0.9);
        pictureBassBed = Follow(pictureBassBed, lowFast, 0.9);
        double relativeRise = Math.Max((fast - pictureBed) / (0.015 + pictureBed),
            (lowFast - pictureBassBed) / (0.012 + pictureBassBed));
        double accent = Unit((relativeRise - 0.035) * 3.2) * Unit((pictureBed - 0.025) / 0.035) * gate;
        pictureAccent = Envelope(pictureAccent, accent, Math.Max(0.022, attack * 0.55), Math.Max(0.07, release * 0.60));
        return new Frame { PictureAccent=pictureAccent, Level=level, Bass=bass, Mid=mid, Treble=treble, Beat=beat, Ambient=ambient,
            Gain=gain, Rms=Frame.Meter(rms * 4), Peak=Frame.Meter(e.Peak * gain) };
    }
}

internal static class TvAudioCapture
{
    private static readonly object Sync = new object();
    private static Thread worker;
    private static Process child;
    private static bool requested, suspended, intentionalStop;
    internal static PlaybackBinding Binding;
    private static string deviceLabel = "";
    private static AudioAnalyzer.Frame current;
    private static long updated, bytes;
    private static string state = "idle";
    private static Tuning config;
    private static double MillisecondsSince(long stamp)
    {
        return (Stopwatch.GetTimestamp() - stamp) * 1000.0 / Stopwatch.Frequency;
    }
    private static void TryKill(Process p)
    {
        if (p == null) return;
        try { if (!p.HasExited) p.Kill(); }
        catch (InvalidOperationException) {}
        catch (System.ComponentModel.Win32Exception) {}
    }

    // Called by the output thread. Reuse the recorder between audio-enabled modes.
    public static AudioAnalyzer.Frame Update(bool enabled, Tuning settings, bool sourceChanged)
    {
        lock (Sync)
        {
            config = settings;
            if (!enabled || sourceChanged) suspended = false;
            requested = enabled;
            if (!enabled || sourceChanged || (child != null && MillisecondsSince(updated) > 3500))
            {
                if (child != null)
                {
                    intentionalStop = !enabled || sourceChanged;
                    TryKill(child);
                    child = null;
                }
                if (!enabled) current = default(AudioAnalyzer.Frame);
            }
            if (enabled && !suspended && worker == null)
            {
                worker = new Thread(ReadLoop) { IsBackground=true };
                worker.Start();
            }
            double age = MillisecondsSince(updated);
            return age <= 150 ? current : current.Fade(Math.Exp(-(age - 150) / 100));
        }
    }

    public static string Status(Tuning settings)
    {
        lock (Sync)
        {
            double age = MillisecondsSince(updated);
            var f = age > 350 ? default(AudioAnalyzer.Frame) : current;
            string signal = state;
            if (child != null) signal = age > 350 ? "waiting for PCM" : f.Peak == 0 ? "quiet" : "receiving";
            return String.Format("audio input {0}, audio rms {1}, audio peak {2}, audio level {3}, audio bands {4}/{5}/{6}, beat {7}, audio normalization {8:F2}x, audio sampling {9}, audio response {10} ms, audio bytes {11}",
                signal + deviceLabel, f.Rms, f.Peak, AudioAnalyzer.Frame.Meter(f.Level), AudioAnalyzer.Frame.Meter(f.Bass),
                AudioAnalyzer.Frame.Meter(f.Mid), AudioAnalyzer.Frame.Meter(f.Treble), AudioAnalyzer.Frame.Meter(f.Beat),
                current.Gain, settings.AudioSampling, settings.AudioResponse, bytes);
        }
    }

    // ALSA numbers alone do not identify a playback tap. Only open an exact
    // named dump on the Samsung playback card, never a numeric-only or mic ID.
    internal static string PlaybackDevice(string asound, PlaybackBinding binding = null)
    {
        try
        {
            string card = Path.Combine(asound, "card0");
            if (File.ReadAllText(Path.Combine(card, "id")).Trim() != "sdpaudio") return null;
            string[] ids = { "pcm dump0 pcmdump0 codec-5", "pcm dump1 pcmdump1 codec-6" };
            for (int i = 0; i < ids.Length; i++)
            {
                int number = 5 + i;
                string path = Path.Combine(card, "pcm" + number + "c", "info");
                if (!File.Exists(path)) continue;
                string identity = binding == null || number != 5 ? null : binding.Identity();
                var fields = new System.Collections.Generic.Dictionary<string, string>();
                foreach (string line in File.ReadAllLines(path))
                {
                    int colon = line.IndexOf(':');
                    if (colon > 0) fields[line.Substring(0, colon)] = line.Substring(colon + 1).Trim();
                }
                string stream, index, device, id, name;
                if (fields.TryGetValue("stream", out stream) && stream == "CAPTURE"
                    && fields.TryGetValue("card", out index) && index == "0"
                    && fields.TryGetValue("device", out device) && device == number.ToString()
                    && fields.TryGetValue("id", out id) && fields.TryGetValue("name", out name)
                    && (id == ids[i] || id == "" || id == device)
                    && (name == "" || name == ids[i]))
                {
                    bool named = id == ids[i] || name == ids[i];
                    if (identity != null && identity == binding.Identity())
                    {
                        if (named) binding.Remember(identity);
                        else if (id == device && name == "" && binding.Matches(identity)) return "hw:0," + number;
                    }
                    if (named) return "hw:0," + number;
                }
            }
        }
        catch (IOException) {}
        catch (UnauthorizedAccessException) {}
        return null;
    }

    private static void ReadLoop()
    {
        int retryMs = 250, failures = 0;
        bool useShortPeriods = true;
        try
        {
            while (true)
            {
                lock (Sync) { if (!requested) return; state = "opening"; }
                var analyzer = new AudioAnalyzer();
                var buffer = new byte[AudioAnalyzer.BlockBytes];
                string device = PlaybackDevice("/proc/asound", Binding);
                if (device == null)
                {
                    lock (Sync) { deviceLabel = ""; suspended = true; state = "refused: no identified TV playback dump"; }
                    return;
                }
                lock (Sync) { deviceLabel = " (" + device + ")"; }
                string arguments = "-q -D " + device + " -f S16_LE -r 48000 -c 2 -t raw";
                if (useShortPeriods) arguments += " -F 10000 -B 40000";
                var start = new ProcessStartInfo("/usr/bin/arecord", arguments)
                    { UseShellExecute=false, RedirectStandardOutput=true };
                bool received = false, interrupted = false, launched = false;
                int blocks = 0;
                using (var process = new Process { StartInfo=start })
                {
                    try
                    {
                        lock (Sync)
                        {
                            if (!requested) return;
                            process.Start();
                            launched = true;
                            child = process;
                            intentionalStop = false;
                            updated = Stopwatch.GetTimestamp();
                            current = default(AudioAnalyzer.Frame);
                        }
                        Stream stream = process.StandardOutput.BaseStream;
                        int used = 0;
                        while (true)
                        {
                            int read = stream.Read(buffer, used, buffer.Length - used);
                            if (read == 0) break;
                            used += read;
                            if (used < buffer.Length) continue;
                            Tuning settings;
                            lock (Sync) { if (!requested || child != process) break; settings = config; }
                            var frame = analyzer.Analyze(buffer, settings);
                            lock (Sync)
                            {
                                if (!requested || child != process) break;
                                received = true;
                                current = frame;
                                updated = Stopwatch.GetTimestamp();
                                bytes += used;
                            }
                            used = 0;
                            if (++blocks == 200) { retryMs = 250; failures = 0; useShortPeriods = true; }
                        }
                    }
                    catch (Exception e) { Console.Error.WriteLine("Audio capture: " + e.Message); }
                    finally
                    {
                        lock (Sync) { interrupted = !requested || (launched && intentionalStop); child = null; state = "reconnecting"; }
                        TryKill(process);
                    }
                }
                if (!interrupted && ++failures >= 5)
                {
                    lock (Sync) { suspended = true; state = "recorder failed five times; restart capture to retry"; }
                    return;
                }
                if (!received) useShortPeriods = false; // Some PCM devices require the driver defaults.
                // Back off on an unavailable device. Stop promptly on a mode change.
                for (int waited = 0; waited < retryMs; waited += 100)
                {
                    lock (Sync) { if (!requested) return; }
                    Thread.Sleep(100);
                }
                retryMs = Math.Min(8000, retryMs * 2);
            }
        }
        finally { lock (Sync) { worker = null; if (!suspended) state = "idle"; } }
    }
}
