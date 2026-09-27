# ARCHITECTURE_SFU.md — аудит существующего mediasoup SFU (форк `xaval`)

> Дополняет [`ARCHITECTURE.md`](./ARCHITECTURE.md) (разделы 7–9). Цель — ответить
> на вопрос: **можно ли использовать уже существующий mediasoup relay
> (`src/voiceRelay`) как основную серверную voice-систему вместо P2P mesh.**
>
> Все утверждения проверены по исходникам (файл:строка). Статусы:
> **IMPLEMENTED** — работает и участвует в рабочем flow;
> **PARTIAL** — реализовано частично или с ограничениями;
> **NOT USED** — функция есть в коде, но не вызывается;
> **NEEDS RUNTIME TEST** — логика есть, но требует проверки на живом сервере.
>
> Документ только анализирует; код приложения не изменялся.

---

## 1. Existing SFU overview

В Haven **уже существует** работающий SFU-путь на mediasoup 3.27.1:

* Реализация: `src/voiceRelay/` (`index.js` — фасад, `mediasoup.js` — движок,
  `addon.js` — установка mediasoup по требованию, `publicIp.js` — STUN-определение
  публичного IP).
* Клиент: `public/js/voice-relay.js` (класс `HavenRelaySession`); библиотека
  `public/js/vendor/mediasoup-client.js` (mediasoup-client 3.24.1) грузится лениво.
* Signaling: `src/socketHandlers/voiceRelay.js` — 7 событий `relay:*` + 4
  серверных broadcast-события.
* Режим: настройка `voice_relay_mode` ∈ `['off','builtin']`
  (`src/voiceRelay/index.js:22,36-39`), админ-UI — Large Server Setup
  (`public/js/modules/app-scaling.js:39-174`, `src/socketHandlers/admin.js:554-624`).
  **По умолчанию выключен.**
* mediasoup ставится в `<DATA_DIR>/addons/voice-relay` кнопкой «Install the relay»
  (`src/voiceRelay/addon.js:66-120`), версия `3.27.1` (`addon.js:18`).
* Режим звонка решает **первый участник** и держится, пока звонок не опустеет
  (`kindFor`, `src/voiceRelay/index.js:93-98`; `src/socketHandlers/voice.js:33-39`).
* Каждый звонок = отдельный mediasoup **Router**; участник = два
  **WebRtcTransport** (send/recv) на общем `WebRtcServer` (один UDP+TCP порт на worker).
* Покрыто интеграционным тестом `test/voiceRelay.test.js` (пропускается без
  mediasoup) и `test/screenRelayAuto.test.js`.
* LiveKit в коде отсутствует — только план `docs/livekit-sfu-plan.md`.

**Вердикт по фундаменту:** ядро (router/transport/producer/consumer/simulcast/
viewer-gating/reconnect-backoff) написано аккуратно и работает в смешанных
звонках, но это **relay для отдельных сценариев, а не production-only SFU**:
рядом остаётся полный P2P-меш, часть cleanup-путей не знает про relay,
server-side mute не подключён, авто-fallback при отказе relay отсутствует
(см. §21–§23).

---

## 2. File structure

| Файл | Роль |
| --- | --- |
| `src/voiceRelay/index.js` | Фасад `createVoiceRelay()`: режимы, настройки, `kindFor/callEnded`, делегирование операций, `apply()/boot()/install()` |
| `src/voiceRelay/mediasoup.js` | `MediasoupRelay`: worker'ы, `WebRtcServer`, Router'ы, транспорты, producer'ы, consumer'ы, `setWatching`, lifecycle |
| `src/voiceRelay/addon.js` | Ленивая установка mediasoup (`npm install` в DATA_DIR), `loadMediasoup()` |
| `src/voiceRelay/publicIp.js` | `detectPublicIp()` — STUN-запрос (Google/Cloudflare) для `announcedAddress` |
| `src/socketHandlers/voiceRelay.js` | Хендлеры `relay:*`, валидация, broadcast `relay:new-producer`/`relay:producer-closed` |
| `src/socketHandlers/voice.js` | `voice-join/voice-rejoin/voice-leave`, `callKind()`, screen-share, `stream-watch` → `setWatching`, mute/deafen флаги |
| `src/socketHandlers/index.js` | Фасад (`:177`), `relay:lost`/`relay:ended` (`:182-183`), `handleVoiceLeave` → `voiceRelay.leave` (`:1190`), `pruneStaleVoiceUsers` (`:743`) |
| `src/socketHandlers/admin.js` | `voice-relay-save` (`:554`), `voice-relay-install` (`:598`), `voice-relay-status` (`:548`), STUN/TURN настройки (`:153,254`) |
| `public/js/voice-relay.js` | `HavenRelaySession`: device, 2 транспорта, publish/unpublish, consume/resume, resync, close |
| `public/js/voice.js` | `VoiceManager`: mic-конвейер, `_ensureRelay` (`:3678`), `_publishRelayTracks` (`:3739`), `_onRelayTrack` (`:3756`), `relay:ended` (`:782`) |
| `public/js/modules/app-socket.js` | `voice-users-update`, авто-`voice-rejoin` на реконнекте (`:396,564`) |
| `public/js/modules/app-voice.js` | UI: `stream-watch`/`stream-unwatch` (`:1233,1260`), плитки |
| `public/js/modules/app-scaling.js` | Админ-UI Large Server Setup |
| `public/js/vendor/mediasoup-client.js` | Бандл mediasoup-client 3.24.1 (ISC) |
| `test/voiceRelay.test.js` | Интеграционный тест полного relay-flow |
| `Dockerfile`, `docker-compose.yml` | `EXPOSE 40000/udp 40000/tcp`, закомментированный маппинг |

---

## 3. Server architecture

```
server boot
  └─ src/socketHandlers/index.js:177  state.voiceRelay = createVoiceRelay({getSetting, onRoomLost, onRelayEnded})
       ├─ :185  voiceRelay.boot()            // mode==='builtin' → MediasoupRelay.start()
       ├─ настройки из SQLite server_settings (voice_relay_*)
       ├─ onRoomLost   → io.to(`voice:${code}`).emit('relay:lost',   {channelCode})
       └─ onRelayEnded → io.to(`voice:${code}`).emit('relay:ended',  {channelCode})

createVoiceRelay (src/voiceRelay/index.js)
  ├─ mode(): 'off' | 'builtin'   (livekit упомянут в комментарии, но НЕ в MODES)
  ├─ readSettings(): port=40000, workers=1..8, address=''
  ├─ kindFor(code,occupied): первый участник решает relay|direct → callKinds
  ├─ apply(): стоп → (mode=builtin ? старт : перевод звонков в 'direct' + onRelayEnded)
  │           повторные apply сериализованы цепочкой promises (:43,68-82)
  └─ делегаты join/connect/produce/closeProducer/setProducerPaused/producers/
      consume/resumeConsumer/setWatching/leave/inCall → MediasoupRelay

MediasoupRelay (src/voiceRelay/mediasoup.js)
  ├─ _start(): announce-адрес (настройка → STUN detectPublicIp → LAN);
  │            по одному worker'у на порт (port..port+workers-1);
  │            worker.createWebRtcServer({listenInfos:[udp,tcp]})  (:98-110)
  ├─ _room(code): worker с наименьшим числом звонков → createRouter({mediaCodecs})
  │               гонка двух join закрыта повторной проверкой (:160-161)
  ├─ join(): peer {transports, producers, consumers, watching};
  │          2 × createWebRtcTransport(webRtcServer, udp+tcp, preferUdp,
  │          initialAvailableOutgoingBitrate=1_000_000)  (:176-199)
  ├─ connect(): t.connect({dtlsParameters})               (:201-206)
  ├─ produce(): ровно 1 producer на source, старый закрывается (:209-220)
  ├─ consume(): recv-транспорт, paused:true, appData{source,sharerId} (:253-271)
  ├─ resumeConsumer()/setWatching(): viewer-gating экрана (:274-292)
  ├─ leave(): закрыть транспорты → удалить peer → закрыть Router при пустом звонке (:295-308)
  └─ stop()/_workerDied(): закрыть всё + onRoomLost для каждого звонка (:127-149)
```

Состояние relay **полностью in-memory** (workers, rooms, peers, callKinds);
настройки — в SQLite. Рестарт сервера сбрасывает relay; клиенты восстанавливаются
через `relay:producers → error → новая сессия` (§9).

**Auth/validate на каждом `relay:*`**: сначала аутентификация сокета (общая
Socket.IO middleware, JWT) + `inRelayedCall(code)` — членство в voice-комнате,
совпадение `socketId`, режим `currentKind==='relay'`; проверки членства канала,
ролей, `use_voice`, лимита мест выполняются раньше, при `voice-join`
(`src/socketHandlers/voice.js:217-247`). **IMPLEMENTED**

---

## 4. Client architecture

```
public/app.html:4862   <script src="/js/voice-relay.js">   (всегда)
voice.js VoiceManager
  ├─ voice-existing-users (voice.js:713)
  │    transport==='relay' && window.HavenRelaySession → _callTransport='relay'
  │    → _ensureRelay(code, {resync: rejoin})           (:727-732)
  ├─ _ensureRelay (:3678-3717)
  │    ├─ сессия жива + resync → session.resync() (relay:producers diff)
  │    ├─ иначе: новый HavenRelaySession + session.start()
  │    ├─ неудача/onLost → _restartRelaySoon: backoff 1s·2^n, cap 15s (:3719-3729)
  │    └─ успех → _publishRelayTracks()                 (:3712,3739-3754)
  ├─ _publishRelayTracks: publish('mic'), при screen — 'screen'(simulcast)+
  │    'screen-audio', при webcam — 'webcam'
  ├─ _onRelayTrack (:3756): source → _playAudio / _playScreenAudio /
  │    onScreenStream / onWebcamStream
  ├─ _onRelayTrackEnded (:3771): снятие тайлов/звуков
  └─ _closeRelay (:3731): снятие listeners, закрытие producers/транспортов

HavenRelaySession (public/js/voice-relay.js)
  ├─ start() (:77): relay:join → Device.load(rtpCapabilities)
  │    → createSendTransport/createRecvTransport (iceServers/iceTransportPolicy
  │      из rtcConfig — общий пул STUN/TURN)
  │    → on 'connect' → relay:connect {dtlsParameters}
  │    → on 'produce' → relay:produce {source}
  │    → listeners relay:new-producer / relay:producer-closed / relay:lost
  │    → relay:producers → _consume() каждого трека
  ├─ publish(source,track,{maxBitrate,simulcast}) (:153):
  │    существующий producer → replaceTrack; иначе transport.produce;
  │    mic: opusStereo:false, opusDtx:true, opusFec:true; screen: 2 слоя
  │    (scaleResolutionDownBy 2/1, maxBitrate top/4 и top)
  ├─ _consume (:113): relay:consume → recvTransport.consume → onTrack → relay:resume
  ├─ resync (:138): diff по relay:producers, лишние consumer'ы закрывает
  ├─ unpublish/replace/close/isLive
  └─ REQUEST_TIMEOUT_MS=12000 на каждый запрос (:19,59-69)
```

---

## 5. Signaling protocol

Все клиентские `relay:*` идут через ack: `{ok:true,...}` либо `{error}`
(`src/socketHandlers/voiceRelay.js:40-52`). Общий гейт `inRelayedCall(code)`
(`:33-37`): код `[a-f0-9]{8}`, запись `voiceUsers` есть, `entry.socketId === socket.id`,
`voiceRelay.currentKind(code)==='relay'`; иначе `{error:'Not in a relayed call'}`.

| Event | Payload | Инициатор | Что делает сервер |
| --- | --- | --- | --- |
| `relay:join` | `{code}` | клиент после `voice-existing-users` | `voiceRelay.join()` → Router + 2 транспорта; повторный join закрывает старую сессию с broadcast `relay:producer-closed` (`:54-63`) |
| `relay:connect` | `{code,transportId,dtlsParameters}` | transport `connect` (mediasoup-client) | `t.connect({dtlsParameters})` — DTLS handshake (`:65-69`) |
| `relay:produce` | `{code,transportId,kind,rtpParameters,source}` | transport `produce` | валидация `source∈{mic,screen,screen-audio,webcam}`; screen/webcam требуют активного объявления (`:76-81`); `t.produce()`; broadcast `relay:new-producer` (`:71-88`) |
| `relay:producers` | `{code}` | клиент: старт/resync | список треков звонка кроме своих (`:90-95`); ошибка `'Not in this call'` = relay перезапустился → клиент создаёт новую сессию |
| `relay:consume` | `{code,producerId,rtpCapabilities}` | клиент на каждый чужой трек | `router.canConsume` → `t.consume({paused:true})` → `{consumer}` (`:97-102`) |
| `relay:resume` | `{code,consumerId}` | клиент после onTrack | `resumeConsumer()`; для `source==='screen'` **молча** не resume, пока зритель не открыл экран (`mediasoup.js:274-281`) |
| `relay:close-producer` | `{code,producerId,source}` | `unpublish()` клиента | закрыть producer + broadcast `relay:producer-closed` (`:110-118`) |

`RELAY_EVENTS` (`voiceRelay.js:121-124`) **исключены из flood-лимитов**
(`src/socketHandlers/index.js:2227-2235`).

Сервер → клиент:

| Event | Кому | Когда |
| --- | --- | --- |
| `relay:new-producer` `{channelCode,producerId,userId,source,kind}` | `socket.to('voice:'+code)` | после `relay:produce` |
| `relay:producer-closed` `{channelCode,producerId,userId,source?}` | `voice:${code}` | unpublish, leave (`index.js:1190-1193`), rejoin-замена (`voiceRelay.js:57-61`) |
| `relay:lost` `{channelCode}` | `voice:${code}` | worker died / `stop()` (`index.js:182`) → клиент перезапускает сессию |
| `relay:ended` `{channelCode}` | `voice:${code}` | админ выключил relay → клиент переводит звонок в `direct` (`voice.js:782-794`) |

Плюс relay опирается на обычные voice-события: `voice-existing-users.transport`
(`voice.js:338,1042,1165`), `stream-watch`/`stream-unwatch` → `setWatching`
(`voice.js:740-759`).

---

## 6. Voice connection flow

Полный trace подключения **одного пользователя (User A)** к voice room в relay-режиме
(проверен по исходному коду):

```
User A                          Haven backend                       mediasoup
──────                          ──────────────                      ─────────
VoiceManager.join()             socket.on('voice-join')             —
  [voice.js:2020]                 [voice.js:208]
  getUserMedia(mic)
  → emit 'voice-join'
    {code, relay:1, ...}          проверки: канал, членство, role gate,
    [voice.js:2188]               use_voice, guests, voice_user_limit
                                   [voice.js:217-247]
                                 callKind(code, occupied) [voice.js:33-39]
                                   → voiceRelay.kindFor(): mode==='builtin'
                                     && available ? 'relay' : 'direct'
                                     [voiceRelay/index.js:93-98]
                                 voiceUsers.set(..., relayCapable:true)
  ← 'voice-existing-users'        emit [voice.js:334-339]
    {users, transport:'relay'}
  _callTransport='relay' [voice.js:727]
  → _ensureRelay(code)            —
    [voice.js:3678]
    new HavenRelaySession
    → session.start()             handle('relay:join')
      [voice-relay.js:77]          [voiceRelay.js:54-63]
      emit 'relay:join'      ───→  voiceRelay.join(code,'u<id>',userId)
                                     _room(): createRouter(MEDIA_CODECS)
                                       [mediasoup.js:153-166]
                                     peer={transports,producers,
                                           consumers,watching}
                                     2 × createWebRtcTransport
                                       ('send'/'recv') [mediasoup.js:184-198]
      ← {rtpCapabilities,          (общий WebRtcServer,
         send:{id,iceParameters,    порт 40000+ UDP/TCP,
             iceCandidates,         announcedAddress)
             dtlsParameters},
         recv:{...}}
    Device.load(rtpCapabilities)
    createSend/RecvTransport       —
      [voice-relay.js:89-90]
    emit 'relay:connect'      ───→  t.connect({dtlsParameters})
      {transportId, dtlsParameters}  [mediasoup.js:201-206]
                                       DTLS установлен (send и recv)
    emit 'relay:producers'     ───→  треки остальных участников
      ← {producers:[...]}            [voiceRelay.js:90-95]
    _consume() каждого (§8)
    _publishRelayTracks() [voice.js:3739]
    sendTransport.produce(mic)
      → 'produce' event
    emit 'relay:produce'       ───→  inRelayedCall ✓, source='mic'
      {transportId,kind:'audio',     1 producer на source
       rtpParameters,source:'mic'}   [mediasoup.js:209-220]
      ← {producerId}
                                 socket.to('voice:code')
                                   .emit('relay:new-producer',
                                     {producerId,userId,source:'mic'})
                                       [voiceRelay.js:84-86]
User B (уже в звонке)
  ← 'relay:new-producer'
  _consume({producerId})
    emit 'relay:consume'      ───→  router.canConsume → t.consume
      {producerId,                   {paused:true}
       rtpCapabilities}              [mediasoup.js:253-271]
      ← {consumer:{id,rtpParameters}}
    recvTransport.consume(...)
    onTrack → _playAudio(userId)
    emit 'relay:resume'        ───→  c.resume()
      {consumerId}                  [mediasoup.js:274-281]
  🔊 User A слышен у User B
```

Каждый шаг (файл / функция / event / инициатор / что передаётся / что происходит):

| # | Файл:строка | Функция | Event | Кто инициирует | Передаётся | Сервер | Клиент |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `voice.js:2188` | `join()` | `voice-join` | клиент A | `code`, `relay:1` | проверки доступа, `callKind()`, запись в `voiceUsers` | ждёт ответ |
| 2 | `voice.js:334` | хендлер | `voice-existing-users` | сервер | roster, `transport:'relay'`, `voiceBitrate` | `callKind(code,occupied)` фиксирует режим | `_callTransport='relay'`, `_ensureRelay()` |
| 3 | `voice-relay.js:79` | `start()` | `relay:join` | клиент A | `{code}` | `_room()` → `createRouter` + 2 транспорта | `Device.load()` |
| 4 | `voice-relay.js:94` | transport `connect` | `relay:connect` | клиент A | `transportId`, `dtlsParameters` | `t.connect()` — DTLS | `done()` |
| 5 | `voice-relay.js:109` | `start()` | `relay:producers` | клиент A | `{code}` | список треков звонка | `_consume()` каждого |
| 6 | `voice-relay.js:101` | transport `produce` | `relay:produce` | клиент A | `kind`, `rtpParameters`, `source` | `t.produce()` → `{producerId}` + broadcast | запоминает producer |
| 7 | `voiceRelay.js:84` | broadcast | `relay:new-producer` | сервер | `producerId,userId,source,kind` | `socket.to('voice:code')` | `_consume()` |
| 8 | `voice-relay.js:115` | `_consume()` | `relay:consume` | клиент B | `producerId`, `rtpCapabilities` | `canConsume`→`t.consume(paused)` | `recvTransport.consume()` |
| 9 | `voice-relay.js:123` | `_consume()` | `relay:resume` | клиент B | `consumerId` | `c.resume()` (для screen — после watch) | `onTrack` → `_playAudio()` |

**Статус: IMPLEMENTED** — закрыт интеграционным тестом `test/voiceRelay.test.js:103-175`
(join → produce → producers → consume → resume → leave → relay-off).

---

## 7. Producer lifecycle

| Фаза | Файл | Функция | Детали |
| --- | --- | --- | --- |
| Создание | `voice-relay.js:153-175` | `publish(source,track,opts)` | `sendTransport.produce({track, appData:{source}, stopTracks:false})`; transport-событие `produce` → `relay:produce` |
| Валидация | `voiceRelay.js:71-88` | `handle('relay:produce')` | `source∈{mic,screen,screen-audio,webcam}`; `screen/screen-audio` требуют `activeScreenSharers`; `webcam` — `activeWebcamUsers`; `mic` обязан быть `kind:'audio'` |
| Создание на сервере | `mediasoup.js:209-220` | `produce()` | ровно **1 producer на source** — повторный produce того же source молча закрывает старый (:214-216); `appData={source,userId}` |
| Анонс | `voiceRelay.js:84-86` | broadcast | `relay:new-producer` → остальные делают `_consume()` |
| Замена трека | `voice-relay.js:156-159,178-181` | `publish`/`replace` | смена устройства → `producer.replaceTrack()` без нового id (`voice.js:4085`) |
| Пауза | `mediasoup.js:231-236` | `setProducerPaused()` | **NOT USED** — socket-события, его вызывающего, нет (grep: только объявление и делегат `index.js:110`). Mute сделан на клиенте `track.enabled=false` (`voice.js:2512-2523`) |
| Остановка | `voice-relay.js:184-191` | `unpublish(source)` | клиент `producer.close()` → `relay:close-producer` → `closeProducer()` (`mediasoup.js:222-229`) + broadcast `relay:producer-closed` |
| Остановка при leave | `index.js:1190-1193`, `voiceRelay.js:57-61` | `handleVoiceLeave` / rejoin | `voiceRelay.leave()` возвращает id закрытых producers → broadcast `relay:producer-closed` |
| Краш worker'а | `mediasoup.js:138-149` | `_workerDied` | `onRoomLost(code)` → `relay:lost` → клиенты перезапускают сессии |

**Лимит:** max 4 producer'а на участника (по одному на source) — **IMPLEMENTED**.
**Mute → pause producer'а: NOT USED** (см. §22, изменение №1).

---

## 8. Consumer lifecycle

1. Источник: `relay:new-producer` (live) или `relay:producers` (старт/resync).
2. Клиент `_consume()` (`voice-relay.js:113-124`): дедуп по `producerId` (`:114`),
   `relay:consume` → сервер `router.canConsume` +
   `t.consume({paused:true, appData:{source,sharerId}})` (`mediasoup.js:253-271`)
   → `recvTransport.consume()` → `onTrack` → `relay:resume` →
   `opts.onTrack({userId,source,track})`.
3. `VoiceManager._onRelayTrack` (`voice.js:3756-3769`) маршрутизирует:
   `mic`→`_playAudio`, `screen-audio`→`_playScreenAudio`, `screen`→`onScreenStream`,
   `webcam`→`onWebcamStream`.
4. **Viewer-gating**: для `source==='screen'` `resumeConsumer()` молча не resume,
   пока `peer.watching` не содержит sharerId (`mediasoup.js:279`);
   `stream-watch`/`stream-unwatch` (`voice.js:730-760`) вызывают `setWatching()`
   (`mediasoup.js:284-292`) — resume/pause всех screen-consumer'ов этого sharer'а.
   Upload сервера уходит только смотрящим.
5. Закрытие: `relay:producer-closed` / `trackended` / `transportclose` / diff
   `resync()` (`voice-relay.js:126-132,141-143`) → `_dropConsumer()` →
   `onTrackEnded` → снятие тайла (`voice.js:3771-3783`).
6. Сервер: `consumer.on('producerclose'|'transportclose')` удаляет запись
   (`mediasoup.js:265-266`); `leave()` закрывает транспорты → все consumer'ы
   участника закрываются автоматически.

**Статус: IMPLEMENTED.** Замечание: `relay:resume` не возвращает, что viewer-gating
не пропустил resume — клиент видит `{ok:true}`; реальный resume придёт из
`setWatching`. Это ожидаемо, но маскирует потерю.

---

## 9. User disconnect/reconnect

### Отключение

| Сценарий | Файл | Что происходит |
| --- | --- | --- |
| Явный leave | `voice.js:489` → `index.js:1166 handleVoiceLeave` | `voiceRelay.leave()` → закрыты транспорты/producer'ы → broadcast `relay:producer-closed`; при пустой комнате `voiceRelay.callEnded()` (`index.js:1195`); Router закрывается в `mediasoup.js:302-306` |
| Socket disconnect | `index.js:2588` → `channelRotation.js:42-74 schedulePendingVoiceLeave` | **4 сек grace**; без `voice-rejoin`/`voice-join` → `handleVoiceLeave(softDisconnect)` → relay-участник удаляется |
| Rejoin с другого сокета | `voice.js:284-310,1114-1137` | старому сокету — `handleVoiceLeave` (закрывает relay-сессию), затем новый join; mute/deafen сохраняются |
| Принудительный prune | `index.js:743-806 pruneStaleVoiceUsers` | **не вызывает `voiceRelay.leave()`** → если grace-таймер не сработал, relay-peer остаётся в Router'е (утечка §18) — **PARTIAL** |
| Удаление temp-канала | `channelRotation.js:76-97 clearChannelRuntimeState` | **не трогает `voiceRelay`** → `callKinds`/relay-состояние могут остаться (утечка §18) — **PARTIAL** |
| Rotate кода канала | `channelRotation.js:143-222` | мигрирует `voiceUsers` и пр., но **не мигрирует relay rooms/callKinds** — relay-звонок на старом коде живёт отдельно — **PARTIAL / NEEDS RUNTIME TEST** |

### Reconnect

1. Socket reconnect → `app-socket.js:396,564` → `voice-rejoin`.
2. Сервер (`voice.js:956-1167`): fast-path при `pendingVoiceLeave` — ре-бинд
   `socketId` без churn'а, ответ `voice-existing-users {rejoin:true, skipRenegotiate:true}`
   (`:1038-1047`).
3. Клиент (`voice.js:729`): `_ensureRelay(code, {resync:true})` → `session.resync()`
   (`voice-relay.js:138-145`) — diff по `relay:producers`. Если relay перезапустился
   → `relay:producers` → `'Not in this call'` → **новая сессия** (`voice.js:3689-3693`).
4. Медиа-транспорты от короткого сокет-блёфа **не зависят** (отдельный UDP/DTLS) —
   аудио продолжает идти; `isLive()` (`voice-relay.js:199-203`).
5. Полный отказ (`connectionstatechange==='failed'`, `relay:lost`) → `onLost` →
   `_restartRelaySoon` — backoff `1s·2^min(n,4)`, cap 15s (`voice.js:3719-3729`),
   с проверками `inVoice/currentChannel/_callTransport/generation`.

**Статус: IMPLEMENTED** (fast-path + resync + backoff).
**Проблемы**: (а) prune и удаление temp-канала не чистят relay (утечка);
(б) если `mediasoup-client` не загрузился, клиент идёт в direct (`voice.js:724-732`) —
смешанные звонки поддерживаются. «Рестарт сервера посреди звонка» —
**NEEDS RUNTIME TEST**.

---

## 10. P2P vs SFU coexistence

Режим решается **один раз на звонок** — первым участником:

```
voice-join → callKind(code, occupied)           [voice.js:33-39]
              ├─ occupied && callKinds.has(code) → уже решённый режим
              └─ иначе kindFor(code, occupied)   [voiceRelay/index.js:93-98]
                   mode==='builtin' && MediasoupRelay.available() ? 'relay' : 'direct'
```

* Режим фиксируется в `callKinds` до `callEnded()` (пока комната не опустеет) —
  включение/выключение relay не рвёт живой звонок.
* Отключение relay админом: `apply()` → `builtin.stop()` → все callKinds →
  `'direct'` + `onRelayEnded` → клиенты получают `relay:ended` и строят
  прямые соединения (`voice.js:782-794`). **IMPLEMENTED** (тест `voiceRelay.test.js:167-173`).
* **Смешанные звонки — штатный режим**: в relay-звонке участвуют
  `relayCapable=false` клиенты (старые вкладки, если `voice-relay.js` не загрузился)
  и **боты** (`serializeVoicePeer` `voice.js:97-99`; `_isRelayedPeer`
  `voice.js:629-634` исключает ботов) — к ним продолжают строиться прямые
  `RTCPeerConnection` (`voice.js:733,773-776`).
* Обычные P2P-события `voice-offer/voice-answer/voice-ice-candidate`
  (`voice.js:431-470`) продолжают работать всегда — они обслуживают direct-пиров
  и ботов даже внутри relay-звонка.
* Bot voice (`src/botVoice.js`) имеет собственные `voice-join/voice-offer/...`
  хендлеры и **не ходит через relay**.
* Клиентская смесь: `_callTransport==='relay'` ⇒ прямые peer-соединения строятся
  только для `!_isRelayedPeer` (`voice.js:727-733`).

**Статус: IMPLEMENTED.** Ответы на вопросы §23 FAQ: полностью отключить P2P
после миграции **нельзя без доработок** (боты + старые клиенты); оставить как
fallback — уже встроено и работает.

---

## 11. Screen sharing

**Один и тот же Router — да.** Браузерный screen share идёт через тот же
mediasoup relay, что и mic:

| Этап | Файл | Детали |
| --- | --- | --- |
| Объявление | `voice.js:2658` → сервер `voice.js:558-632` | `screen-share-started {code, hasAudio}` → `activeScreenSharers`/`activeScreenSessions` → broadcast остальным (в т.ч. `hasAudio`, `transport`) |
| Публикация | `voice.js:2687-2692` | `relay.publish('screen', v, {maxBitrate, simulcast:true})` и `relay.publish('screen-audio', a)` — **два отдельных producer'а** |
| Публикация webRTC напрямую | `voice.js:2677-2686` | те же треки добавляются и в direct-пиры (для ботов/некапабельных) |
| Валидация | `voiceRelay.js:76-78` | `relay:produce` для `screen`/`screen-audio` без активного `activeScreenSharers` → ошибка `'Start the screen share first'` (закрыто тестом `voiceRelay.test.js:158-160`) |
| Simulcast | `voice-relay.js:161-167` | 2 слоя: `{scaleResolutionDownBy:2, maxBitrate:top/4}` + `{scaleResolutionDownBy:1, maxBitrate:top}`, `videoGoogleStartBitrate:1000`; `top` из `_screenBitrates` (`voice.js:113-118`: 4/8/14 Мбит по разрешению) |
| Viewer gating | `stream-watch` (`app-voice.js:1233`) → `voice.js:740-743` → `setWatching` (`mediasoup.js:284-292`); закрытие плитки → `stream-unwatch` → pause | видео экрана течёт **только смотрящим** |
| Поздние зрители | `voice.js:670-684 request-screen-renegotiate`, watchdog `_watchForScreenStream` (`voice.js:1941-1967`) | в relay-режиме `renegotiate-screen` пропускается для relay-пиров (`voice.js:1269`) — достаточно `setWatching` |

**Одновременность mic + screen video + screen audio + webcam — ДА**, все четыре
трека различимы на сервере через `appData.source` ∈ `{mic, screen, screen-audio,
webcam}` (один producer на source, `mediasoup.js:214-217`), в broadcast
`relay:new-producer` поле `source` передаётся явно (`voiceRelay.js:84-86`).
**IMPLEMENTED.**

Ограничения: simulcast — **только 2 слоя** и только для screen (не SVC);
consumer'ы **не переключают слои** по пропускной способности (нет
`setPreferredLayers`) — **PARTIAL** (см. §17).

---

## 12. Screen audio

* **Отдельный producer** `source='screen-audio'`, `kind='audio'`
  (`voice.js:3750`, `voiceRelay.js:22` — входит в `SOURCES`).
* Объявляется тем же `screen-share-started {hasAudio:true}`; сервер требует
  активный sharer-флаг (`voiceRelay.js:76-78`).
* Потребляется как обычный consumer; клиент маршрутизирует в
  `_playScreenAudio` (`voice.js:3761-3762`) — отдельный `<audio>` + gain-node
  (учитывает deafen, `voice.js:2531-2534`).
* **Viewer-gating на screen-audio НЕ распространяется** — gating есть только
  для `source==='screen'` (`mediasoup.js:279`): звук экрана resume-ится сразу.
  Для записей/фильмов это экономит видео, но **звук слушают все**, кто принял
  consumer — потенциально лишний трафик. **PARTIAL.**
* Нативный desktop-путь (§13) передаёт audio **мимо relay** — через прямое
  соединение native-screen (`voice.js:1418-1420`).

---

## 13. Native desktop capture

**Ключевой факт: нативный screen share полностью минует mediasoup.** Это
самостоятельный P2P-транспорт («Транспорт B» в `ARCHITECTURE.md` §9.2).

### Точный путь

```
Haven Desktop (Electron, ОТДЕЛЬНЫЙ репозиторий — desktop-directive.md)
  desktopCapturer / WASAPI-loopback захват
  native encoding (H264/AV1/H265) в отдельном медиа-процессе
        │  IPC bridge: window.havenDesktop.nativeScreen
        │  (public/js/voice.js:1344,1740 — getCapabilities/start/stop/
        │   addPeer/removePeer/setRemoteDescription/addIceCandidate/onSignal)
        ▼
Renderer (public/js/voice.js)
  _setupNativeScreenBridge (:1343) слушает api.onSignal
  → emit 'native-screen-offer' {code, targetUserId, sessionId, negotiationId, offer} (:1372)
  → emit 'native-screen-ice-candidate' (:1374)
        ▼
Haven backend (src/socketHandlers/nativeScreen.js:54-129)
  registerNativeScreenSignaling — ЧИСТЫЙ СИГНАЛЬНЫЙ РЕЛЕЙ (не media!):
  валидация sessionId/negotiationId, role-проверки sender/target,
  rate-limit 8 offer'ов / 10с на пару (:58-70),
  размер SDP ≤ 49152, ICE ≤ 2048 (:7,8)
  → io.to(target.socketId).emit('native-screen-offer'|'answer'|'ice-candidate')
        ▼
Клиент-зритель (voice.js:1176-1190 → _handleNativeScreenOffer :1382)
  создаёт ОТДЕЛЬНЫЙ RTCPeerConnection(this.rtcConfig) (:1390)
  setRemoteDescription → createAnswer → emit 'native-screen-answer' (:1454)
        ▼
Прямая медиа-связь Electron ↔ зритель (WebRTC, мимо relay)
  видео + аудио: ontrack → _playScreenAudio / onScreenStream (:1410-1429)
```

### API-контракт desktop ↔ Haven server

Транспорт контракта — **Socket.IO события** (не REST):

* `native-screen-offer {code,targetUserId,sessionId,negotiationId,offer}`
* `native-screen-answer {...,answer}`
* `native-screen-ice-candidate {...,candidate}`
* клиентские исходящие события перечислены в `NATIVE_SCREEN_SIGNAL_EVENTS`
  (`nativeScreen.js:13-17`), сервер отвечает теми же именами
  (`nativeScreen.js:126-128`).
* Регистрация capability: `voice-join {nativeScreenVersion:2, nativeScreenCodecs:['H264',...]}`
  (`voice.js:605-612`, `nativeScreen.js` — оба пира должны быть v2,
  `:83`), иначе `native-screen-incompatible-peer` (`voice.js:102-132`).
* Рантайм-бридж (renderer ↔ Electron) — `window.havenDesktop.nativeScreen`
  (`voice.js:1343-1380,1518-1558,1562-1576,1740-1823`), сам Electron-код
  **в этом репозитории отсутствует** — по `desktop-directive.md:4-5` Haven Desktop
  переписывается с нуля в отдельном репозитории.

### Взаимодействие с relay

* В relay-звонке нативный sharer **не публикует** ничего в relay
  (`_publishRelayTracks` пропускает screen при `_nativeScreenSharing`,
  `voice.js:3744`) — экран идёт **только P2P**, даже если весь звонок relayed.
* Косвенно relay влияет: в relay-звонке у sharer'а нет прямых `this.peers` для
  relay-capable зрителей, поэтому `api.addPeer()` на старте вызывается только для
  direct-пиров (`voice.js:1812-1820` фильтрует по `this.peers.keys()`); для
  relay-зрителей native-peer добавляется через `renegotiate-screen` /
  `request-screen-renegotiate` (`voice.js:1269-1275,1562-1576`) —
  **это работает, но завязано на side-channel, NEEDS RUNTIME TEST.**
* Пер-приложениеное аудио (WASAPI/PipeWire) живёт в desktop-репозитории; серверный
  контракт уже готов: независимые треки `screen-audio` и `mic`.

**Статус: PARTIAL** — signaling IMPLEMENTED (`nativeScreenSignaling.test.js`),
но единый SFU-путь для native capture отсутствует.

---

## 14. Authentication

* Socket.IO auth (JWT через общую middleware) — все `relay:*` обрабатываются только
  после аутентификации (`src/socketHandlers/index.js` — порядок регистрации после auth).
* Дополнительный гейт каждого `relay:*` — `inRelayedCall(code)`
  (`voiceRelay.js:33-37`): пользователь обязан числиться в `voiceUsers[code]` с
  совпадающим `socketId` и звонок должен быть `kind==='relay'`. То есть relay-события
  **невозможны вне voice-комнаты** (закрыто тестом `voiceRelay.test.js:126-128`).
* Проверка членства/ролей/`use_voice`/лимита мест выполняется при `voice-join`
  (`voice.js:217-247`) и при `voice-rejoin` (`voice.js:187-200,956-1002`) — relay
  полагается на эти проверки, сам их не повторяет. **PARTIAL**: прямой повторной
  проверки channel-membership на каждом `relay:*` нет (окно: исключение из канала
  во время звонка не рвёт relay-сессию немедленно).
* Админ-операции relay (`voice-relay-save/install/status`) — строго `socket.user.isAdmin`
  (`admin.js:556,599`) + аудит-лог (`admin.js:588,607`). **IMPLEMENTED**.

---

## 15. Permissions

| Проверка | Файл | Статус |
| --- | --- | --- |
| Членство в voice-канале | `voice.js:219-222` | IMPLEMENTED |
| Role gate канала | `voice.js:224-226` | IMPLEMENTED |
| `use_voice` permission | `voice.js:234-236` | IMPLEMENTED |
| Гости (`guests_allow_voice`) | `voice.js:239-241` | IMPLEMENTED |
| Лимит мест `voice_user_limit` | `voice.js:242-247` | IMPLEMENTED |
| Voice выключен в канале | `voice.js:228-233` | IMPLEMENTED |
| `streams_enabled` для screen | `voice.js:570-574` | IMPLEMENTED (админ может делить) |
| Screen/webcam produce требует объявления | `voiceRelay.js:76-81` | IMPLEMENTED |
| Relay только для членов звонка | `voiceRelay.js:33-44` | IMPLEMENTED |
| Только админ меняет relay | `admin.js:236,556` | IMPLEMENTED |
| Rejoin повторяет все проверки | `voice.js:187-200` | IMPLEMENTED |
| Отдельных voice-прав именно для SFU | — | отсутствует (не требуется: SFU не даёт новых прав) |

---

## 16. NAT/ICE/TURN

* **Серверный announce-адрес**: настройка `voice_relay_address` → иначе
  `detectPublicIp()` (STUN к `stun.l.google.com:19302`, `stun.cloudflare.com:3478`,
  `publicIp.js:11,62-69`) → иначе LAN-адрес (`mediasoup.js:37-44,91-95`).
  Без адреса — старт падает с понятной ошибкой (`mediasoup.js:94`).
* **Транспорт сервера**: `createWebRtcServer({listenInfos:[udp, tcp]})` — UDP и TCP
  на одном порту (`mediasoup.js:102-108`), `exposeInternalIp` для LAN-зрителей
  (`:106`).
* **Клиентские ICE**: транспорты создаются с `iceServers`/`iceTransportPolicy`
  из `rtcConfig` (`voice-relay.js:83-87`, источник — `voice.js:141-149` default
  STUN-пул + `/api/ice-servers` админ-конфиг `stun_urls`/`turn_url`
  `admin.js:153,254`; `server.js:980`).
* **TURN**: настраивается админом (`turn_url`, `turn_username`, `turn_password`)
  и применяется к relay-транспортам через `iceServers` — работает как fallback,
  когда прямой UDP/TCP до сервера закрыт. TURN URL можно проверить кнопкой
  diagnose (`voice.js:299-315`). **PARTIAL**: TURN в compose задан только через
  env-комментарий (`docker-compose.yml:35`).
* **NAT traversal для P2P-части** (direct-пиры, боты, native screen) — тот же
  `rtcConfig`, включая `_stunPreferred` пул (`voice.js:120-142`).
* **Клиентский iceTransportPolicy='relay'** поддерживается (`voice.js:201-206`)
  и пробрасывается в relay-транспорты.

**Статус: IMPLEMENTED** для сервера; **PARTIAL** — TURN считается
«настраивается вручную», автоматика проб развертывания нет.

---

## 17. Codecs and bitrate

**Codecs роутера** (`mediasoup.js:26-34`):

| Codec | Параметры |
| --- | --- |
| `audio/opus` | 48000 Hz, 2 channels |
| `video/VP8` | 90000 |
| `video/VP9` | 90000, `profile-id:2` |
| `video/H264` | 90000, `packetization-mode:1`, `profile-level-id:42e01f` (baseline) |
| `video/H264` | 90000, `packetization-mode:1`, `profile-level-id:4d0032` (main) |

**Клиентские опции** (`voice-relay.js:161-171`):

* mic: `opusStereo:false, opusDtx:true, opusFec:true` (малый трафик + устойчивость к потерям).
* screen simulcast: 2 слоя, `videoGoogleStartBitrate:1000`.
* maxBitrate screen: `_screenBitrates` (`voice.js:113-118`) — 4/8/14 Мбит по
  разрешению; `_applyScreenBitrate` дополнительно ставит cap в direct-пиры.
* Голосовой bitrate канала (`channels.voice_bitrate`) применяется к
  **direct-соединениям** через `_applyAudioBitrate` (`voice.js:3165-3180,735`) —
  в relay-режиме `publish('mic')` вызывается **без `maxBitrate`**
  (`voice.js:3743`) → **канальный лимит bitrate в SFU-режиме НЕ применяется** —
  **PARTIAL / баг** (см. §22 №2).
* `initialAvailableOutgoingBitrate: 1_000_000` на транспорт (`mediasoup.js:188`).
* Simulcast consumer'ы **не переключают слои** (нет `setPreferredLayers` /
  `setMaxSpatialLayer` в серверном коде) — слой выбирает только encoder/mediasoup
  по умолчанию. **PARTIAL.**

---

## 18. Resource management

* **Worker'ы**: 1..8 (`MAX_WORKERS`, `voiceRelay/index.js:24,32`), по одному
  порту на worker (`port..port+workers-1`), выбор worker'а — least-rooms
  (`mediasoup.js:158`).
* **Один Router на звонок**; Router закрывается, когда последний peer вышел
  (`mediasoup.js:302-306`). Состояние in-memory; рестарт сервера сбрасывает всё.
* **Лимиты участников**: `voice_user_limit` на канал (`voice.js:242-247`) —
  общий для P2P и SFU. **Жёсткого лимита «человек на relay-worker» нет** —
  ограничение только CPU/RAM/ширина канала. **PARTIAL.**
* **Лимиты producers/consumers**: 4 producer'а на участника (по source);
  consumer'ы не ограничены — каждый участник потребляет всех остальных:
  для N участников и S источников ≈ N×(N−1)×S consumer'ов; при больших N
  (десятки) трафик растёт линейно для каждого зрителя. **PARTIAL.**
* **Flood-лимиты**: `RELAY_EVENTS` исключены (`index.js:2227-2235`) —
  `relay:join/produce/consume` не rate-limit'ятся (защищает только
  `inRelayedCall` + размер payload'а). **PARTIAL.**
* **Утечки памяти (реальные, обнаружены аудитом)**:
  1. `pruneStaleVoiceUsers` (`index.js:743-806`) удаляет участника из `voiceUsers`,
     но **не вызывает `voiceRelay.leave()`** → peer, его транспорты и producer'ы
     остаются в Router'е; Router никогда не закроется ( peers.size > 0 ) —
     утечка RAM и портов до рестарта. **PARTIAL / баг.**
  2. `clearChannelRuntimeState` (`channelRotation.js:76-97`) и temp-удаление
     канала не чистят `callKinds` → рост Map. **PARTIAL.**
  3. `rotateLiveChannelState` не мигрирует relay rooms → «осиротевший» Router
     со старым кодом. **PARTIAL.**
* **CPU/RAM**: медiasoup-worker — отдельный процесс (~10 МБ бинарь + буферы),
  Node-процесс сервера держит только signaling. Никаких квот/мониторинга
  использования в коде нет. **NEEDS RUNTIME TEST.**

---

## 19. Error handling

| Ошибка | Где ловится | Реакция |
| --- | --- | --- |
| Любой `relay:*` бросает | `voiceRelay.js:40-52` | ack `{error: err.message}` — исключения не роняют процесс |
| Не в звонке / чужой сокет / не relay-режим | `inRelayedCall` | `{error:'Not in a relayed call'}` |
| Битый payload (id, source, типы) | `voiceRelay.js:66,72,98,105,111` | `{error:'Bad request'}` |
| screen/webcam без объявления | `voiceRelay.js:76-81` | `{error:'Start the screen share first'}` |
| Роутер не может consume | `voiceRelay.js:100` | `{error:'This track cannot be played here'}` |
| Нет recv-транспорта | `mediasoup.js:257` | throw → ack error |
| Relay выключен | `voiceRelay/index.js:104` | reject `'The voice relay is off'` |
| Порт занят | `mediasoup.js:114-122` | state='error', понятная ошибка админу, `stop(true)` |
| Worker died | `mediasoup.js:138-149` | удалить слот, `onRoomLost` → `relay:lost` клиентам; при нуле worker'ов state='error' |
| Тишина сервера (таймаут) | `voice-relay.js:62` | 12 с → reject → `_restartRelaySoon` |
| `connectionstatechange==='failed'` | `voice-relay.js:96-98` | `onLost` → рестарт сессии |
| Клиентские ошибки consume/announce | `voice.js:3681-3716`, `voice-relay.js:105,144` | `console.warn` + продолжение (не роняет звонок) |
| Старый/чужой сокет на `relay:join` | `voiceRelay.js:54-63` | старая сессия заменяется, пиров уведомляют |
| `apply()` при остановке | `voiceRelay/index.js:68-82` | сериализация через promise-цепочку, вызов `onRelayEnded` |

**Статус: IMPLEMENTED** — ошибки изолированы, есть backoff-рестарт.
**Пробел**: нет авто-fallback на direct, если relay **никогда не поднялся**
(например, после перезагрузки сервера с `mode='builtin'`, но не установленным
addon'ом) — `kindFor` в этом случае вернёт `'direct'` (проверка `available()`),
поэтому фактически защищено. **NEEDS RUNTIME TEST** для «port in use во время
boot».

---

## 20. Docker/deployment

* `Dockerfile:53` — `EXPOSE 3000 3001 40000/udp 40000/tcp`; базовый образ
  Debian slim именно **из-под** медiasoup (сборка worker'а, `Dockerfile:10-12`).
* `docker-compose.yml:17-21` — порты relay'а **закомментированы**: нужно вручную
  включить `"40000:40000/udp"` и `"40000:40000/tcp"` при включении relay;
  иначе транспорты не пройдут (в `status()` есть флаг `docker`,
  `voiceRelay/index.js:59`, подсказка админу).
* Установка mediasoup идёт в `<DATA_DIR>/addons/voice-relay` — DATA_DIR
  в compose маппится volume, поэтому addon переживает пересборку образа.
* TURN/TUNNEL: `docker-compose.yml:35` — `TURN_URL` опционально;
  `docs/` содержит также tunnel-режимы (`cloudflared`) — они не покрывают UDP
  медиа-порт, для relay нужен прямой порт.
* Проба доступности порта из админки: `/api/port-check` (`server.js:1789`).
* CI (`.github/workflows/*`) тесты `voiceRelay.test.js` **пропускаются**, если
  mediasoup не установлен (`test/voiceRelay.test.js:103`).

**Статус: PARTIAL** — работает, но включение relay в Docker требует ручного
редактирования compose.

---

## 21. Current limitations

1. **Это не полноценный voice SFU по умолчанию** — выключен, opt-in админом,
   и звонок остаётся смешанным (P2P для ботов/старых клиентов).
2. **Fallback на P2P отсутствует при деградации relay** (кроме `relay:ended` от
   админа): если worker мёртв и `kindFor` уже вернул `'relay'`, участники
   сидят в бесконечном `_restartRelaySoon` до починки.
3. **Утечки cleanup-путей**: `pruneStaleVoiceUsers` не вызывает
   `voiceRelay.leave()`; `clearChannelRuntimeState`/`rotateLiveChannelState`
   не чистят/не мигрируют relay-состояние (§18).
4. **Server-side mute не подключён**: `setProducerPaused` — NOT USED; mute —
   только `track.enabled=false` на клиенте (`voice.js:2512`), т.е. опущенный
   микрофон продолжает **отправлять тишину** через SFU (и подвержен локальному
   шуму/DTX-артефактам). Deafen — только клиента (`gain=0`), SFU продолжает
   слать трафик.
5. **Канальный `voice_bitrate` игнорируется в relay-режиме** (`voice.js:3743`).
6. **Нет переключения simulcast-слоев** под пропускную способность зрителя.
7. **Screen-audio без viewer-gating** — слушают все, кто сделал consume.
8. **Native desktop capture мимо SFU** — на большом звонке с нативным шером
   снова растёт mesh.
9. **Rate-limit'ов на `relay:join/produce/consume` нет** (FLOOD_EXEMPT).
10. **Однонодовое**: состояние in-memory, нет шардинга по нескольким SFU.
11. **Нет лимита «участников на worker»** и мониторинга нагрузки.
12. **E2E-шифрование voice отсутствует** — в репо есть только E2E для
    сообщений/групп (`e2e-group.js`), медиа-треки **не шифруются E2E**
    поверх DTLS (как и в P2P). **NOT APPLICABLE** к текущему voice.

---

## 22. Required changes for production voice

Каждый пункт: файл → текущая функция → что сейчас → что изменить → зачем →
риск → как протестировать.

### №1. Подключить server-side pause producer'а (mute)

* **Файл**: `src/socketHandlers/voiceRelay.js` (делегат уже есть).
* **Функция**: новый обработчик `relay:set-paused {code, producerId, paused}`
  рядом с `handle('relay:close-producer')` (`:110`) → `voiceRelay.setProducerPaused(...)`
  (`mediasoup.js:231-236`).
* **Сейчас**: `setProducerPaused` объявлен и делегирован (`voiceRelay/index.js:110`),
  но **не вызывается никем** — NOT USED. Mute — `track.enabled=false` на клиенте
  (`voice.js:2512-2523`) — SFU продолжает слать RTP с тишиной.
* **Нужно**: клиент в `toggleMute()` (`voice.js:2504`) при `_callTransport==='relay'`
  дополнительно шлёт `relay:set-paused`.
* **Зачем**: экономия upload клиента и трафика SFU на опущенных микрофонах;
  честное поле `paused` в `relay:producers` (`voiceRelay.js:246`).
* **Риск**: средний — рассинхрон «клиент думает muted, producer активен»;
  смягчается rejoin-пересозданием сессии.
* **Тест**: расширить `test/voiceRelay.test.js` — produce → `relay:set-paused` →
  `paused:true` в `relay:producers` → resume → `paused:false`.

### №2. Применять `voice_bitrate` канала в relay-режиме

* **Файл**: `public/js/voice.js`, `_publishRelayTracks()` (`:3739-3754`).
* **Сейчас**: `relay.publish('mic', mic)` — без `maxBitrate` (`:3743`);
  `voice_bitrate` действует только на direct-пиры (`_applyAudioBitrate`,
  `:3165-3180`).
* **Нужно**: `relay.publish('mic', mic, { maxBitrate: this.audioBitrate * 1000 })`
  при `this.audioBitrate > 0`.
* **Зачем**: админ-настройка лимита голосового bitrate должна работать в обоих
  режимах — сейчас в SFU она молча игнорируется. **PARTIAL.**
* **Риск**: низкий (`maxBitrate` поддерживается в `publish`, `voice-relay.js:168-170`).
* **Тест**: `voice_bitrate=32` на канале → в relay-звонке `producer.getStats()`
  показывает ≤ 32000.

### №3. Чистить relay в `pruneStaleVoiceUsers`

* **Файл**: `src/socketHandlers/index.js`, `pruneStaleVoiceUsers()` (`:743-806`).
* **Сейчас**: удаляет запись из `voiceUsers`, чистит screen/webcam-state, шлёт
  `voice-user-left`, но **не вызывает `state.voiceRelay.leave(...)`** и не шлёт
  `relay:producer-closed`.
* **Нужно**: перед `room.delete(userId)` — если `currentKind(code)==='relay'`,
  вызвать `leave()` и разослать `relay:producer-closed` по вернувшимся id
  (копия паттерна из `handleVoiceLeave`, `index.js:1190-1194`).
* **Зачем**: иначе peer остаётся в Router'е навсегда → утечка RAM/портов,
  Router не закроется (peers.size>0), а мёртвые producer'ы продолжают
  consume'иться. **Самая опасная находка аудита.**
* **Риск**: низкий — паттерн уже работает в `handleVoiceLeave`.
* **Тест**: join → убить сокет без `voice-leave` → prune через
  `get-voice-counts` → `status().people === 0`.

### №4. Чистить/мигрировать relay при удалении и rotate temp-каналов

* **Файл**: `src/channelRotation.js`, `clearChannelRuntimeState()` (`:76-97`) и
  `rotateLiveChannelState()` (`:143-222`).
* **Сейчас**: не трогают `state.voiceRelay` — `callKinds` растёт, при rotate
  Router остаётся на старом коде.
* **Нужно**: в clear — `voiceRelay.callEnded(code)` + `leave()` для peer'ов (или
  новый `voiceRelay.dropCall(code)`); в rotate — пере-именование relay rooms /
  callKinds либо форс `relay:ended` на старом коде.
* **Зачем**: temp-голосовые создаются/удаляются постоянно — утечка гарантирована.
* **Риск**: средний — rotate затрагивает живые звонки, нужен явный выбор.
* **Тест**: temp-канал + relay → удалить → `status().calls===0`; rotate при
  живом звонке → `relay:ended` либо непрерывное продолжение.

### №5. Fallback на direct при длительной недоступности relay

* **Файл**: `public/js/voice.js`, `_restartRelaySoon()` (`:3719-3729`) и/или
  `src/socketHandlers/voiceRelay.js`.
* **Сейчас**: при мёртвом relay клиент бесконечно ретраит (cap 15s), а
  `_callTransport='relay'` запрещает direct — звонок молчит до починки.
* **Нужно**: после N неудач (напр. 5) клиент эмитит `voice-rejoin` с просьбой
  пересчитать режим, либо сервер шлёт `relay:ended`, когда `builtin.start()`
  не удался (сейчас `onRoomLost` срабатывает только для уже живых комнат).
* **Зачем**: звонок не должен умирать из-за упавшего addon'а/порта.
* **Риск**: средний — массовый переход на P2P при сетевом сбое SFU; ограничить
  условием «relay недоступен > 60 с».
* **Тест**: заблокировать порт relay → вход в звонок → через N попыток участники
  слышат друг друга в direct.

### №6. Rate-limit на ресурсоёмкие `relay:*`

* **Файл**: `src/socketHandlers/index.js` (`FLOOD_EXEMPT`, `:2227-2235`) и/или
  `src/socketHandlers/voiceRelay.js`.
* **Сейчас**: `relay:join/produce/consume` полностью вне flood-контроля;
  `relay:consume` создаёт consumer без серверного дедупа (`mediasoup.js:253`).
* **Нужно**: убрать часть событий из `FLOOD_EXEMPT` либо добавить bucket'и:
  `relay:consume` ≤ 20/с, `relay:join` ≤ 5/10с на сокет.
* **Зачем**: защита RAM от спама consume/join одним участником.
* **Риск**: низкий, если сохранить исключение для пачки при входе в большой
  звонок (причина исключения — комментарий `index.js:2229-2230`).
* **Тест**: 100 `relay:consume` подряд → часть получает `{error:'rate_limited'}`,
  остальной звонок не страдает.

### №7. Переключение simulcast-слоев под зрителя

* **Файл**: `src/voiceRelay/mediasoup.js`, `consume()` (`:253-271`) + клиент.
* **Сейчас**: 2 слоя создаются (`voice-relay.js:161-167`), но
  `setPreferredLayers` не вызывается никогда — слой не адаптируется.
* **Нужно**: `consumer.setPreferredLayers()` по сигналу клиента (новое
  `relay:set-layer`) либо автоподбор; на клиенте — наблюдение за потерями
  (`consumer.getStats()`) и запрос нижнего слоя.
* **Зачем**: слабый зритель получает слой 0, а не top-слой.
* **Риск**: средний (дросселирование слоя может «прыгать»).
* **Тест**: throttling сети в DevTools → слой 0, после снятия → 1.

### №8. Единый путь для native desktop capture (стриминг в SFU)

* **Файл**: `public/js/voice.js` (`_tryStartNativeScreenShare`,
  `_publishRelayTracks:3744`) + отдельный репозиторий Haven Desktop.
* **Сейчас**: нативный шер идёт **мимо relay** (прямые `RTCPeerConnection` на
  каждого зрителя, §13); `api.addPeer()` фильтруется по `this.peers`
  (`voice.js:1813-1820`).
* **Нужно**: вариант А — добавить в Electron-бридж передачу
  `MediaStreamTrack` в renderer и публиковать его как `source='screen'`
  (серверный контракт уже готов); вариант Б — оставить P2P, но документировать
  как штатный «pro tier» транспорт.
* **Зачем**: иначе на больших звонках нативный шер снова раздувает mesh.
* **Риск**: высокий (IPC-производительность, доступ к track из renderer).
* **Тест**: 10+ зрителей → upload шерера растёт на ~1 поток (вариант А).

### №9. Gating для `screen-audio`

* **Файл**: `src/voiceRelay/mediasoup.js`, `resumeConsumer()` (`:274-281`).
* **Сейчас**: условие только `source==='screen'` — звук экрана gated **не**.
* **Нужно**: включить `source==='screen-audio'` в то же условие (и в
  `setWatching`), клиентский `stream-watch` уже отправляется.
* **Зачем**: не транслировать звук шера тем, кто не открыл плитку.
* **Риск**: низкий — поздние зрители уже получают resume через `setWatching`.
* **Тест**: закрытая плитка → `consumer.paused===true` для screen-audio;
  открыта → false.

### №10. Повторная проверка членства на `relay:*` (опционально)

* **Файл**: `src/socketHandlers/voiceRelay.js`, `inRelayedCall()` (`:33-37`).
* **Сейчас**: опирается на `voiceUsers`, не перепроверяет членство в канале.
* **Нужно**: убедиться, что **все** пути исключения/кика проходят через
  `handleVoiceLeave` (часть уже есть в `voice.js`), либо добавить редкую
  DB-проверку.
* **Зачем**: закрыть окно «исключён, но медиа течёт».
* **Риск**: низкий.
* **Тест**: исключить участника во время звонка → relay-сессия закрыта ≤ 5 с.

### №11. Мониторинг и пределы worker'ов

* **Файл**: `src/voiceRelay/mediasoup.js`, `status()` (`:66-75`).
* **Сейчас**: `status()` отдаёт state/ports/calls/people — нет per-worker
  нагрузки и нет предела звонков на worker.
* **Нужно**: лимит rooms на worker (переброска/ошибка) + `rooms/transports`
  per-worker в админ-статус.
* **Зачем**: предсказуемость на больших серверах.
* **Риск**: низкий.
* **Тест**: `workers=1`, K звонков → статус показывает распределение; при
  лимите новый звонок уходит на другой worker или получает понятную ошибку.

---

## 23. Migration plan

Фазы отвечают на «что делать в первую очередь». **Ни одна фаза не удаляет
P2P-код и не внедряет LiveKit** — только использует существующий mediasoup relay.

### Фаза 0 — Baseline (без изменений кода)

* Включить `voice_relay_mode='builtin'` в dev/staging, открыть порты
  `40000/udp+tcp` (Docker: `docker-compose.yml:17-21`).
* Прогнать `test/voiceRelay.test.js` на машине с mediasoup.
* Замерить: CPU worker'а, RAM, джиттер/MOS на звонке 5–10 человек.
* **Выход**: relay стабилен на типовых звонках.

### Фаза 1 — Надёжность (изменения №3, №4, №5)

* Починить cleanup-утечки (`pruneStaleVoiceUsers`, temp-каналы) — иначе длинные
  сессии деградируют.
* Добавить fallback на direct после N неудач — звонок не должен умирать.
* **Выход**: нет роста `status().people/calls` при суточной нагрузке.

### Фаза 2 — Паритет функций (изменения №1, №2, №9, №6)

* Server-side mute (`setProducerPaused`), `voice_bitrate` в relay, gating
  screen-audio, rate-limit'ы.
* **Выход**: поведение SFU не хуже P2P по админ-настройкам и защите.

### Фаза 3 — Качество (изменения №7, №11)

* Simulcast-слои под зрителя, лимиты/мониторинг worker'ов.
* **Выход**: стабильное видео на слабых линках.

### Фаза 4 — Desktop/native (изменение №8)

* Публикация нативного захвата в relay (отдельный репозиторий Haven Desktop,
  API-контракт §13).
* **Выход**: единый SFU-путь для всех источников.

### Фаза 5 (опционально) — SFU-only режим

Ответ на FAQ №13: режим = настройка `voice_relay_mode` + решение первого
участника. Полный SFU-only через конфигурацию **почти доступен**:
`voice_relay_mode='builtin'` делает новыми звонками relay, а `kindFor` даёт
`'direct'` только если mediasoup не установлен. До конца нужно: (а) решение
№5 регулирует fallback, (б) перевести ботов и нативный шер (№8). До этого P2P
остаётся обязательным.

### Что сохранять обязательно

* P2P mesh как fallback (смешанные звонки уже работают) — **не удалять**.
* Бот-голос (`src/botVoice.js`) — вне relay.
* REST bot/webhook API (`/api/*`), E2E для сообщений, существующие валидации
  SDP/флуд-лимиты для P2P-событий.
* `LICENSE`/`NOTICE` (AGPL-3.0): при публичной модификации — распространять
  исходники (§12 `ARCHITECTURE.md`).

---

## FAQ: ключевые вопросы аудита

**1. Можно ли полностью отключить P2P после успешной миграции?**
Нет, не без доработок: боты (`src/botVoice.js`) и нативный desktop-шер (§13)
физически не ходят через relay; клиенты без загруженного `voice-relay.js` идут в
direct (`voice.js:726-733`). P2P уже является штатным fallback'ом (§10, фаза 5).

**2. Можно ли оставить P2P как fallback?**
Да, и так уже сделано: `relay:ended` переключает живой звонок в direct
(`voice.js:782-794`), `kindFor` при невыполнении условий сразу даёт `'direct'`.
Нужен лишь авто-fallback при отказе relay (§22 №5).

**3. Есть ли полноценный voice SFU или это relay для отдельных сценариев?**
Ядро полноценное (router/transport/producer/consumer/simulcast/gating/reconnect,
интеграционный тест), но выключено по умолчанию и работает в **смешанных**
звонках. Это зрелый relay, а не SFU-only режим. Статус: **PARTIAL** (§1).

**4. Какие функции Discord-like voice отсутствуют?**
Server-side mute/deafen пауза (`setProducerPaused` — NOT USED), bitrate-лимит
канала в SFU, адаптивные simulcast-слои, gating звука экрана, авто-fallback,
пер-приложение аудио на сервере (живёт в desktop-репо), E2E media-шифрование,
мультинодовость.

**5. Что нужно для стабильных комнат с несколькими пользователями?**
Фазы 0–2 (§23): открыть порты, починить утечки №3/№4, fallback №5,
mute/bitrate №1/№2. Лимит участников — только `voice_user_limit` на канал.

**6. Есть ли проблемы с reconnect?**
В целом продумано (fast-path ре-бинд, resync, backoff). Пробелы: prune-путь не
закрывает relay-сессию (§22 №3) и нет fallback при мёртвом relay (№5).
«Рестарт сервера посреди звонка» — NEEDS RUNTIME TEST.

**7. Есть ли проблемы с cleanup?**
Да — три места: `pruneStaleVoiceUsers`, `clearChannelRuntimeState`,
`rotateLiveChannelState` (§22 №3, №4). Явный `handleVoiceLeave` чистит правильно.

**8. Есть ли потенциальные memory leaks?**
Да: (1) relay-peer в Router'е при prune (самый опасный), (2) рост `callKinds`
при temp-удалении, (3) «осиротевший» Router при rotate кода. Все — §18, §22.

**9. Есть ли race conditions?**
Закрытые: гонка двойного `_room()` (`mediasoup.js:160-161`), сериализация
`apply()` (`voiceRelay/index.js:43`). Открытые: одновременный rejoin двух сокетов
одного юзера (обрабатывается, NEEDS RUNTIME TEST); prune вне grace-окна
возможен как гонка с pendingVoiceLeave (`index.js:756`).

**10. Есть ли ограничения по числу пользователей?**
Только `voice_user_limit` на канал (общий с P2P). Жёсткого предела SFU нет —
реально CPU/RAM worker'а и upload сервера. **PARTIAL** — нет per-worker лимита
(§22 №11).

**11. Есть ли ограничения по числу producers/consumers?**
Producers: ≤4 на участника (гарантируется `mediasoup.js:214`). Consumers:
**не ограничены** ни сервером, ни rate-limit'ом — риск исчерпания ресурсов
спамом `relay:consume` (§22 №6).

**12. Как сейчас выбирается SFU/P2P режим?**
Настройка `voice_relay_mode` (`off|builtin`) × решение первого участника
`kindFor(code, occupied)` (`voiceRelay/index.js:93-98`), зафиксированное в
`callKinds` до опустения комнаты; `available()` (mediasoup установлен) —
обязательное условие.

**13. Можно ли сделать SFU-only через конфигурацию?**
Почти: `voice_relay_mode='builtin'` — новые звонки идут через relay, P2P
остаётся для ботов/некапабельных клиентов и как fallback. Полный SFU-only
требует кода (фаза 5).

---

## Итоговая таблица статусов

| Feature | Status | Files | Notes |
| --- | --- | --- | --- |
| Voice SFU | PARTIAL | `src/voiceRelay/*`, `src/socketHandlers/voiceRelay.js`, `public/js/voice-relay.js` | Ядро реализовано и протестировано; выключен по умолчанию, работает смешано с P2P |
| Mic | IMPLEMENTED | `voice.js:3743`, `voice-relay.js:153`, `mediasoup.js:209` | Opus DTX/FEC; bitrate-лимит канала не применяется (§22 №2) |
| Mute | PARTIAL | `voice.js:2504-2523`, `mediasoup.js:231` | Только клиентский `track.enabled`; `setProducerPaused` NOT USED (§22 №1) |
| Deafen | PARTIAL | `voice.js:2525-2545` | Только `gain=0` на клиенте; SFU продолжает слать трафик |
| Screen video | IMPLEMENTED | `voice.js:2687`, `voiceRelay.js:76`, `mediasoup.js:284` | Simulcast 2 слоя, viewer-gating, отдельный producer |
| Screen audio | PARTIAL | `voice.js:3750`, `mediasoup.js:274` | Producer есть, но **без viewer-gating** (§22 №9) |
| Native capture | PARTIAL | `nativeScreen.js`, `voice.js:1343-1830` | Полностью мимо SFU (прямые P2P); signaling реализован |
| Simulcast | PARTIAL | `voice-relay.js:161-167` | 2 слоя только для screen; слои не переключаются (§22 №7) |
| Reconnect | PARTIAL | `voice.js:3678-3729`, `voice-relay.js:138`, `voice.js:956` | Fast-path + resync + backoff есть; prune/fallback-дыры (§22 №3, №5) |
| Cleanup | PARTIAL | `index.js:1166,743`, `channelRotation.js:76,143` | Явный leave чистит; prune/temp/rotate — нет (утечки) |
| TURN | PARTIAL | `admin.js:153,254`, `voice.js:141`, `server.js:980` | Настройка есть и пробрасывается в relay-транспорты; требует ручной настройки |
| Permissions | IMPLEMENTED | `voice.js:217-247`, `voiceRelay.js:33-44`, `admin.js:556` | Все проверки на входе; повторной membership-проверки на `relay:*` нет (§22 №10) |
| Multi-user rooms | PARTIAL | `mediasoup.js:153-166`, `voice.js:242` | Роутер на звонок, worker-шардинг; нет лимита участников/worker'ов (§22 №11) |

---

*Аудит выполнен по состоянию коммита `46459f2`; ссылки на строки — по файлам
этой ревизии. Код приложения в рамках аудита не изменялся.*






---

















