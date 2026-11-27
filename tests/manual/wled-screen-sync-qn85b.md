# Ambilight Studio hardware check

Samsung QN55QN85BAFXZC, 2026-11-23. Model code read from the TV device API.

## Immediately after reboot

These outputs were read before starting either audio mode. The built-in playback card identified device 5 as dump0 and device 6 as dump1. Card 2 listed the microphone inputs separately.

### `arecord -l`

```text
**** List of CAPTURE Hardware Devices ****
card 0: sdpaudio [sdp_scard_audio], device 5: pcm dump0 pcmdump0 codec-5 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sdpaudio [sdp_scard_audio], device 6: pcm dump1 pcmdump1 codec-6 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sdpaudio [sdp_scard_audio], device 7: pcm dump2 pcmdump2 codec-7 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 0: sif control SIF Codec-0 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 5: amp cap amp capture codec-5 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 6: mic0 cap mic0 capture codec-6 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 12: mic1 cap mic1 capture codec-12 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 3: sdpcard3 [snd_card_3_audio], device 1: DNSe Capture DNSe Capture Codec-1 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 3: sdpcard3 [snd_card_3_audio], device 2: 2 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
```

### `cat /proc/asound/pcm`

```text
00-00: NPP Speaker SDP Codec Speaker-0 :  : playback 1
00-01: 1 :  : playback 1
00-02: Remote effect Remote Codec Speaker-2 :  : playback 1
00-03: PP Speaker PP Codec Speaker-3 :  : playback 1
00-04: Remote1 Spk Remote1 Codec Speaker-4 :  : playback 1
00-05: pcm dump0 pcmdump0 codec-5 :  : capture 1
00-06: pcm dump1 pcmdump1 codec-6 :  : capture 1
00-07: pcm dump2 pcmdump2 codec-7 :  : capture 1
00-08: Main effect2 Main effect2 Codec Speaker-8 :  : playback 1
02-00: sif control SIF Codec-0 :  : playback 1 : capture 1
02-05: amp cap amp capture codec-5 :  : capture 1
02-06: mic0 cap mic0 capture codec-6 :  : capture 1
02-12: mic1 cap mic1 capture codec-12 :  : capture 1
03-00: Sub effect Sub effect Codec Speaker-0 :  : playback 1
03-01: DNSe Capture DNSe Capture Codec-1 :  : capture 1
03-02: 2 :  : capture 1
```

### `cat /proc/asound/card0/pcm5c/info`

```text
card: 0
device: 5
subdevice: 0
stream: CAPTURE
id: pcm dump0 pcmdump0 codec-5
name:
subname: subdevice #0
class: 0
subclass: 0
subdevices_count: 1
subdevices_avail: 1
```

### `cat /proc/asound/card0/pcm6c/info`

```text
card: 0
device: 6
subdevice: 0
stream: CAPTURE
id: pcm dump1 pcmdump1 codec-6
name:
subname: subdevice #0
class: 0
subclass: 0
subdevices_count: 1
subdevices_avail: 1
```

## Earlier boot, after the dump devices had been opened

The ALSA listings below show numeric IDs and empty names. The corrected helper refused both candidates.

### `arecord -l`

```text
**** List of CAPTURE Hardware Devices ****
card 0: sdpaudio [sdp_scard_audio], device 5: 5 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sdpaudio [sdp_scard_audio], device 6: 6 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 0: sdpaudio [sdp_scard_audio], device 7: 7 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 0: sif control SIF Codec-0 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 5: amp cap amp capture codec-5 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 6: mic0 cap mic0 capture codec-6 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 2: sdpsif [sif_scard_audio], device 12: mic1 cap mic1 capture codec-12 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 3: sdpcard3 [snd_card_3_audio], device 1: DNSe Capture DNSe Capture Codec-1 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
card 3: sdpcard3 [snd_card_3_audio], device 2: 2 []
  Subdevices: 1/1
  Subdevice #0: subdevice #0
```

### `cat /proc/asound/pcm`

```text
00-00: NPP Speaker SDP Codec Speaker-0 :  : playback 1
00-01: 1 :  : playback 1
00-02: Remote effect Remote Codec Speaker-2 :  : playback 1
00-03: PP Speaker PP Codec Speaker-3 :  : playback 1
00-04: Remote1 Spk Remote1 Codec Speaker-4 :  : playback 1
00-05: 5 :  : capture 1
00-06: 6 :  : capture 1
00-07: 7 :  : capture 1
00-08: Main effect2 Main effect2 Codec Speaker-8 :  : playback 1
02-00: sif control SIF Codec-0 :  : playback 1 : capture 1
02-05: amp cap amp capture codec-5 :  : capture 1
02-06: mic0 cap mic0 capture codec-6 :  : capture 1
02-12: mic1 cap mic1 capture codec-12 :  : capture 1
03-00: Sub effect Sub effect Codec Speaker-0 :  : playback 1
03-01: DNSe Capture DNSe Capture Codec-1 :  : capture 1
03-02: 2 :  : capture 1
```

### `cat /proc/asound/card0/pcm5c/info`

```text
card: 0
device: 5
subdevice: 0
stream: CAPTURE
id: 5
name:
subname: subdevice #0
class: 0
subclass: 0
subdevices_count: 1
subdevices_avail: 1
```

### `cat /proc/asound/card0/pcm6c/info`

```text
card: 0
device: 6
subdevice: 0
stream: CAPTURE
id: 6
name:
subname: subdevice #0
class: 0
subclass: 0
subdevices_count: 1
subdevices_avail: 1
```

## Reviewed build 0.6.1

The installed catalog bundle from commit `2f6bb6a39a52ed2b456213763831f1ef665d7ac2` had SHA-256 `69a6bd9cb800ee5292238c1e055e571f89df2109375336847a3b69565b8b53b9`. Rebuilding that revision separately with SDK 8.0.100 reproduced the embedded DLL SHA-256 `fe623f992916c9cbaaaa7681c66318ce7b037a92d738c2587334ba17b5dd631d`.

| Mode | Observed on the TV |
| --- | --- |
| Screen sync | The installed shard reported 16 fallback regions, 5.95 captures/s and zero UDP errors. Full-picture capture returned `rc=-1`. |
| TV audio sync | The helper received 1,359,872 PCM bytes. Both RMS and peak were zero. |
| Screen + TV audio | The helper received 995,328 PCM bytes. Both RMS and peak were zero. Picture sampling ran at 6.20 captures/s for 16 fallback regions with zero UDP errors. |

The two audio runs used separate cold launches of the installed DLL under the TV's .NET runtime. The normal unit was stopped. A process-local ALSA configuration routed the legacy helper's fixed device request to card `sdpaudio`, device 6, which had identified itself as a PCM dump earlier in the session. After the reboot identified device 5, the same catalog bundle was installed again and tested through the normal Vetro service with its default ALSA configuration. The helper cold-started in TV audio sync, then switched to Screen + TV audio and Screen sync. The boot ID and built-in card matched the fresh dump0 inventory. Across 35 seconds in each audio mode, the byte counter reached 6,586,368 and then 12,730,368. All logged RMS and peak readings were zero. The combined mode reported 16 fallback regions and 5.82 captures/s at the final reading. Capture continued after returning to Screen sync. These measurements verify both audio code paths on the default device. They establish neither audible program signal nor the appearance of the LEDs.

## Corrected build 0.8.6

Used the installed shard's settings route to select Screen sync → TV audio sync → Screen + TV audio → TV audio sync → Screen sync. Restored the original dashboard settings and checked them against the saved values.

| Mode | Observed on the TV |
| --- | --- |
| Screen sync | 16 fallback regions at 6.19 captures/s on entry and 6.32 captures/s on return, with zero UDP errors. |
| TV audio sync | On both entries the dashboard reported `audio input refused: no identified TV playback dump` and zero audio bytes. |
| Screen + TV audio | Picture sampling continued at 6.32 captures/s over 16 regions. The audio guard reported the same refusal and zero bytes. |

On the fresh boot the guard selected `hw:0,5` by its dump0 ID. In TV audio sync it received 2,313,600 bytes by the 12-second observation. Screen + TV audio kept that recorder open and reported 3,336,960 bytes alongside 16 picture zones. Both meters read zero in these observations. While the recorder was running, the device's proc entry changed to `id: 5` with an empty name. That numeric identity persisted after returning to Screen sync. The guard checks the identity again on every new recorder launch.

LED appearance was not independently observed.

## Controlled playback on the TV

Played a local H.264/AAC clip through the TV's DLNA media renderer with a constant teal image. The audio alternated ten seconds of digital silence with ten seconds of pulsing 110 Hz, 700 Hz and 4 kHz tones. Decoded tones measured −29.2 dBFS mean and −18.7 dBFS peak. The TV reported PLAYING, its media clock advanced to 76 seconds, mute was off and volume stayed at 19. The shard used the existing Music sampling, Ambient reaction, sensitivity 125 and combined intensity 100. WLED's own live-pixel WebSocket supplied the controller measurements.

The primary dump had already lost its label on this boot. The helper selected the identified secondary dump, `hw:0,6`. In both TV audio sync and Screen + TV audio, the peak, level and all three bands read zero in the second half of each observed tone passage. The largest RGB channel reported by WLED in those windows was also zero. The helper consumed over 13 MB of PCM. Combined mode reported 538 picture regions on the colored image.

As a control, passing the decoded track directly through the same compiled audio analyzer with the same sensitivity, profile and response yielded a level of 0 in silence and sampled levels of 65–102 out of 255 during tones. The secondary dump therefore supplied no measurable program signal for this playback route. Playback was stopped and the original Screen sync settings were restored.

### Primary dump replay after a fresh boot

Repeated the same DLNA clip and WLED live-pixel measurements after one reboot, with the same Music and Ambient settings. Before playback, card `sdpaudio` identified capture device 5 as `pcm dump0 pcmdump0 codec-5`. The running shard reported `hw:0,5` in both modes. Readings below exclude the helper's startup interval.

| Mode | Example tone reading on the shard (0–255) | Brightest sampled WLED channel during tones (0–255) |
| --- | --- | --- |
| TV audio sync | Level 129, bass 61, midrange 96, treble 52 | 54–58 |
| Screen + TV audio | Level 96–123 with all three bands active, 538 picture regions | 92–103 |

In the sampled silence windows of combined mode, the controller reported zero on every channel. The dashboard occasionally still displayed the preceding tone reading after the LEDs had gone dark. The playback clock reached 76 seconds. Playback stopped, all shard settings matched their pre-test values, and the TV returned to Screen sync. Device 5's ALSA ID once again read only `5` after use. This run verifies the DLNA media-player route and does not establish HDMI audio behavior.

### Reopening the verified primary dump in 0.8.7

Installed the updated helper, rebooted once, and confirmed the primary label before recording. During controlled DLNA playback the test switched from TV audio to Screen sync and back, restarted the capture service, then switched through Screen sync into Screen + TV audio. The kernel showed numeric ID 5 and an empty name after the first open. All subsequent audio runs selected the primary dump. WLED live pixels brightened on the tones after both the mode switch and the service restart. After the restart the dashboard reported level 95 with bands 44/73/38. Combined mode reported 538 picture regions and level 107 with bands 55/87/46, then zero during silence. The test ended in Screen sync.

## 0.9.5 mode check on QN55QN85BAFXZC

Installed the published PR bundle from commit `67a8137` and read live diagnostics approximately 12 seconds after selecting each mode.

| Mode | Observed result |
| --- | --- |
| Screen sync | Native capture reported `rc=-2` (not ready). The TV color sampler supplied 16 regions at 1.38 scans/s, with zero reported UDP errors. |
| TV audio sync | The verified playback dump `hw:0,5` supplied 1,330,560 PCM bytes. RMS was 41 and peak was 22. The reaction level and all three bands read zero. |
| Screen + TV audio | Native capture reported `rc=-2`. The fallback supplied 16 regions at 2.36 scans/s, with zero reported UDP errors. The verified playback dump supplied 4,272,000 PCM bytes and was quiet at the observation. |

The reviewer's separate run reported native `rc=-1`. The 16-region fallback was the picture path verified in this three-mode run. Earlier 0.9.5 dashboard checks saw a 960 × 540 native plane on the same TV under different conditions. This run did not verify visual LED output or audio reaction to controlled playback. The TV was returned to its previous build and lighting mode.

## 0.9.6 follow-up on QN55QN85BAFXZC

A live Screen sync check on the installed 0.9.6 build reported a 960 × 540 native video plane with 538 regions at 38.15–38.21 scans/s, with zero reported plane or UDP errors. These are scan rates. The picture changed 0–1.80 times/s in the observed windows.

The owner reports that full-picture capture currently works mainly on external inputs. On the Tizen Home screen and in built-in Tizen apps, capture switches to the TV color sampler. Live diagnostics identified the input as unknown during this check, so the readings verify native capture on the active source and the source-by-source behavior reflects the owner's observations.
