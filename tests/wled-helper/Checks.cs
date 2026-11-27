using System;
using System.IO;
using System.Threading;
class Checks
{
    static void Require(bool value) { if (!value) throw new Exception("WLED helper regression"); }
    sealed class TestBinding : PlaybackBinding
    {
        public string Key = "original";
        public TestBinding() : base(null) {}
        internal override string Identity() { return Key; }
    }
    static void Identity(string root)
    {
        string card = Path.Combine(root,"card0");
        string file = Path.Combine(card,"pcm5c","info");
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllText(Path.Combine(card,"id"), "sdpaudio\n");
        string header = "card: 0\ndevice: 5\nstream: CAPTURE\n";
        foreach (var label in new[] { "id: 5\nname: ", "id: mic0 cap\nname: microphone",
            "id: pcm dump0 pcmdump0 codec-5\nname: microphone" })
        {
            File.WriteAllText(file, header + label);
            Require(TvAudioCapture.PlaybackDevice(root) == null);
        }
        File.WriteAllText(file,header + "id: pcm dump0 pcmdump0 codec-5\nname: ");
        Require(TvAudioCapture.PlaybackDevice(root) == "hw:0,5");
        var binding = new TestBinding();
        Require(TvAudioCapture.PlaybackDevice(root,binding) == "hw:0,5");
        File.WriteAllText(file,header + "id: 5\nname: ");
        Require(TvAudioCapture.PlaybackDevice(root,binding) == "hw:0,5");
        File.WriteAllText(file,header + "id: 5\nname: microphone");
        Require(TvAudioCapture.PlaybackDevice(root,binding) == null);
        File.WriteAllText(file,header + "id: 5\nname: ");
        binding.Key = "replacement";
        Require(TvAudioCapture.PlaybackDevice(root,binding) == null);
        File.Delete(file);
        file = Path.Combine(card,"pcm6c","info");
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllText(file,header.Replace("device: 5","device: 6")+"id: pcm dump1 pcmdump1 codec-6\nname: ");
        Require(TvAudioCapture.PlaybackDevice(root) == "hw:0,6");
        File.WriteAllText(Path.Combine(card,"id"),"USBMic");
        Require(TvAudioCapture.PlaybackDevice(root) == null);
    }
    static void SamplingResolution()
    {
        foreach (int requested in new[] { 960, 640, 480, 384 })
        {
            foreach (int native in new[] { 960, 640, 480, 384 })
            {
                foreach (bool vertical in new[] { false, true })
                {
                    int source = vertical ? native * 9 / 16 : native;
                    int limit = vertical ? requested * 9 / 16 : requested;
                    int[] axis = WledAmbiPpi.SampleAxis(source, limit);
                    Require(axis.Length == Math.Min(source, limit));
                    for (int i = 0; i < axis.Length; i++)
                    {
                        Require(axis[i] == (int)((i + 0.5) * source / axis.Length));
                        Require(axis[i] >= 0 && axis[i] < source);
                    }
                }
            }
        }
    }
    static void Ownership()
    {
        ManualResetEventSlim inside=new ManualResetEventSlim(), finish=new ManualResetEventSlim(), released=new ManualResetEventSlim();
        int starts=0, releases=0, captureThread=0;
        var worker=new PictureWorker(wanted => {
            captureThread=Thread.CurrentThread.ManagedThreadId;
            Interlocked.Increment(ref starts);inside.Set();finish.Wait();
            // Even a rapid off/on cannot cancel the previous owner's stop.
            if(starts==1)Require(!wanted());
        }, () => {
            Require(captureThread==Thread.CurrentThread.ManagedThreadId);
            Interlocked.Increment(ref releases);released.Set();
        });
        worker.Update(true);Require(inside.Wait(2000));
        worker.Update(false);worker.Update(true);
        Require(starts==1 && releases==0);
        finish.Set();Require(released.Wait(2000));
        Require(SpinWait.SpinUntil(()=>{worker.Update(true);return Volatile.Read(ref starts)>=2;},2000));
        worker.Update(false);
        Require(SpinWait.SpinUntil(()=>Volatile.Read(ref releases)>=2,2000));
    }
    static void CombinedDynamics()
    {
        Require(WledAmbiPpi.CombinedGain(0, 0, 0) == 1 && WledAmbiPpi.CombinedGain(1, 0, 0) == 1);
        Require(WledAmbiPpi.CombinedGain(0, 1, 1) == 0 && WledAmbiPpi.CombinedGain(0.55, 1, 1) == 1);
        Require(WledAmbiPpi.CombinedGain(0.4, 1, 1) > 0.8);
        var analyzer = new AudioAnalyzer();
        var config = new Tuning {AudioSensitivity=100, AudioResponse=160, AudioSampling="music"};
        var block = new byte[AudioAnalyzer.BlockBytes];
        double low=1, high=0;
        for (int n=0;n<1000;n++)
        {
            // Steady master with a modest bass accent every half second, then silence and one isolated hit.
            double amplitude=n<700 ? (n%50<12 ? 0.16 : 0.12) : n==990 ? 0.40 : 0;
            for(int i=0;i<AudioAnalyzer.Frames;i++)
            {
                short v=(short)(32767*amplitude*Math.Sin(2*Math.PI*100*i/48000));
                int k=i*4; block[k]=block[k+2]=(byte)v; block[k+1]=block[k+3]=(byte)(v>>8);
            }
            var frame=analyzer.Analyze(block, config);
            if(n>=500 && n<700){low=Math.Min(low,frame.PictureAccent);high=Math.Max(high,frame.PictureAccent);}
            if(n>=980)Require(frame.PictureAccent<0.05);
        }
        Require(high-low>0.15);
        Console.WriteLine("Combined music accent range {0:F2} to {1:F2}", low,high);
    }
    static void TuningAndRuntimeSafety(string root)
    {
        // Minimal JSON with only IsRequired fields must preserve controls.json defaults via [OnDeserializing].
        string minJson = "{\"Hdr\":\"auto\",\"Saturation\":100,\"Brightness\":100,\"Gamma\":100,\"Reference\":203,\"Black\":0,\"Red\":100,\"Green\":100,\"Blue\":100,\"Smooth\":125,\"CaptureHz\":60,\"SendHz\":62,\"Source\":\"auto\",\"Fallback\":16,\"Bars\":\"both\",\"Depth\":16,\"SampleMode\":\"average\",\"Offset\":0,\"Direction\":\"normal\",\"Wled\":\"192.168.2.10\",\"Leds\":538,\"Zones\":512,\"ZonesMode\":\"match\",\"StartCorner\":\"bottom-left\"}";
        string cfgPath = Path.Combine(root, "tuning.json");
        File.WriteAllText(cfgPath, minJson);
        var fallback = new Tuning();
        var loaded = Tuning.ReadFrom(cfgPath, fallback);
        Require(loaded != fallback);
        Require(loaded.AudioBlend == 35);
        Require(loaded.AudioSensitivity == 100);
        Require(loaded.Protocol == "ddp");
        Require(loaded.HasTarget);

        File.WriteAllText(cfgPath, minJson.Replace("\"Brightness\":100", "\"Brightness\":50"));
        var dimmed = Tuning.ReadFrom(cfgPath, loaded);
        byte[] picture = {200, 100, 50}, audio = {200, 100, 50};
        dimmed.Apply(picture);
        dimmed.ApplyAudio(audio);
        Require(picture[0] == 100 && picture[1] == 50 && picture[2] == 25);
        Require(audio[0] == 100 && audio[1] == 50 && audio[2] == 25);

        // Out-of-range Depth, negative Smooth, and malformed/non-private Wled must be rejected or marked non-target.
        File.WriteAllText(cfgPath, minJson.Replace("\"Depth\":16", "\"Depth\":500"));
        Require(Tuning.ReadFrom(cfgPath, loaded) == loaded);
        File.WriteAllText(cfgPath, minJson.Replace("\"Smooth\":125", "\"Smooth\":-5"));
        Require(Tuning.ReadFrom(cfgPath, loaded) == loaded);
        File.WriteAllText(cfgPath, minJson.Replace("192.168.2.10", "not-an-ip"));
        Require(Tuning.ReadFrom(cfgPath, loaded) == loaded);
        File.WriteAllText(cfgPath, minJson.Replace("192.168.2.10", "192.0.2.10"));
        Require(!Tuning.ReadFrom(cfgPath, loaded).HasTarget);
        Require(!Tuning.IsPrivateTarget("0.0.0.0"));
        Require(!Tuning.IsPrivateTarget("127.0.0.1"));
        Require(!Tuning.IsPrivateTarget("169.254.1.1"));
        Require(!Tuning.IsPrivateTarget("224.0.0.1"));
        Require(!Tuning.IsPrivateTarget("255.255.255.255"));
        Require(!Tuning.IsPrivateTarget("172.32.0.1"));
        Require(!Tuning.IsPrivateTarget("192.168.1.01"));
        Require(Tuning.IsPrivateTarget("192.168.1.50"));
        Require(Tuning.IsPrivateTarget("10.3.1.13"));
        Require(Tuning.IsPrivateTarget("172.31.2.1"));

        // WriteRuntimeFile writes atomically and refuses symlink targets and symlink directories.
        string runtime = Path.Combine(root, "rt");
        Directory.CreateDirectory(runtime);
        Require(WledAmbiPpi.WriteRuntimeFile(runtime, "rate.txt", "ok"));
        Require(File.ReadAllText(Path.Combine(runtime, "rate.txt")) == "ok");
        string victim = Path.Combine(root, "victim.txt");
        File.WriteAllText(victim, "untouched");
        string symFile = Path.Combine(runtime, "preview.b64");
        File.CreateSymbolicLink(symFile, victim);
        Require(!WledAmbiPpi.WriteRuntimeFile(runtime, "preview.b64", "overwritten"));
        Require(File.ReadAllText(victim) == "untouched");
        string symDir = Path.Combine(root, "rt-link");
        Directory.CreateSymbolicLink(symDir, runtime);
        Require(!WledAmbiPpi.WriteRuntimeFile(symDir, "rate.txt", "bad"));
        Require(File.ReadAllText(Path.Combine(runtime, "rate.txt")) == "ok");

        string heartbeat = Path.Combine(runtime, "capture-heartbeat");
        DateTime now = DateTime.UtcNow;
        Require(!WledAmbiPpi.HasCaptureHeartbeat(runtime, now));
        File.WriteAllText(heartbeat, "");
        File.SetLastWriteTimeUtc(heartbeat, now.AddSeconds(-2));
        Require(WledAmbiPpi.HasCaptureHeartbeat(runtime, now));
        Require(!WledAmbiPpi.HasCaptureHeartbeat(symDir, now));
        Require(!WledAmbiPpi.HasCaptureHeartbeat(runtime, now.AddSeconds(7)));
        File.Delete(heartbeat);
        File.CreateSymbolicLink(heartbeat, victim);
        Require(!WledAmbiPpi.HasCaptureHeartbeat(runtime, now.AddSeconds(1)));
    }
    static void Main()
    {
        string tmp=Directory.CreateTempSubdirectory().FullName;
        try {SamplingResolution();CombinedDynamics();Identity(tmp);Ownership();TuningAndRuntimeSafety(tmp);Console.WriteLine("PASS device identity, tuning safety, and single-owner capture lifecycle");}
        finally {Directory.Delete(tmp,true);}
    }
}
