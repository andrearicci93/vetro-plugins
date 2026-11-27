# Ambilight Studio

Samples TV picture colors and sends them to a configured WLED controller over DDP (UDP 4048). Configure the controller's private IPv4 address under WLED target. Supported ranges are 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16. The default strip count is 538. Full-picture capture depends on firmware and input mode. The color sampler can provide lower resolution fallback.

In Advanced → Sampling, **Picture sampling resolution** requests a frame size and sets the maximum grid used by the LED zones and black-bar detector. The live readout shows both the native TV frame and the LED sampling grid. The QN85B returned 960 × 540 for all four requests. A smaller grid on this model takes effect after the native capture call.

The 0.9.5 three-mode run on the QN55QN85BAFXZC verified the 16-region fallback for picture sync and PCM input from the verified Samsung playback dump in both audio modes. Native capture was unavailable in that run (rc=-2), and the reviewer separately observed rc=-1. Earlier dashboard checks saw native frames on this model under different conditions. See the [per-mode observations and ALSA listings](../../tests/manual/wled-screen-sync-qn85b.md). Game Mode and source switching can make full-picture capture unavailable.

On the same TV, a 0.9.6 follow-up observed native 960 × 540 capture. The owner reports that full-picture capture works mainly on external inputs and switches to the TV color sampler on the Tizen Home screen and in built-in apps. The live status did not identify the active input during the follow-up.

## Dashboard and discovery

Find WLED controllers sends one local mDNS query for the WLED service. Selecting a discovered controller connects immediately. For manual IPv4 entry, use Apply. Reset defaults preserves the connected controller and strip layout. Manual IPv4 entry works when multicast is unavailable. Discovery was verified on a LAN with two controllers.

The strip monitor shows 48 samples from outgoing DDP packets in physical LED order. It refreshes once per second and clears stale output. It shows the transmitted colors, without feedback from the LEDs. Capture diagnostics show scan rate, observed changes, active zones and crop insets.

Color accent picks the depth sample with the strongest chroma. Highlight picks the highest luma. With the fallback sampler, both choose among measured spots on each side (four-spot mode has only one choice per side). One color per side averages each entire edge. Whole-strip average produces one color for all LEDs.

## Output and strip layout

Simple view provides daily lighting controls. Advanced view adds capture diagnostics and per-side LED counts and switches. Output supports 1–4096 RGB pixels over DDP or WLED DNRGB. Screen sync samples up to 538 zones. LED brightness scales the outgoing RGB values locally, preserving the controller's brightness and segment settings. Before changing power, the shard checks the WLED information response. If the controller needs powering on, it saves the prior power state in Vetro config before sending the command. It prepares a replacement controller before restoring the old one. A shard stop restores the current controller's power state and failed restores stay pending.

## Audio response

TV audio sync and Screen + TV audio share a stereo PCM reader. It measures loudness and three frequency bands every 10 ms. Bass emphasizes the low end below about 115 Hz. The source gain adapts over several seconds and holds during silence. Sensitivity controls the resulting levels, and Audio response smoothing controls their rise and decay.

Each audio profile remembers its own effect. Custom exposes detector style, accent threshold, sensitivity and response time. The accent threshold sets the rise above the recent sound level needed to register a hit. Screen + TV audio has a separate Profile effect for each profile, defaulting to Picture intensity only.

- **Balanced** follows the full-range level for speech and general viewing.
- **Music** combines sustained loudness with short accents from rises in full-range and bass energy. The center pulse can expand on a drum hit during an already loud passage.
- **Impact** responds to new hits and decays on a steady sound. Beat flash uses the onset detector in all three profiles.

Center pulse expands radially from the center of the picture. Each LED is placed on the TV rectangle using its edge and its index on that edge. Opposite edge counts estimate width and height assuming equal LED spacing. A missing axis uses a 16∶9 estimate. In Spectrum, bass, midrange and treble each set a radius from that same center. The illuminated area grows and recedes with the bands. Bass wave follows low frequencies around the perimeter, Beat flash lights on attacks, and Ambient uses a slower moving glow. Audio-only output uses blue, teal and cool white. At full combined intensity, Screen + TV audio shows the sampled picture colors only inside the reaction. Outside it the LEDs go dark, with a soft fade at the boundary. Mode transitions blend the brightness multiplier on the current picture. Combined audio intensity at zero gives the original picture output.

In Screen + TV audio, choose **Picture intensity only** to apply one audio-driven brightness multiplier to all sampled colors. At full combined intensity, silence goes dark and moderate accents can reach full picture brightness. At zero combined intensity the picture stays at its original brightness. TV audio sync keeps its own selected reaction.

The dashboard reports the signal state and received PCM bytes. Quiet audio fades out. A stalled recorder fades out and reopens with retry backoff. Switching between the two audio modes keeps the audio stream open. A change in the TV source identifier across two polls reopens capture on the new input.

## Commands it runs

- `systemctl is-active`, `stop`, and `reset-failed` manage the shard's capture service. `systemd-run` runs the bundled helper under `/usr/bin/dotnet`.
- Node reads the helper status and preview with filesystem APIs.
- `busctl` queries the TV's HDR status during picture capture.
- The helper runs `arecord` as root in both audio modes to read stereo 48 kHz S16_LE PCM from an identified Samsung playback dump. Before each recorder launch the helper reads card 0's ID and capture info (including `/proc/asound/card0/pcm5c/info`). On `sdpaudio` it accepts the exact label `pcm dump0 pcmdump0 codec-5` at device 5 or `pcm dump1 pcmdump1 codec-6` at device 6. The helper checks for the primary label at startup and before each recorder launch. When it observes that label, it ties the device to the current Linux boot and the registered sound device. If Samsung later replaces the primary label with exactly `id: 5` and an empty name, the helper checks that binding before reopening it. A conflicting name or a changed device invalidates the match. The helper uses `/usr/bin/stat` to read the sysfs and device-node identities. It keeps the verified binding in memory and saves it as a privileged extended attribute on `runtime/` when the filesystem supports it. The dump can return silence depending on the TV route. PCM is processed in memory. Only derived levels, byte counts, and lighting output are retained. Audio samples are never written to disk or sent to WLED.
- The shard uses HTTP port 80 for `GET /json/info`, `GET /json/state` and `POST /json/state`. UDP output uses DDP port 4048 or WLED DNRGB port 21324.
- The helper runs as root and reads the video plane through Samsung private libraries (`libvideo-capture`, `libvideoenhance`) plus vconf `memory/system/source_type`.
- The helper is 32-bit-only. It refuses 64-bit runtimes before native pointer access. If startup fails, Vetro retries with backoff and gives up after five attempts until Start is pressed again.
- The private 0700 `runtime/` directory contains `rate.txt`, `preview.b64` and `capture-heartbeat`. The shard refuses a symlink at that directory. Vetro renews the heartbeat every two seconds during capture. The helper exits when the heartbeat is removed or becomes more than eight seconds old, including after a Vetro crash. The shard folder contains `hdr-state`, `picture-recovery-until`, config, and the installed helper DLL and runtime manifests.

## Building the helper

Run both commands with the pinned .NET SDK 8.0.100.

```
node scripts/build-wled-screen-sync-helper.cjs
node scripts/build-wled-screen-sync-helper.cjs --check
```

The build compiles `PlaybackBinding.cs`, `Audio.cs`, `Colour.cs`, `VideoPlaneCapture.cs`, and `Tuning.cs` through `helpers/wled-screen-sync/WledScreenSync.csproj`, then writes `payload.b64`, `Colour.runtimeconfig.json`, and `Colour.deps.json` beside the Shard source. CI rebuilds the helper and compares the generated DLL SHA-256 to the embedded payload.
