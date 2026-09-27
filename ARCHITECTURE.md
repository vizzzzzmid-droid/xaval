# ARCHITECTURE.md — текущая архитектура Haven (форк `xaval`)

> Статус: **аудит, только чтение**. Документ зафиксирован на коммите
> `f6c8623` ("Changelog: relay install, screen share to viewers only,
> Debian-based Docker image"), ветка `main`.
> Ничего из описанного здесь не изменялось — это описание того,
> что есть в репозитории **сейчас**.

---

## 1. Обзор

Haven — self-hosted Discord-альтернатива в виде **монолита на Node.js**:

* один процесс `server.js` поднимает Express (HTTPS/HTTP) + Socket.IO;
* фронтенд — статические файлы в `public/` (без фазы сборки в проде);
* данные — SQLite (`better-sqlite3`) в каталоге **вне** репозитория;
* голос — WebRTC: **mesh P2P по умолчанию**, плюс уже существующий
  **опциональный SFU-релей на mediasoup** (`src/voiceRelay`), выключенный
  по умолчанию и устанавливаемый по требованию.

```
Браузер / Haven Desktop (Electron, отдельный репозиторий)
        │  HTTPS (статика + REST /api/*)
        │  Socket.IO (события: чат, presence, voice, signaling)
        ▼
server.js  ── Express ── src/auth.js (JWT) ── src/database.js (SQLite)
        │
        ├── src/socketHandlers/*   realtime-логика (чат, роли, voice…)
        │        ├── voice.js          P2P signaling (offer/answer/ICE)
        │        ├── voiceRelay.js     signaling SFU-релея
        │        └── nativeScreen.js   signaling «нативного» screen share
        │
        └── src/voiceRelay/*        mediasoup SFU (опционально, «builtin»)
                 └── UDP/TCP порт 40000+ (worker'ы mediasoup)
```

---

## 2. Структура репозитория

| Путь | Назначение |
|---|---|
| `server.js` | Точка входа (~5770 строк): HTTP/HTTPS-сервер, REST `/api/*`, статика, CSP, запуск Socket.IO (`setupSocketHandlers(io, db, …)` — строка 5548) |
| `src/` | серверные модули (см. §3) |
| `src/socketHandlers/` | обработчики Socket.IO-событий (см. §4) |
| `src/voiceRelay/` | опциональный SFU-релей на mediasoup (см. §8) |
| `public/` | весь фронтенд (см. §5) |
| `plugins/` | пользовательские плагины (`*.plugin.js`) |
| `themes/` | пользовательские темы (`*.theme.css`) |
| `docs/` | документация: `docs/livekit-sfu-plan.md`, `docs/CROSS-PLATFORM-GAMEPLAN.md`, `docs/theme-authoring.md` и др. |
| `test/` | тесты `node --test` (52 файла), релевантные: `voiceScreenSignaling.test.js`, `voiceRelay.test.js`, `nativeScreenClient.test.js`, `nativeScreenSignaling.test.js`, `screenRelayAuto.test.js` |
| `scripts/` | утилиты: `build-mediasoup-client.js` (esbuild-бандл), `loadtest.js`, `gen-cert.js`, `validate-locales.js` |
| `installer/`, `setup.iss`, `master-setup.iss` | Inno Setup-установщик Windows (`innosetup-compiler` в devDependencies) |
| `haven-push-relay/` | Firebase-функции UnifiedPush-релея |
| `website/` | маркетинговый сайт |
| `Dockerfile`, `docker-entrypoint.sh`, `docker-compose.yml`, `zeabur.yaml` | контейнерное развёртывание |
| `.github/workflows/` | `docker-publish.yml` (multi-arch GHCR), `release.yml` (tarball), `translations-autovalidate.yml` |
| `desktop-directive.md` | дизайн-спека **Haven Desktop** (отдельный репозиторий, Electron) — источник требований по WASAPI/per-app audio |

Ключевые файлы в корне: `package.json` (name `haven`, v4.14.0,
`license: AGPL-3.0`), `package-lock.json`, `.env.example`, `LICENSE`,
`README.md`, `GUIDE.md`, `CHANGELOG.md`.

---

## 3. Backend

* **Вход**: `server.js` — генерирует `JWT_SECRET` в `.env` при первом
  старте, читает сертификаты (`src/selfsignedCert.js`), поднимает
  HTTPS (HTTP-редирект на 3001), helmet + CSP, статика из `public/`
  (`server.js:711-713` — включая `themes/` и `plugins/` как есть).
* **База данных**: `src/database.js` (`initDatabase`, `getDb`) —
  `better-sqlite3`, схема `CREATE TABLE IF NOT EXISTS` для ~55 таблиц:
  `users`, `channels`, `messages`, `roles`, `role_permissions`,
  `user_roles`, `channel_members`, `reactions`, `pinned_messages`,
  `webhooks`, `invite_codes`, `bans`, `ip_bans`, `mutes`, `audit_log`,
  `server_settings` (key/value), `custom_emojis`, `custom_sounds`,
  `stickers`, `push_subscriptions`, `fcm_tokens`, `ferry_links`,
  `dm_group_keys` (E2E), `user_personas`, `read_positions`,
  `scheduled_messages`, `automod_*` и др.
* **Пути данных**: `src/paths.js` — БД, `.env`, сертификаты и uploads
  хранятся в `%APPDATA%\Haven` (Windows) / `~/.haven` (Linux/macOS),
  override — `HAVEN_DATA_DIR`; код не должен содержать персональных
  данных.
* **Аутентификация**: `src/auth.js` — Express router
  (`app.use('/api/auth', authRoutes)`): `POST /register`, `POST /login`,
  `POST /guest-login`, `GET /validate`, TOTP-МФА (`/totp/*`),
  recovery-codes, `change-password`, `revoke-sessions`,
  `user-servers`. Пароли — `bcryptjs` (cost 12), токены —
  `jsonwebtoken` (JWT_SECRET из `.env`). OIDC SSO — `src/oidc.js`
  (`/api/auth/oidc/start`, `/oidc/callback`).
  На сокете: `handshake.auth.token` → `verifyToken()`
  (`src/socketHandlers/index.js:1933-1944`), отдельно бот-токены
  (`handshake.auth.botToken`, строка 1913).
* **REST API** в `server.js`: загрузки (`/api/upload*`),
  `/api/ice-servers`, `/api/health`, `/api/version`,
  `/api/public-config`, `/api/themes`, `/api/plugins`, бэкап/
  восстановление (`/api/admin/backup`, `/api/admin/restore`),
  эмодзи/стикеры/звуки, GIF-поиск, media-proxy, link-preview,
  push-подписки, вебхуки ботов (`/api/webhooks/:token/...` — боты,
  slash-команды, voice API).
* **Прочие подсистемы** `src/`: `ferry.js` (двусторонний Discord-мост),
  `importDiscord.js`, `automod.js`, `activity.js` (rich presence),
  `tunnel.js` (Cloudflare/LocalTunnel), `ddns.js`, `fcm.js`/`web-push`,
  `botVoice.js`/`botAudio.js` (боты в голосе), `mediaProxy.js`,
  `searchIndex.js` (FTS), `diskGuard.js`, `channelRotation.js`,
  `envStore.js`, `themeMetadata.js`.

---

## 4. Realtime (Socket.IO)

`src/socketHandlers/index.js` — `setupSocketHandlers(io, db, opts)`
(строка 69), `io.on('connection', …)` (строка 2055). Модули
регистрируются как `register*(socket, ctx)`:

| Файл | События/назначение |
|---|---|
| `messages.js` (151 КБ) | сообщения, потоки, реакции, вложения |
| `channels.js` (100 КБ) | каналы, треды, форумы, rotation |
| `voice.js` (57 КБ) | **voice join/leave, P2P signaling, screen share, webcam** (см. §7–§9) |
| `voiceRelay.js` (5.7 КБ) | **signaling SFU-релея** (`relay:*`) |
| `nativeScreen.js` (5.7 КБ) | **signaling нативного screen share** |
| `roles.js`, `permissions.js`, `moderation.js`, `admin.js` | роли/права/модерация/админка (Large Server Setup — `admin.js:557-610`) |
| `users.js`, `groupE2E.js`, `ferry.js`, `music.js`, `tags.js` | остальное |

In-memory `state`: мапы `voiceUsers`, `activeScreenSharers`,
`activeScreenSessions`, `activeWebcamUsers`, `streamViewers`,
`pendingVoiceLeave`, `voiceRelay` и др.; graceful leave —
`handleVoiceLeave`, `pruneStaleVoiceUsers`. Настройки relay'а —
`voice_relay_mode/port/workers/address` (whitelisted,
`admin.js:59/172`, применение `voiceRelay.apply()`).

## 5. Frontend

Всё в `public/`:

* `index.html` — лендинг/логин; `app.html` (~397 КБ) — основное
  одностраничное приложение.
* `js/app.js` — класс `HavenApp`, собирает методы из ES-модулей
  `js/modules/app-*.js`:

  | Модуль | Назначение |
  |---|---|
  | `app-socket.js` (140 КБ) | все socket-слушатели; `io({auth:{token, presenceDeltas:1}})` (строка 292), `window.havenSocket` (302), `new VoiceManager(socket)` (303) |
  | `app-ui.js` (420 КБ) | **главный UI**: рендер, модалки, панели |
  | `app-channels.js` (160 КБ), `app-messages.js` (125 КБ), `app-forum.js`, `app-search.js` | каналы/сообщения/форум/поиск |
  | `app-voice.js` (145 КБ) | **voice UI**: join/leave, тайлы экрана/камеры, индикаторы, микшер громкости |
  | `app-media.js` (252 КБ) | загрузка медиа, превью, бридж `window.havenDesktop` (clipboard/saveImage) |
  | `app-admin.js` (316 КБ), `app-perm-matrix.js`, `app-role-tools.js` | админка |
  | `app-calls.js`, `app-users.js`, `app-context.js`, `app-utilities.js`, `app-platform.js`, `app-scaling.js`, `app-ferry.js` | прочее |

* `js/voice.js` (**212 КБ**, класс `VoiceManager`, строка 22) —
  **весь WebRTC-клиент**: peer-мапа, микрофонная цепочка, screen share,
  webcam, relay-интеграция (см. §7–§9).
* `js/voice-relay.js` — клиентская половина SFU-релея
  (`HavenRelaySession`, строка 35).
* `js/vendor/mediasoup-client.js` — заранее собранный бандл
  mediasoup-client 3.24.1 (+ `mediasoup-client.NOTICE.txt` с
  лицензиями вложенных MIT/ISC-пакетов), грузится `<script>` лениво
  при входе в relay-звонок.
* `js/theme.js` (70 КБ), `theme-init.js`, `theme-compat.js`,
  `js/plugin-loader.js` (38 КБ, `window.HavenPluginLoader`,
  `window.HavenApi`) — **система тем и плагинов**.
* `js/rnnoise-processor.js` + `rnnoise.wasm` — подавление шума
  RNNoise через AudioWorklet.
* `css/style.css` (~652 КБ), `css/voice.css`, `css/music.css`.
* `locales/*.json` — 8 языков, `js/i18n.js`.
* `sounds/`, `emoji/`, `fonts/`, `games/`, `uploads/`, `sw.js` (PWA),
  `manifest.webmanifest`.

**Темы/плагины**: каталоги `themes/` и `plugins/` отдаются как есть;
метаданные — `src/themeMetadata.js` (THEME_API_VERSION = 1), список —
`GET /api/themes`, `GET /api/plugins`. Плагины включаются на клиенте
через `plugin-loader.js` (флаг в localStorage `haven_enabled_plugins`).

## 6. Desktop client

* **Desktop-клиента в этом репозитории нет.** По `desktop-directive.md`
  Haven Desktop — **отдельный репозиторий** (Electron), подключается к
  серверу как обычный браузерный клиент.
* Интеграционная точка — бридж `window.havenDesktop`
  (`nativeScreen`, `audio.optOutOfDucking`, `clipboardWriteImage/Text`,
  `saveImage`, `notify`) — используется в `public/js/voice.js`,
  `modules/app-media.js`, `app-calls.js`, `app-platform.js`,
  `app-socket.js`, `js/servers.js`.
* **WASAPI / per-app audio capture живёт именно там** (отдельный
  репозиторий), не в этом сервере. Требования: `desktop-directive.md`
  §8 («WASAPI loopback и PipeWire/PulseAudio null-sinks, без
  VB-CABLE»), `docs/CROSS-PLATFORM-GAMEPLAN.md` §2 (рантайм-компиляция
  C# `haven-capture.cs` для per-process loopback на Windows,
  `pw-loopback` на Linux). В **этом** репозитории — только клиентские
  «укрышки» бриджа и общий `getDisplayMedia`-путь (см. §9).
* Проверка `window.havenDesktop || userAgent.includes('Electron')`
  (`public/js/voice.js:2607`) — отключение Chromium-only опций
  display media внутри Electron.

---

## 7. Voice: полный путь (P2P mesh)

Сценарий по умолчанию (`voice_relay_mode = 'off'` — релей не
установлен/выключен), «пользователь A → пользователь B»:

### 7.1 Вход в звонок

1. **UI**: `public/js/modules/app-voice.js` → `_joinVoice()` (строка 5)
   → `this.voice.join(channelCode)`.
2. **Клиент** `public/js/voice.js` → `join()` (строка 2020):
   * `_fetchIceServers()` — GET `/api/ice-servers`
     (`server.js:980`): STUN из `STUN_URLS` (по умолчанию
     `stun.stunprotocol.org`, `stun.nextcloud.com`), TURN из
     `TURN_URL`/`TURN_SECRET`, режим `voice_force_relay`
     (`iceTransportPolicy: 'relay'`);
   * захват микрофона `navigator.mediaDevices.getUserMedia({audio: …})`
     (строки 2071/2082); fallback в «listener-only» при отсутствии
     микрофона;
   * аудиограф в `AudioContext`: source → noise-gate
     (`_startNoiseGate`) → RNNoise AudioWorklet (`_initRNNoise`,
     `_enableRNNoise`, `js/rnnoise-processor.js` + `rnnoise.wasm`) →
     `MediaStreamDestination` → `this.localStream` (строки 2111–2151);
   * `socket.emit('voice-join', { code, nativeScreenVersion,
     nativeScreenCodecs, relay })` (строка 2188).
3. **Сервер** `src/socketHandlers/voice.js` → `socket.on('voice-join')`
   (строка 208): проверки — канал существует, участник канала,
   role-gate, `voice_enabled`, право `use_voice` (гости отдельно),
   лимит участников; выход из предыдущей комнаты,
   `socket.join('voice:' + code)` (строка 315), ответ
   `voice-existing-users` (+ `transport: 'direct'|'relay'`, строка 338)
   и `voice-user-joined` остальным.

### 7.2 Создание peer-соединений (mesh)

4. **Клиент** `voice.js` `_setupSocketListeners()`:
   `voice-existing-users` (строка 713) → для каждого
   `_createPeer(user.id, username, true)` (строка 3350);
   `voice-user-joined` (строка 797) → `_createPeer(..., false)`
   (принимающая сторона ждёт offer — строка 799).
5. `_createPeer` (строка 3350):
   * `new RTCPeerConnection(this.rtcConfig)` (строка 3359);
   * `connection.addTrack(...)` для `localStream` (микрофон), затем
     screen/webcam-треки, если активны (строки 3362–3390);
   * `connection.ontrack` (строка 3398) — маршрутизация входящих
     треков: video классифицируется как webcam/screen по
     `track.getSettings().displaySurface` и сигнальным наборам
     `screenSharers`/`webcamUsers`; audio → `_playAudio()`
     (строки 3515/3527), screen-audio → `_playScreenAudio()`;
   * ICE-candidate → `socket.emit('voice-ice-candidate')`
     (строка 3535).

### 7.3 Signaling (сервер только ретранслирует)

`src/socketHandlers/voice.js`:

| Событие | Строка | Что делает |
|---|---|---|
| `voice-offer` | 431 | валидация (SDP ≤ 49152 байт), участник комнаты → `io.to(target.socketId).emit('voice-offer', …)` |
| `voice-answer` | 448 | то же для answer |
| `voice-ice-candidate` | 465 | ретрансляция ICE (≤ 2 КБ) |

Клиентские обработчики: `voice-offer` → `setRemoteDescription`
(строка 916) → `voice-answer` (921); `voice-answer` → 972;
`voice-ice-candidate` → 1009 (+ буфер кандидатов до remote
description). Пересоздание/renegotiation — `_renegotiate()`
(строка 3281, `createOffer` 3311 → `voice-offer` 3330), ICE-restart —
`_restartIce()` (3785), самовосстановление — `_healPeerConnections()`
(3849), анти-glare `_isPolite()`/`_isCollision()` (585/672).

Сервер **не трогает медиа** в mesh-режиме: он только пересылает
SDP/ICE, все в комнате `voice:${code}`.

### 7.4 Медиа и приём

6. Микрофонный `localStream` уже добавлен в `RTCPeerConnection`
   (строка 3364); mute — `replaceTrack`/`enabled=false`
   (`_applyMuteStateToLocalTracks`, 2512; «тихий трек» —
   `_createSilentAudioTrack`, 3975; деафен —
   `audioSender.replaceTrack(silentTrack)`, 3950).
7. Медиа идёт **напрямую A↔B** (STUN/TURN из `/api/ice-servers`);
   сервер видит только signaling.
8. На стороне B: `ontrack` → `_playAudio(userId, stream)`
   (строка 4708) — `<audio>`-элементы, per-user громкость
   (`setVolume`, 3922), деафен (`deafenUser`, 3936), анализаторы
   говорящих (`_startAnalyser`, 4579). Индикатор «говорит» →
   сервер `voice-speaking`/`voice-activity` (`voice.js:915/928`).

### 7.5 Уход/переключение

`voice-leave` (сервер `voice.js:489`), `voice-kick` (497),
grace-period `pendingVoiceLeave`, авто-rejoin по
`localStorage.haven_voice_channel` (клиент `voice.js:2186`,
слушатели reconnect в `app-socket.js`), `voice-rejoin` (сервер 956).

---

## 8. Voice через SFU-релей (mediasoup) — уже существует, выключен

Важно: **репозиторий уже содержит SFU-путь** (mediasoup), отдельно от
P2P mesh. Это «builtin»-режим, а не LiveKit (LiveKit — только план в
`docs/livekit-sfu-plan.md`, кода нет).

* **Сервер**: `src/voiceRelay/index.js` — фасад `createVoiceRelay`
  (режимы `off`/`builtin`, `kindFor(code, occupied)` решает relay vs
  direct **при первом входе в звонок** и держит решение, пока в
  звонке есть люди — прерывать действующие звонки нельзя).
  `src/voiceRelay/mediasoup.js` — `MediasoupRelay`: worker'ы mediasoup,
  по одному UDP/TCP-порту на worker (по умолчанию 40000,
  `voice_relay_port/workers/address`), router на звонок, кодеки
  Opus/VP8/VP9/H264, транспорты send/recv, producer/consumer с паузой.
* **Установка движка**: `src/voiceRelay/addon.js` — mediasoup
  **не входит в обычный install**: кнопка «Install the relay»
  (Large Server Setup, `src/socketHandlers/admin.js:557-610`)
  ставит mediasoup 3.27.1 в `<DATA_DIR>/addons/voice-relay` через npm
  (потоковый прогресс `voice-relay-install-progress`).
* **Signaling**: `src/socketHandlers/voiceRelay.js` —
  `relay:join / relay:connect / relay:produce / relay:producers /
  relay:consume / relay:resume / relay:close-producer` (ack-based),
  сервер рассылает `relay:new-producer`, `relay:producer-closed`,
  `relay:lost`.
* **Клиент**: `public/js/voice-relay.js` — `HavenRelaySession.start()`
  (строка 77): `relay:join` → `Device.load(rtpCapabilities)` →
  send/recv transports → `produce` (`mic`, `screen`, `screen-audio`,
  `webcam`) → `consume`. Инициируется из `voice.js`
  `_ensureRelay()` (строка 3678) по `voice-existing-users` с
  `transport: 'relay'`; треки публикуются там же
  (`shareScreen` → `relay.publish('screen')`, строка 2690;
  `_publishRelayTracks`, 3739).
* **Гибридность**: боты и клиенты без relay-capability остаются на
  mesh в том же звонке (`getNativeScreenClientInfo().relay`, строка 610).
* **Настройки**: `server_settings` — `voice_relay_mode/port/workers/
  address` (whitelisted в `admin.js:59/172`, применение
  `voiceRelay.apply()`, статус в `voice-relay-status`).
* **Docker**: `Dockerfile` (Debian slim, чтобы релей ставился),
  `EXPOSE 40000/udp 40000/tcp`; в `docker-compose.yml` маппинг порта
  закомментирован (раскомментировать при включении).
* **Клиентский бандл**: `scripts/build-mediasoup-client.js` (esbuild) →
  `public/js/vendor/mediasoup-client.js`, коммитится в репо, чтобы
  серверу не нужна была сборка.

---

## 9. Screen sharing: полный путь

Есть **два транспорта** (`activeScreenSessions.transport`:
`'browser' | 'native'`).

### 9.1 Транспорт A — браузерный (`getDisplayMedia`)

1. **UI**: `app-voice.js` → `_toggleScreenShare()` (478) /
   `_doToggleScreenShare()` (496) → `voice.shareScreen()`.
2. **Захват**: `public/js/voice.js` → `shareScreen()` (строка 2554):
   * сначала пробуется **нативный** путь (§9.2), если
     `_nativeScreenEnabled()` (2564);
   * constraints: разрешение 720/1080/1440p, FPS 15/30/60
     (строки 2572–2583);
   * `navigator.mediaDevices.getDisplayMedia({ video, audio: true })`
     (строка 2620) — **аудио экрана захватывается здесь же**;
     voice-processing для screen-audio **выключен** по умолчанию
     (`echoCancellation/autoGain/noiseSuppression: false`, строки
     2598–2603; переключатель
     `localStorage.screen_share_voice_processing`), чтобы не
     «выедать» музыку/игровой звук; опции
     `surfaceSwitching/selfBrowserSurface/monitorTypeSurfaces` и
     `CaptureController` добавляются только вне Electron (2607–2618);
   * `this.screenStream`, `screenHasAudio` (строка 2656).
3. **Сигнальное объявление**: `_emitScreenStart` → сервер
   `screen-share-started` (`src/socketHandlers/voice.js:558`):
   проверки прав/`streams_enabled`/native-совместимости, запись в
   `activeScreenSharers`/`activeScreenSessions`, broadcast
   `screen-share-started` всем в комнате + `broadcastStreamInfo`,
   ack с `viewerIds`.
4. **Отправка медиа**:
   * mesh: `peer.connection.addTrack(track, this.screenStream)` для
     **каждого** peer + `_applyScreenBitrate` + `_renegotiate`
     (строки 2678–2686);
   * relay: `this._relay.publish('screen', videoTrack, {simulcast})`
     и `publish('screen-audio', audioTrack)` (строки 2690–2691).
5. **Приём**: `ontrack` в `_createPeer` классифицирует video-трек
   (строки 3401–3465) → `onScreenStream(userId, stream)` →
   `app-voice.js` `_handleScreenStream()` (строка 968) рисует тайл;
   **аудио экрана** → `_playScreenAudio(userId, stream)`
   (`voice.js:4158`) — отдельный аудиопоток, не зависимый от
   микрофонного тракта; deferred-fallback маршрутизация
   (строки 3396/3467–3471, 3521).
6. **Зрители/битрейт**: `stream-watch`/`stream-unwatch`
   (`voice.js:730/746`) — в relay-режиме видео идёт только тем, у
   кого открыт тайл (`setWatching` → пауза consumer'ов);
   `request-screen-renegotiate` (670) — ручное восстановление
   (watchdog в `app-voice.js` `_startStreamStallWatchdog`, 1279).
7. **Стоп**: `stopScreenShare()` (`voice.js:2716`) — снятие треков,
   `screen-share-stopped` (сервер 634), relay `unpublish`.

### 9.2 Транспорт B — «нативный» (только Haven Desktop)

Кодировка/захват выполняет **Electron-приложение**, не браузер:

1. `voice.js` → `_tryStartNativeScreenShare()` (строка 1733):
   проверяет API `window.havenDesktop.nativeScreen`
   (`getCapabilities/start/stop/addPeer/removePeer/
   setRemoteDescription/addIceCandidate/onSignal`) и пересечение
   кодеков (сервер допускает только H264-базовый —
   `readNativeScreenClient`, `voice.js:13`).
2. `api.start({resolution, frameRate, bitrate, codecs, iceServers})`
   → `sessionId`; объявление серверу `screen-share-started
   transport:'native'` (сервер 576–600, `NATIVE_SCREEN_VERSION = 2`).
3. Отдельный RTCPeerConnection **на каждого зрителя** создаётся в
   Electron (`api.addPeer({peerId, sessionId})`, строка 1816);
   SDP/ICE идут отдельными событиями через
   `src/socketHandlers/nativeScreen.js`:
   `native-screen-offer` / `native-screen-answer` /
   `native-screen-ice-candidate` (строки 126–128) с rate-limit
   офферов (`allowOffer`, 8 офферов/10 с) и валидацией session/
   negotiation id.
4. Клиентская приёмная сторона: `_setupNativeScreenBridge` (1343),
   `_handleNativeScreenOffer/Answer/IceCandidate` (1382/1513/1467) —
   прокидывают сигналы в бридж, видео рендерится оттуда же.
5. Если среди зрителей есть клиент без native-поддержки — сервер
   отвечает `incompatible_viewer`, и шеринг останавливается либо
   падает на браузерный транспорт (`voice.js:1167`,
   `notifyNativeSharersOfIncompatiblePeer`).

**Аудио приложения (per-app capture)**: в этом репозитории его
**нет** — только контракт. Браузерный путь умеет лишь system audio
через `getDisplayMedia({audio:true})`. Per-application audio
(WASAPI loopback / PipeWire null-sink) реализуется в Haven Desktop
(`desktop-directive.md`, `docs/CROSS-PLATFORM-GAMEPLAN.md`) и
попадает в звонок либо как «screen-audio» трек, либо через нативный
транспорт (`result.hasAudio`). Независимость аудио приложения от
звука клиента уже заложена разделением потоков: микрофон
(`getUserMedia`), system audio (`getDisplayMedia` audio) и
screen-audio — это **три независимых MediaStreamTrack**, каждый
добавляется/publish-ится отдельно (`addTrack` по треку,
`relay.publish(source)` c `source: 'mic'|'screen'|'screen-audio'|
'webcam'`).

---

## 10. Транспорт (WebSocket)

* **Socket.IO v4**: `socket.io` на сервере; в браузере грузится
  `/socket.io/socket.io.js` с сервера (`socket.io-client` в
  devDependencies — только для тестов/скриптов).
* Одно соединение на всё: чат, presence, voice signaling, `relay:*`,
  admin. Аутентификация — `auth: { token: JWT, presenceDeltas: 1 }`
  при подключении (`public/js/app.js:292`), проверка —
  `src/socketHandlers/index.js:1933` (+ `handshake.auth.botToken`,
  строка 1913). Реконнект — `reconnectionDelay: 1500…10000`.
* Дополнительно `ws` (dev-зависимость) — нагрузочные скрипты/тесты;
  `web-push` — push-подписки.
* **Медиа (WebRTC SRTP) не идёт по WebSocket** — только signaling.

## 11. Сборка, пакеты, окружение

* **Пакетный менеджер**: npm (`package-lock.json`), Node `>=18 <27`,
  три команды: `start`, `dev` (`node --watch`), `test`
  (`node --test --test-concurrency=1`).
* **Сборка фронтенда в проде отсутствует** — файлы отдаются как есть;
  esbuild используется только для `scripts/build-mediasoup-client.js`.
* **Runtime-зависимости**: express, socket.io, better-sqlite3,
  bcryptjs, jsonwebtoken, otpauth, helmet, express-rate-limit, multer,
  dotenv, ws, archiver, adm-zip, yauzl, music-metadata, qrcode,
  localtunnel, web-push, @ruffle-rs/ruffle.
  **dev**: esbuild, innosetup-compiler, mediasoup-client,
  socket.io-client.
* **Переопределения зависимостей**: `bn.js >=5.2.3`, `axios >=1.8.2`.
* **Docker**: `node:22-bookworm-slim`, `tini`, `gosu`, healthcheck
  `/api/health`, том `/data`; compose — порты 3000/3001
  (+40000 udp/tcp закомментирован). CI
  (`.github/workflows/docker-publish.yml`) собирает multi-arch
  (amd64/arm64, нативные раннеры из-за нативного аддона better-sqlite3)
  в `ghcr.io/ancsemi/haven`.
* **Прочее развёртывание**: `Install Haven.bat/.ps1`, `start.sh`,
  Inno Setup (`setup.iss`), `zeabur.yaml`,
  пример traefik+coturn — `docs/examples/haven-traefik-coturn/`.

## 12. Лицензия и ограничения для форка

* `LICENSE` — **GNU AGPL-3.0** (полный текст), `package.json`:
  `"license": "AGPL-3.0"`.
* Что это означает для вашего форка:
  1. **Модификации распространяются под AGPL-3.0** — если вы
     предоставляете доступ к изменённому Haven как сетевой сервис,
     вы обязаны **предоставить исходный код** вашей версии
     (секция 13 AGPL — «remote network interaction»).
  2. Нельзя добавлять дополнительные ограничения сторонним
     пользователям, нужно сохранять уведомления о лицензии и
     авторских правах (секции 4, 7).
  3. **Товарные знаки/название лицензией не регулируются**:
     `README.md`/`docs` содержат упоминания автора (ancsemi) и
     «Haven»; при публичном распространении форка уместно указать
     происхождение («based on Haven») и не выдавать его за
     официальный проект.
  4. **Сторонние компоненты** вложены под совместимыми лицензиями
     (MIT/ISC/BSD) — см. `public/js/vendor/mediasoup-client.NOTICE.txt`;
     их нужно сохранять при переработке бандла.
  5. Частное использование/форк для себя без публичного сервиса
     особых обязанностей не порождает; обязательства включаются при
     публикации доступа к сервису.
  6. Оговорка: это технический обзор, а не юридическое заключение.

---

## 13. План будущей модификации

> Здесь **только** проектирование. Ничего не реализовано, зависимости
> не добавлялись, архитектура не менялась.

### 13.1 Целевая модель

```
┌────────────────────────────────────────────────────────────┐
│  Ваш frontend (новый UI, свой дизайн)                     │
│  — заменяет public/app.html + app-*.js, НО переиспользует │
│    протоколы: REST /api/* + Socket.IO события              │
│                                                            │
│  Ваш desktop client (Electron/Tauri)                       │
│  — WASAPI loopback / PipeWire per-app audio,               │
│    screen capture, tray, notifications                     │
└───────────────┬───────────────────────────┬────────────────┘
                │ REST + Socket.IO          │ WebRTC (SFU)
                ▼                           ▼
┌───────────────────────────┐   ┌──────────────────────────────┐
│  Haven backend (сохранён) │   │  SFU (LiveKit | mediasoup |  │
│  server.js + src/*        │──▶│  Janus) — новый процесс/     │
│  auth, messaging, roles,  │   │  контейнер; signaling через  │
│  permissions, realtime,   │   │  адаптер VoiceProvider        │
│  database, plugins/themes │   │  (порт 40000+ / 7880)        │
└───────────────────────────┘   └──────────────────────────────┘
```

### 13.2 Ключевые принципы безопасности изменений

1. **Сохранить контракт backend'а.** Не трогать `src/auth.js`,
   `src/database.js`,
   `src/socketHandlers/{messages,channels,roles,permissions,moderation,
   admin,users}.js` — на них держится весь чат. Новый frontend
   подключается к **существующим** событиям (`app-socket.js` как
   референс протокола).
2. **Граница voice — в узком месте.** Всё voice-знание сервера
   сконцентрировано в трёх файлах (`src/socketHandlers/voice.js`,
   `voiceRelay.js`, `nativeScreen.js`) и фасаде
   `src/voiceRelay/index.js`. Их и нужно заменять/оборачивать,
   а не `server.js`.
3. **Уже готовая точка расширения**: фасад `createVoiceRelay` в
   `src/voiceRelay/index.js` — интерфейс «релей или direct», который
   по замыслу позволяет добавить новый тип (LiveKit/Janus) «не трогая
   voice-код, который его использует» (комментарий в шапке файла).
   Плюс `docs/livekit-sfu-plan.md` описывает `VoiceProvider`
   (Pass A: выделить интерфейс без изменения поведения, Pass B:
   новый бэкенд). **Рекомендуемый путь: Pass A → подключение SFU.**
4. **Пошаговость (не мигрировать всё сразу):**
   * **Фаза 0** — этот документ как baseline; характерные
     сценарии-проверки (тесты `test/voiceScreenSignaling`,
     `voiceRelay`, `nativeScreen*`, `screenRelayAuto` — держать
     зелёными).
   * **Фаза 1** — выбор SFU. Кандидаты разобраны в
     `docs/livekit-sfu-plan.md` (LiveKit — операционная простота;
     mediasoup — уже частично интегрирован как «builtin»-релей;
     Janus — вне плана). Рекомендация: **не выбрасывать
     `src/voiceRelay`**, а сделать его вторым провайдером:
     `VoiceProvider = { p2p, mediasoupBuiltin, livekit }`.
   * **Фаза 2** — новый frontend. Либо (а) отдельное SPA, отдаётся
     `server.js`-ом с нового маршрута, либо (б) отдельный статический
     хостинг + CORS. В обоих случаях **не** править обработчики
     `socketHandlers` — только слушать их события. Сохранить
     темы/плагины как опциональный слой (`theme.js`,
     `plugin-loader.js` переносятся либо отключаются — решение на
     этой фазе, т.к. они завязаны на DOM старого UI).
   * **Фаза 3** — screen sharing через SFU. Уже сегодня relay-режим
     умеет: simulcast (`publish('screen', …, {simulcast})`),
     viewer-gated видео (`setWatching`), отдельный source
     `screen-audio`. Перевод = подключение нативного/браузерного
     захвата к SFU-producer'ам вместо per-peer `addTrack`.
   * **Фаза 4** — per-application audio. Остаётся **клиентской**
     задачей desktop-приложения: WASAPI loopback → отдельный
     `MediaStreamTrack` → SFU producer `source: 'screen-audio'`
     (или новый source `app-audio` — потребует расширить `SOURCES`
     в `src/socketHandlers/voiceRelay.js:22` и
     `MediasoupRelay.produce`). Серверная часть почти не меняется —
     только whitelist источников.
5. **Что не ломать:**
   * P2P mesh оставить включаемым (fallback при недоступном SFU —
     уже реализовано для релея: `onRelayEnded` переводит звонок в
     direct; тот же паттерн сохранить);
   * гибридность ботов (`botVoice.js`/`botAudio.js` живут на
     mesh/REST) — боты должны продолжать работать;
   * E2E для ЛС (`e2e.js`, `groupE2E`) — не относится к voice;
   * REST API для ботов и вебхуков — публичный контракт.
6. **Безопасность**: сохранить проверки, которые уже есть в
   voice-обработчиках (валидация SDP/ICE по размеру, membership в
   комнате, permission-проверки в `voice-join`, rate-limit офферов в
   `nativeScreen.js`); новые SFU-signaling обработчики проектировать
   с тем же уровнем валидации (`relay:*` — референс: `inRelayedCall()`
   перед каждым вызовом).
7. **Лицензия**: форк остаётся AGPL-3.0; при публичном
   распространении — публикация исходников вашего frontend'а и
   серверных правок; сохранить `LICENSE` и `NOTICE`-файлы.

### 13.3 Вне scope этого этапа

* Никакой SFU не устанавливается и не настраивается.
* Никакие зависимости не добавляются.
* Frontend не переписывается.
* Существующие модули не удаляются и не рефакторятся.

---
*Документ создан в рамках аудита (только чтение). Изменённые файлы:
один — `ARCHITECTURE.md`.*

