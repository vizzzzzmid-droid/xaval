# Native Screen & Audio Capture — Audit

Audit of what Haven **already** does with native screen sharing and audio capture,
as of `d819e9e`. No project code was changed for this document.

The question this answers: can a user share a screen/window/application and send
**only that application's** audio, without the other participants' Haven voice
audio being included?

---

## 1. Existing architecture

There are two entirely separate screen-share paths in the web client, and they
share no media plane.

**A. Browser capture** — `navigator.mediaDevices.getDisplayMedia()` in the page.

**B. Native capture** — an Electron main-process encoder, reached only through a
preload bridge (`window.havenDesktop.nativeScreen`). The page never touches the
native tracks; the desktop app opens its **own** `RTCPeerConnection` per viewer
and the server relays SDP/ICE between them.

The native path is the one relevant here. Key files:

| File | Role |
|---|---|
| `public/js/voice.js` | Both capture paths, native signaling, screen audio playback |
| `public/js/modules/app-ui.js` (≈1483) | Shows the "native screen share" toggle when the bridge exists |
| `src/socketHandlers/nativeScreen.js` | Server relay of native offer/answer/ICE |
| `src/socketHandlers/voice.js` | `screen-start` / `screen-stop`, `activeScreenSessions` |
| `src/voiceRelay/mediasoup.js` | SFU producers/consumers (browser path only, see §9) |
| `desktop-directive.md` | **Specification** of the desktop app — not implementation |

## 2. Native screen capture path

`VoiceManager.startScreenShare()` → `public/js/voice.js:2562`

```
try { if (this._nativeScreenEnabled()) result = await this._tryStartNativeScreenShare(...) }  // 2562
if (native result is handled) return;                                                          // else getDisplayMedia
```

`_nativeScreenEnabled()` (line 636) is just `localStorage.haven_native_screen_share === '1'`,
set by the toggle in `app-ui.js:1490`. The toggle row is only unhidden when
`window.havenDesktop?.nativeScreen` exists, so browser users never see it.

`_tryStartNativeScreenShare()` (line 1725) requires the whole preload surface
`getCapabilities, start, stop, addPeer, removePeer, setRemoteDescription,
addIceCandidate, onSignal` (1731-1735) and H264 support (1737), then:

```
api.getCapabilities()                      // 1739
api.start({ resolution, frameRate, bitrate, codecs, iceServers, iceTransportPolicy })  // 1750
  -> { started, sessionId, codec, hasAudio }
_emitScreenStart({ code, hasAudio, transport: 'native', sessionId, codec })  // 1774
api.addPeer({ peerId, sessionId })          // 1808, for each current viewer
```

Note line 1800: **`this.screenStream = null`** on the native path. The page has
no `MediaStream` for a native share.

## 3. Native audio capture path

Everything after `api.start()` is decided **inside Electron main** and reported
back as a single boolean:

- `result.hasAudio` (line 1776) → `screen-start { hasAudio }` → stored by the server
  in `activeScreenSessions` and returned in the `active-screen-sharers` payload
  (`src/socketHandlers/voice.js`, `activeScreenPayload`, `hasAudio: !!session?.hasAudio`).
- On the viewer's side, the audio track arrives over the native peer connection
  and is routed by `connection.ontrack` (`voice.js:1410-1413`):
  `if (event.track.kind === 'audio') { this._playScreenAudio(sharerId, entry.stream); return; }`
  — i.e. it becomes `screen-audio` for playback.

So the page's only audio knowledge is "there is an audio track or there isn't".
The browser is never told **what** is being captured, and the capture request
(`api.start(...)`, line 1750) carries **no audio source parameter at all** — no
`sourceId`, no `pid`, no `displayId`, no `appId`.

## 4. Windows implementation

**Not present in this workspace.** There is no Electron main process, no
preload script, and no native module in this repository:

- `git ls-files` matches only `desktop-directive.md` for electron/desktop/preload/main.
- No `.cs`, `.rs`, `.cc`, `.cpp`, `.h` sources; no capture-related native addon.
- Searches for `desktopCapturer`, `getSources`, `setDisplayMediaRequestHandler`,
  `WASAPI`, `loopback` in `public/` and `src/` return **one** hit in total:
  `public/js/voice.js:2618`, the browser path.

`desktop-directive.md` *describes* the intended Windows implementation
(lines 101-111, 136-145): WASAPI per-process loopback capture (Win10 21H2+),
`haven-capture.cs` (C# WASAPI helper compiled at runtime),
`get-audio-apps.ps1` (audio session enumeration), SoundVolumeView for routing,
and `audio-loopback.js` / `audio-capture.js` / `AudioMixer` in the app.

That is a plan, not code. The directive also lists a preload `audio` API
(`getRunningApps`, `setRoute`, `startCapture(pid)`, `startSystemCapture`, …) and
`screenPicker.getSources()` — and **the Haven web client calls none of it.**

## 5. Electron implementation

`desktop-directive.md:162-237` specifies the intended preload surface. The native
screen API that `voice.js` actually consumes (`nativeScreen.*`) is **not** in that
document — it was added to the app separately, and the app's source is not here.

## 6. Audio source selection

**Not available from the web client today.** Confirmed three ways:

1. `api.start()` (line 1750) passes resolution/frameRate/bitrate/codecs/ICE only.
   No audio source argument exists in the call.
2. The viewer side gets one boolean (`hasAudio`), never a source identity.
3. `screenPicker.getSources()` and `audio.getRunningApps()` are in the directive
   but have zero call sites in `public/`.

Consequently the web client cannot ask for "the game", "Telegram", or "the whole
system" — it cannot express the choice at all.

## 7. Haven audio exclusion

**Cannot be achieved or even attempted from this side**, because the capture
source is chosen entirely inside Electron main and never surfaced.

If the desktop app implements system loopback (as the directive's graceful
degradation note, lines 303-304, describes: "system audio capture via Electron
`desktopCapturer` still works"), then the behaviour would be:

```
Haven voice ─► system output device ─► loopback of that device ─► screen-audio
```

which **fails** the requirement, because remote participants would hear Haven's
own voice audio returned as screen audio. Whether this happens in practice
depends on the unseen desktop app, not on anything in this repository.

The only architectural property that would make per-app capture correct is the
per-process WASAPI capture described in the directive — it is the right design,
and it is unimplemented.

## 8. Native → WebRTC

Per viewer, one dedicated `RTCPeerConnection`, owned by the Electron app:

- Sharer side: `api.addPeer({ peerId, sessionId })` (line 1808) makes the app send
  an offer; `_setupNativeScreenBridge()` (1335) forwards app signals to the server
  as `native-screen-offer` / `native-screen-ice-candidate` (1364, 1366).
- Server: `src/socketHandlers/nativeScreen.js` validates and forwards to the
  target's socket (line 116), enforcing: 8-hex channel code, integer target,
  `sessionId` matching `^[A-Za-z0-9_-]{8,64}$` for a `transport: 'native'`
  session, both parties `nativeScreenVersion === 2`, not self, not a bot, sharer
  relation, SDP ≤ 49152 bytes, ICE ≤ 2048 bytes, ≤ 8 offers per target per 10 s.
- Viewer side: `_handleNativeScreenOffer()` (1374) creates the `RTCPeerConnection`
  and collects tracks into a local `new MediaStream()` (1385); audio →
  `_playScreenAudio`, video → `onScreenStream` (1410-1416).

## 9. Native → SFU

**No. Native screen share cannot travel through the mediasoup SFU.** The sharer
is never a relay producer: the media lives in the Electron app's peer
connections, and the page has no tracks to publish.

The SFU gate in `public/js/voice.js:1261` shows the design is deliberate:

```js

## 10. Browser vs native comparison

| Feature | Browser screen share | Native screen share |
|---|---|---|
| Screen video | `getDisplayMedia` (2618), H.264/VP8 via P2P, simulcast 2 layers | Electron encoder, H264/AV1/H265, per-viewer PC |
| Screen audio | tab/system audio, chosen by the browser UI | whatever `api.start()` captures, reported as a boolean |
| Application audio | no | not selectable from the web client |
| System audio | browser-dependent (tab / display audio) | depends on the unseen app; loopback per directive |
| Window audio | Chromium window capture | depends on the unseen app |
| Mic | separate P2P track, not part of screen | separate P2P track, not part of screen |
| SFU | yes — `relay:produce` source `screen` / `screen-audio`, simulcast + viewer gating | **no** — P2P only |
| P2P | yes (also the fallback) | yes, the only path |
| Viewer gating | SFU: `setWatching` gates `screen`/`screen-audio`; P2P: `activeScreenSharers` | `activeScreenSharers` + viewer list from `screen-start` |
| Simulcast | yes, 2 layers, `relay:set-preferred-layers` | no |
| Audio source selection | browser UI only | none exposed to the web client |

## 11. Missing pieces

1. **The desktop app source** (Electron main, preload, `audio/*`, `haven-capture.cs`).
2. **An audio-source parameter in the capture request.** `api.start()` has no
   source argument, so no selection can be expressed.
3. **A per-process capture implementation** (Windows WASAPI, Linux PipeWire/Pulse).
   The directive describes it; nothing implements it.
4. **Routing the mixed track into the screen share.** The directive's `AudioMixer`
   is designed to replace a WebRTC audio track; the native path instead receives
   finished tracks from Electron.
5. **Native screen through the SFU.** A native sharer would have to publish into
   the relay rather than open per-viewer connections.
6. **A guard against capturing Haven's own output**, which is currently
   impossible to express even as a preference.

## 12. Recommended minimal implementation

Recorded for the next phase, **not** implemented here. Two viable shapes:

**Shape 1 — per-app capture in the desktop app (preferred, matches the directive).**
Electron main enumerates audio sessions (WASAPI on Windows, PipeWire on Linux),
the UI shows an audio panel, and `api.start()` gains a source argument:

```
api.start({ ..., audioSource: { kind: 'app', pid } })   // or { kind: 'system' }
```

Because per-process WASAPI capture never picks up other processes' render paths,
exclusion of Haven audio is a property of the mechanism, not a filter applied
afterwards. The web-side change is small: pass the option through, and keep
`hasAudio` as the announced boolean.

**Shape 2 — system capture with an exclusion filter.**
Capture the default output and subtract a Haven-owned sink. This is fragile
(Haven's audio is produced in the browser renderer and lands on the same device),
and it is what the requirement is trying to avoid. Only worth it if Shape 1's OS
support is unavailable.

Either way, the per-viewer P2P path stays as-is; SFU support for native shares is
a separate, larger piece of work.

## 13. Risks / limitations

- **Per-process capture is Windows 10 21H2+ and best-effort.** Some apps
  (browsers with protected output, DRM players) do not expose a capturable
  session; the UI must show "not capturable" rather than fall back silently to
  system audio.
- **Linux** needs a null-sink + `pactl move-sink-input` dance and is per-session,
  which races with new streams.
- **macOS** has no per-app capture; only the virtual-driver path in the directive.
- **Native + SFU is a combination that does not exist today.** A native share in
  a 30-person relayed call means 30 outbound encodes from the desktop app.
- **No per-viewer audio selection.** The model is one audio track for the whole
  call; a viewer cannot choose what to hear.
- The audit could not verify what the shipped desktop app actually captures,
  because that source is not in this repository. Every statement about the
  capture mechanism itself is therefore conditional on the app's implementation.

---

## Classification

```
NATIVE SCREEN VIDEO:      READY   (P2P only; H264 path with server-side signaling)
NATIVE SYSTEM AUDIO:      PARTIAL (a boolean, not a chosen source; mechanism unverifiable here)
NATIVE APPLICATION AUDIO: MISSING (no selection parameter, no per-app capture in reach)
EXCLUDE HAVEN AUDIO:      MISSING (cannot be requested; not excluded by any mechanism)
NATIVE AUDIO → SFU:       MISSING (native share is P2P-only by design, voice.js:1261)
```

**Answer to the "how much code" question.** The decisive fact is that
`api.start()` carries no audio source parameter, and the capture process lives
outside this repository, so the choice between "wiring" and "new backend" cannot
be made from here. From this repository the work is: extend the preload contract
with an audio source, and pass the choice through `_tryStartNativeScreenShare`.
If the desktop app already implements per-process capture, this is Shape 1 and
small; if it only does system loopback, excluding Haven audio is a new mechanism,
not a wiring change.

if (!this._nativeScreenSharing && this._isRelayedPeer(targetUserId)) return;
```

i.e. a browser share skips relay-only viewers, while a native share still
renegotiates for them. On the server, `relay:produce` for `screen`/`screen-audio`
requires `activeScreenSharers.get(code)?.has(userId)` and for `webcam` an entry in
`activeWebcamUsers` (`src/socketHandlers/voiceRelay.js`), and a producer needs a
send `transport` from `relay:join` — none of which the native path creates. The
`screen`/`screen-audio` producer `source` values and `GATED_SOURCES` viewer gating
(`setWatching` in `src/voiceRelay/mediasoup.js`) exist, but only browser shares
populate them.

The only `havenDesktop.audio` reference in the whole web client is
`public/js/voice.js:2093-2094`, `optOutOfDucking()`.
