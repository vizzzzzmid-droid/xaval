# Native Screen Share over the SFU — audit and implementation plan
**Status: plan only. No code in either repository was changed to produce this document.**
Frontend/server repository: `C:\Projects\xaval` (branch `main`, HEAD `d819e9e`)
Desktop repository: `C:\Projects\Haven-Desktop` (`https://github.com/ancsemi/Haven-Desktop`)
Every claim below was read out of the code. Where something does not exist, the
document says so explicitly instead of describing what would be nice.
---
## 1. Current native architecture
The native share is a **second, parallel media path** that exists next to — not
on top of — the browser share. It is selected by a single predicate.
`public/js/voice.js:636` `_nativeScreenEnabled()` reads
`window.havenDesktop?.nativeScreen`. `public/js/voice.js:1770-1860` is the
native start path: it calls `api.start(...)`, announces the share through
`_emitScreenStart({ transport: 'native', sessionId, codec })`, then attaches each
eligible viewer with `api.addPeer({ peerId, sessionId })`.
The flag `this._nativeScreenSharing` (initialised `false` at
`public/js/voice.js:66`) is what separates the two worlds. It is set `true` at
`voice.js:1796` and cleared at `1824`, `1852`, `2343`, `2727`.
### Finding A — the native media process exists only in xaval's contract
`voice.js` calls `window.havenDesktop.nativeScreen.start/stop/addPeer/
removePeer/setRemoteDescription/addIceCandidate/onSignal`
(`voice.js:1335-1372`, `voice.js:1770-1860`), and relays its signals over
Socket.IO as `native-screen-offer`, `native-screen-answer` and
`native-screen-ice-candidate` (server side: `src/socketHandlers/nativeScreen.js`).
**`nativeScreen` is not present in the current Haven-Desktop preload.** The
bridge object is defined at `C:\Projects\Haven-Desktop\src\main\app-preload.js:1544`
and exposes `platform`, `isDesktopApp`, `pageFocusFollowsWindow`, `i18n`,
`switchServer`, `backToWelcome`, `update`, `audio`, `devices`, `notify`,
`shortcuts`, `setUnreadBadge` — there is no `nativeScreen` key, and no
`desktopCapturer` / `setDisplayMediaRequestHandler` media-process code behind
it in `src/main/main.js`.
Consequence: with the desktop app as it stands today, `voice.js:636` evaluates
the native path as unavailable and `_startScreenShare` falls through to
`getDisplayMedia()`. The native signaling machinery in xaval is currently dead
code against this desktop build.
### Finding B — what the desktop app *does* do today
`C:\Projects\Haven-Desktop\src\main\main.js:2580-2740` implements capture as a
Chromium display-capture picker:
* `desktopCapturer` enumerates sources (screen / window);
* `session.setDisplayMediaRequestHandler` answers the page's
  `getDisplayMedia()` request with a chosen source id;
* audio is either the page's own `audio:capture-data` PCMBridge stream
  (`app-preload.js:1390-1500`, AudioWorklet → `MediaStreamTrack`) or an Electron
  system-audio loopback fallback.
So the desktop app reaches the **same** `getDisplayMedia()` code path in
`voice.js` as a browser — it does not go through a separate native peer.
### Finding C — the SFU gate that excludes native
`public/js/voice.js:3810`:
```js
if (this.isScreenSharing && this.screenStream && !this._nativeScreenSharing) {
```
This is the single line that keeps a native share out of the relay. The
desktop build in Finding B never sets `_nativeScreenSharing`, so in practice
**desktop screen share is not currently excluded** — but the gate is the
documented intent, and it is the line that must change for a real native
transport. Two further gate sites exist:
* `voice.js:1596` — `if (!screenStream || this._nativeScreenSharing) return;`
  skips P2P republishing for native shares;
* `voice.js:1056`, `1159`, `1261-1263`, `1464`, `1507`, `1555`, `1566`, `1578`,
  `1646`, `2338`, `2723` — the rest of the `native-screen-*` session bookkeeping.
---
## 2. Current browser SFU architecture
`voice.js:3810-3817` (`_publishRelayTracks`):
```js
const v = this.screenStream.getVideoTracks()[0];
const a = this.screenStream.getAudioTracks()[0];
if (v) await relay.publish('screen', v, { maxBitrate, simulcast: true });
if (a) await relay.publish('screen-audio', a);
```
`relay.publish` is `public/js/voice-relay.js` → `relay:produce` →
`src/socketHandlers/voiceRelay.js:71-88` → `voiceRelay.produce(...)` →
`src/voiceRelay/mediasoup.js` → `transport.produce(...)`.
The server accepts these two sources only if the sharer is registered first:
`activeScreenSharers.get(code)?.has(socket.user.id)` for `screen` /
`screen-audio`, `activeWebcamUsers` for `webcam`
(`src/socketHandlers/voiceRelay.js:76-81`).
Consumers are gated in mediasoup by `GATED_SOURCES` (screen, screen-audio) and
driven by `setWatching`, so a screen is only forwarded to viewers with the tile
open. `relay:consume`, `relay:set-paused` and `relay:set-preferred-layers`
already exist from Phases 2–3.
---
## 3. Native → SFU gap
| What exists | What is missing |
|---|---|
| Browser capture → relay, incl. simulcast and viewer gating | A way for a **native** capture to hand its tracks to `relay.publish` |
| Per-app WASAPI capture + Haven exclusion in Haven-Desktop | Its result never reaches a mediasoup transport, because it exits through `getDisplayMedia`'s Chromium handler, not a native peer |
| `native-screen-*` P2P signaling in xaval | The matching `nativeScreen` API in Haven-Desktop, which the current preload does not expose |
The gap is therefore **not** in the SFU. The SFU already accepts `screen` and
`screen-audio` from any client that has them as ordinary `MediaStreamTrack`s.
The gap is that a native capture has to be turned into ordinary WebRTC tracks
in the first place.
## 4. Required changes in xaval
Единственный блокирующий гейт — `public/js/voice.js:3810`:
```js
if (this.isScreenSharing && this.screenStream && !this._nativeScreenSharing) {
```
Он пропускает в relay только browser-шар. Для native-шара media уже тот же самый
(`this.screenStream` — один и тот же объект), т.к. native-путь тоже идёт через
`getDisplayMedia`. Значит правка сводится к **снятию гейта**, а не к новому коду.
| Файл | Что менять |
|---|---|
| `public/js/voice.js:3810` | публиковать screen/screen-audio в relay независимо от `_nativeScreenSharing` |
| `public/js/voice.js:1056, 1159, 1261, 1339, 1464, 1507, 1555, 1566, 1578, 1646` | `_nativeScreen*` — P2P-сигналинг. Оставить: нужен для fallback, не должен вызываться при активном SFU |
| `public/js/voice-relay.js` | менять не нужно — `produce()` уже принимает screen/screen-audio |
| `src/socketHandlers/voiceRelay.js` | **не менять** — `relay:produce` уже валидирует `activeScreenSharers` / `activeScreenSessions` и принимает `source: 'screen' \| 'screen-audio'` |
| `src/voiceRelay/mediasoup.js` | **не менять** — лимиты уже считают один screen share = один producer (video) + один (audio) |
## 5. Required changes in Haven-Desktop
| Файл | Что менять |
|---|---|
| — | **ничего** |
Desktop-репозиторий уже отдаёт через `session.defaultSession.setDisplayMediaRequestHandler`
(`src/main/main.js:2456`) готовый `MediaStream`: video-трек окна/экрана из
`desktopCapturer` + audio-трек из WASAPI (`startNative('include', pid)` или
`startNative('exclude', process.pid)`). Это ровно тот тип `MediaStream`, который
`relay:produce` уже умеет принимать. Требуется лишь убедиться, что у audio-трека
`kind === 'audio'`.
## 6. Signaling plan
**Новый signaling не нужен.** Переиспользуется существующий:
```
relay:join          → router capabilities, send/recv transport
relay:connect       → connect transport
relay:produce       → source: 'screen' | 'screen-audio'
relay:producers     → что уже публикуется
relay:consume       → подписка
relay:resume        → снятие pause
```
Native desktop не создаёт собственный PeerConnection к SFU: SFU-транспорт — обычный
`RTCPeerConnection` mediasoup-client, создаваемый **в renderer** (в web-контенте Haven),
где уже есть `this.screenStream`. Отдельный native-транспорт не создаётся.
## 7. Codec compatibility
Router codecs (`src/voiceRelay/mediasoup.js:26-34`):
`opus/48000/2`, `VP8`, `VP9`, `H264` (packetization-mode 1, 42e01f и 4d0032).
| Поток | Кодек | Совместимость |
|---|---|---|
| screen video | H264 (Chromium desktop capture) | ✅ поддержан router'ом |
| screen-audio | Opus 48 kHz stereo (AudioWorklet → MediaStreamTrack) | ✅ |
| mic | Opus 48 kHz | ✅ (не меняется) |
Отдельная codec-конфигурация не нужна.
PLACEHOLDER_B
## 8. Audio path
```
WASAPI PROCESS_LOOPBACK (native/src/win/wasapi_capture.cpp)
  → PCM frames
  → AudioWorklet (app-preload.js:1390-1500)
  → MediaStreamTrack (kind: 'audio')
  → screenStream (getDisplayMedia handler, main.js:2654/2670)
  → _publishRelayTracks → relay:produce source: 'screen-audio'
  → mediasoup Producer → consumers (только у тех, кто открыл плитку)
```
- Application-only сохраняется: `include`-режим (`main.js:2654-2658`).
- Haven не попадает: `exclude`-режим с `TargetProcessId = process.pid`
  (`main.js:2685-2687`) либо `include` конкретного PID.
- `source` остаётся `'screen-audio'` — новый audio backend не нужен.
## 9. Video path
```
desktopCapturer.getSources → source → video MediaStreamTrack
  → screenStream
  → relay:produce source: 'screen' (kind 'video')
  → mediasoup Producer
```
## 10. Simulcast
Browser-путь публикует 2 encoding'а (`scaleResolutionDownBy: 2` и `1`) — слои 0 и 1.
Native H264-путь: **single encoding**. Это не блокер. Фаза 3 уже сделала
`setPreferredLayers` устойчивым к числу слоёв (значение клампится к реальному
top layer), поэтому single-encoding producer отработает без изменений.
Отдельно зафиксированная проблема (не чинится здесь): без simulcast native-шар
шлёт full-resolution каждому зрителю. Смягчается Фазой 3 auto-слоем только для
simulcast-источников; для native нужен отдельный downscaling в кодировщике
Electron — отдельная задача.
## 11. P2P fallback
Сохраняется полностью. Решается флагом, а не удалением кода:
```
native share
   ├─ relay активен и kind === 'relay'  → SFU (relay:produce)
   └─ иначе                             → существующий native P2P
                                          (native-screen-offer / answer / ice)
```
Существующие точки, где SFU может стать недоступен и где нужен откат:
- `relay:lost` / `relay:ended` (`src/voiceRelay/index.js`) — весь call уходит в `direct`;
- worker limit / router error → вызов бросает, клиент не публикует и остаётся на P2P;
- `voiceRelay.fallback()` — уже реализован в Фазе 1.
Требуемая правка в xaval: при потере relay пересоздавать native-шар по P2P-пути
(уже есть: `_nativeScreenSharing = false` при `relay:lost` → `voice.js:2723-2727`).
## 12. Limits
`HAVEN_SFU_MAX_*` применяются в mediasoup.js. Один native-шар = 2 producers
(`screen` + `screen-audio`) от одного peer'а. Существующая семантика
«один screen share = один producer-группа» не ломается: лимит screen shares
считается по пирам, а не по producers.
| Лимит | Влияние native |
|---|---|
| `HAVEN_SFU_MAX_PEERS_PER_ROOM` | без изменений |
| `HAVEN_SFU_MAX_PRODUCERS_PER_PEER` | без изменений (2 < default) |
| `HAVEN_SFU_MAX_CONSUMERS_PER_PEER` | без изменений |
| `HAVEN_SFU_MAX_SCREEN_SHARES_PER_ROOM` | без изменений |
## 13. Failure handling
| Событие | Поведение |
|---|---|
| worker died | `onRoomLost` → `relay:lost` → fallback на P2P (Фаза 1) |
| лимит producers/consumers | вызов отклоняется, ресурсы не создаются |
| transport connect fail | публикация не состоялась, клиент остаётся на P2P |
| `relay:consume` rate limit | зритель не получает трек, шар у шаряра остаётся |
## 14. Testing plan
| Тест | Уровень |
|---|---|
| native screen публикуется в relay при активном SFU | unit (voice.js через vm, как `voiceScreenSignaling.test.js`) |
| browser-путь не изменился | существующие `voiceScreenSignaling` / `screenRelayAuto` |
| viewer-gating для native screen-audio | `voiceRelaySfu.test.js` (уже есть) |
| SFU unavailable → P2P | `voiceRelayFallbackClient.test.js` (уже есть) |
| single-encoding producer + `setPreferredLayers` | `voiceRelaySimulcast.test.js` — расширить кейсом с одним encoding |
| лимиты producer'ов | `voiceRelayLimits.test.js` |
Интеграционный тест с реальным Electron невозможен в `node --test` — вместо него
проверяется ветвление (SFU vs P2P) на моках.
## 15. Rollout plan
| Фаза | Содержание | Репозиторий |
|---|---|---|
| A | снять гейт `!this._nativeScreenSharing` в `_publishRelayTracks` | xaval |
| B | тесты ветвления SFU/P2P | xaval |
| C | ручная проверка: native share в комнате из 10+ человек, один upstream | оба |
| D | (отложено) simulcast/downscale для native video | отдельно |
Обратимость: фаза A — одна строка, откат = вернуть условие.
