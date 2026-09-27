'use strict';
/**
 * Built-in voice relay (mediasoup).
 *
 * Without a relay every person in a call sends their audio and video straight
 * to every other person, so each upload grows with the size of the call and
 * past about ten people it runs out. With the relay each person sends once,
 * to this server, and the server forwards it to everyone else.
 *
 * mediasoup runs its media work in separate worker processes. Each worker
 * listens on one port (UDP, with TCP on the same number as a fallback for
 * networks that block UDP), so the admin opens `port` up to
 * `port + workers - 1` and nothing else. Calls are spread across workers.
 *
 * mediasoup is installed on demand from Large Server Setup (see ./addon.js).
 * Until it is, the relay reports itself as not installed and calls keep
 * working peer to peer.
 */

const os = require('os');
const { detectPublicIp } = require('./publicIp');
const { loadMediasoup } = require('./addon');

const NOT_INSTALLED = 'The relay is not installed yet. Install it from Large Server Setup.';

// Sources that are only carried to the people actually looking at them. A
// screen share's video and its audio are one thing to the viewer: opening the
// tile starts both, closing it stops both. Carrying a screen's audio to the
// whole call is what made a silent desktop a full-rate audio stream to
// everyone, which is the cost this gating exists to avoid.
const GATED_SOURCES = new Set(['screen', 'screen-audio']);

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000, parameters: { 'profile-id': 2 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1 } },
];

/** The machine's first private IPv4 address, for people on the same network. */
function lanAddress() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

class MediasoupRelay {
  /**
   * @param {object} opts
   * @param {() => {port:number, workers:number, address:string}} opts.settings
   * @param {(code:string) => void} [opts.onRoomLost] a call's relay went away
   *        (its worker crashed); the people in it need to reconnect.
   */
  constructor({ settings, onRoomLost }) {
    this.settings = settings;
    this.onRoomLost = onRoomLost || (() => {});
    this.workers = [];          // { worker, webRtcServer, rooms: Set<code> }
    this.rooms = new Map();     // code -> { router, slot, peers: Map<peerId, Peer> }
    this.state = 'stopped';     // stopped | starting | running | error | unavailable
    this.error = null;
    this.address = null;        // what clients are told to connect to
    this._starting = null;
  }

  static available() { return !!loadMediasoup(); }

  status() {
    return {
      state: loadMediasoup() ? this.state : 'unavailable',
      error: loadMediasoup() ? this.error : NOT_INSTALLED,
      address: this.address,
      ports: this.workers.map(w => w.port),
      calls: this.rooms.size,
      people: [...this.rooms.values()].reduce((n, r) => n + r.peers.size, 0),
    };
  }

  /** Starts the workers. Safe to call again while starting or running. */
  start() {
    if (!loadMediasoup()) { this.state = 'unavailable'; this.error = NOT_INSTALLED; return Promise.resolve(false); }
    if (this.state === 'running') return Promise.resolve(true);
    if (this._starting) return this._starting;
    this._starting = this._start().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _start() {
    this.state = 'starting';
    this.error = null;
    const { port, workers, address } = this.settings();
    try {
      const lan = lanAddress();
      let announced = (address || '').trim();
      if (!announced) announced = await detectPublicIp().catch(() => null) || lan;
      if (!announced) throw new Error('Could not work out this server\'s address. Enter it under Voice relay.');
      this.address = announced;
      const listenIp = lan || '0.0.0.0';

      for (let i = 0; i < workers; i++) {
        const worker = await loadMediasoup().createWorker({ logLevel: 'warn' });
        const slot = { worker, webRtcServer: null, port: port + i, rooms: new Set() };
        worker.on('died', (err) => this._workerDied(slot, err));
        const info = (protocol) => ({
          protocol, ip: listenIp, port: slot.port,
          announcedAddress: announced,
          // People on the same network as the server reach it directly.
          exposeInternalIp: !!lan && lan !== announced,
        });
        slot.webRtcServer = await worker.createWebRtcServer({ listenInfos: [info('udp'), info('tcp')] });
        this.workers.push(slot);
      }
      this.state = 'running';
      console.log(`🔊 Voice relay running on ${this.address}, port${workers > 1 ? `s ${port}-${port + workers - 1}` : ` ${port}`} (UDP and TCP)`);
      return true;
    } catch (err) {
      this.error = /EADDRINUSE|address in use/i.test(String(err.message))
        ? `Port ${port} is already in use on this machine. Pick another under Voice relay.`
        : err.message;
      this.state = 'error';
      console.error('Voice relay failed to start:', err.message);
      await this.stop(true);
      this.state = 'error';
      return false;
    }
  }

  /** Stops everything. Every relayed call is dropped. */
  async stop(keepState = false) {
    const codes = [...this.rooms.keys()];
    this.rooms.clear();
    for (const slot of this.workers) {
      try { slot.worker.close(); } catch { /* already gone */ }
    }
    this.workers = [];
    if (!keepState) { this.state = 'stopped'; this.error = null; this.address = null; }
    for (const code of codes) this.onRoomLost(code);
  }

  _workerDied(slot, err) {
    console.error('Voice relay worker stopped unexpectedly:', err?.message || err);
    this.workers = this.workers.filter(w => w !== slot);
    for (const code of slot.rooms) {
      this.rooms.delete(code);
      this.onRoomLost(code);
    }
    if (!this.workers.length) {
      this.state = 'error';
      this.error = 'The relay stopped unexpectedly. It will restart when the next call needs it.';
    }
  }

  // ── Calls ────────────────────────────────────────────

  async _room(code) {
    let room = this.rooms.get(code);
    if (room) return room;
    if (!(await this.start())) throw new Error(this.error || 'Voice relay is not running');
    // The worker carrying the fewest calls takes the new one.
    const slot = [...this.workers].sort((a, b) => a.rooms.size - b.rooms.size)[0];
    const router = await slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    room = this.rooms.get(code);   // another join may have won the race
    if (room) { router.close(); return room; }
    room = { router, slot, peers: new Map() };
    slot.rooms.add(code);
    this.rooms.set(code, room);
    return room;
  }

  _peer(code, peerId) {
    const room = this.rooms.get(code);
    const peer = room?.peers.get(peerId);
    if (!peer) throw new Error('Not in this call');
    return { room, peer };
  }

  /** Joins a call: what the browser needs to set up its two connections. */
  async join(code, peerId, userId) {
    const room = await this._room(code);
    if (room.peers.has(peerId)) this.leave(code, peerId);
    // `watching`: sharers whose screen this person has open. Screen video is
    // only sent while it is, which is what keeps big screen shares affordable:
    // the server's upload goes to the people looking, not to the whole call.
    const peer = {
      userId,
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      watching: new Set(),
      // Server-side mute lives here, not on the producer, so a mute that
      // arrives before the mic is published (or after a rejoin rebuilds the
      // producers) is still in force when the track shows up.
      pausedSources: new Set(),
    };
    room.peers.set(peerId, peer);
    const make = async (direction) => {
      const t = await room.router.createWebRtcTransport({
        webRtcServer: room.slot.webRtcServer,
        enableUdp: true, enableTcp: true, preferUdp: true,
        initialAvailableOutgoingBitrate: 1_000_000,
        appData: { direction },
      });
      peer.transports.set(t.id, t);
      return { id: t.id, iceParameters: t.iceParameters, iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters };
    };
    return {
      rtpCapabilities: room.router.rtpCapabilities,
      send: await make('send'),
      recv: await make('recv'),
    };
  }

  async connect(code, peerId, transportId, dtlsParameters) {
    const { peer } = this._peer(code, peerId);
    const t = peer.transports.get(transportId);
    if (!t) throw new Error('Unknown connection');
    await t.connect({ dtlsParameters });
  }

  /** Starts sending one track (mic, screen, webcam...) into the call. */
  async produce(code, peerId, transportId, kind, rtpParameters, source) {
    const { peer } = this._peer(code, peerId);
    const t = peer.transports.get(transportId);
    if (!t || t.appData.direction !== 'send') throw new Error('Unknown connection');
    // One track per source: a new mic replaces the old one.
    for (const [id, p] of peer.producers) {
      if (p.appData.source === source) { p.close(); peer.producers.delete(id); }
    }
    const producer = await t.produce({ kind, rtpParameters, appData: { source, userId: peer.userId } });
    peer.producers.set(producer.id, producer);
    // A source muted before it was published (or republishing after a device
    // switch while still muted) starts paused, so the mute does not leak a
    // burst of audio to the call while the round trip catches up.
    if (peer.pausedSources.has(source)) await producer.pause();
    return producer.id;
  }

  closeProducer(code, peerId, producerId) {
    const { peer } = this._peer(code, peerId);
    const p = peer.producers.get(producerId);
    if (!p) return false;
    p.close();
    peer.producers.delete(producerId);
    return true;
  }

  async setProducerPaused(code, peerId, producerId, paused) {
    const { peer } = this._peer(code, peerId);
    const p = peer.producers.get(producerId);
    if (!p) return;
    if (paused) await p.pause(); else await p.resume();
  }

  /** Everything being sent in the call, except by `peerId` itself. */
  producers(code, peerId) {
    const room = this.rooms.get(code);
    if (!room) return [];
    const out = [];
    for (const [id, peer] of room.peers) {
      if (id === peerId) continue;
      for (const p of peer.producers.values()) {
        out.push({ producerId: p.id, userId: peer.userId, source: p.appData.source, kind: p.kind, paused: p.paused });
      }
    }
    return out;
  }

  /**
   * Starts receiving one track. Arrives paused; resume once it is wired up.
   * @param {object} [opts]
   * @param {number} [opts.micBitrate] cap for a mic, in bits per second. The
   *   channel's voice bitrate setting, which was previously only honoured on
   *   direct connections: a relayed call ignored it, so a channel capped at
   *   32 kbps still cost the server a full-rate stream per person. Applied on
   *   the receiving side, which is where the server's own bandwidth goes, and
   *   is the cap the admin asked for regardless of what the sender negotiated.
   */
  async consume(code, peerId, producerId, rtpCapabilities, { micBitrate = 0 } = {}) {
    const { room, peer } = this._peer(code, peerId);
    if (!room.router.canConsume({ producerId, rtpCapabilities })) return null;
    const t = [...peer.transports.values()].find(x => x.appData.direction === 'recv');
    if (!t) throw new Error('No receiving connection');
    const owner = [...room.peers.values()].find(p => p.producers.has(producerId));
    const source = owner?.producers.get(producerId)?.appData.source ?? null;
    const encodings = (source === 'mic' && micBitrate > 0) ? [{ maxBitrate: micBitrate }] : undefined;
    const consumer = await t.consume({
      producerId, rtpCapabilities, paused: true, encodings,
      // Recorded so the cap in force is knowable after the fact: mediasoup does
      // not report the requested maxBitrate back in the consumer's SDP.
      appData: { source, sharerId: owner?.userId ?? null, micBitrate: encodings?.[0]?.maxBitrate ?? null },
    });
    peer.consumers.set(consumer.id, consumer);
    consumer.on('producerclose', () => peer.consumers.delete(consumer.id));
    consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
    return {
      id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters,
      userId: owner?.userId ?? null, source,
    };
  }

  /** Unpauses a received track once the browser is ready for it. */
  async resumeConsumer(code, peerId, consumerId) {
    const { peer } = this._peer(code, peerId);
    const c = peer.consumers.get(consumerId);
    if (!c) return;
    // A screen's video and its audio both wait until its tile is open.
    if (GATED_SOURCES.has(c.appData.source) && !peer.watching.has(c.appData.sharerId)) return;
    await c.resume();
  }

  /** The person opened (or closed) a sharer's screen: start or stop it. */
  async setWatching(code, peerId, sharerId, watching) {
    const peer = this.rooms.get(code)?.peers.get(peerId);
    if (!peer) return;
    if (watching) peer.watching.add(sharerId); else peer.watching.delete(sharerId);
    for (const c of peer.consumers.values()) {
      if (!GATED_SOURCES.has(c.appData.source) || c.appData.sharerId !== sharerId || c.closed) continue;
      if (watching) await c.resume(); else await c.pause();
    }
  }

  /**
   * Server-side mute: stops the RTP itself, not just playback. A muted person
   * still has their producer (so unmuting is instant) but the stream stops
   * crossing the server — the other participants' consumers go silent at the
   * source instead of receiving silence-shaped packets.
   *
   * Keyed by source, not producer id, so a fresh producer (a new mic after a
   * device switch, or the one rebuilt on rejoin) is muted the same way the old
   * one was, and a mute that arrives before the mic is published still sticks.
   * @returns {Promise<number>} how many producers changed
   */
  async setPeerSourcePaused(code, peerId, source, paused) {
    const peer = this.rooms.get(code)?.peers.get(peerId);
    if (!peer) return 0;
    if (paused) {
      if (peer.pausedSources.has(source)) return 0;
      peer.pausedSources.add(source);
    } else {
      if (!peer.pausedSources.has(source)) return 0;
      peer.pausedSources.delete(source);
    }
    let changed = 0;
    for (const p of peer.producers.values()) {
      if (p.appData.source !== source) continue;
      if (paused) { if (!p.paused) { await p.pause(); changed++; } }
      else if (p.paused) { await p.resume(); changed++; }
    }
    return changed;
  }

  /** What this person has muted at the relay, so a rejoin can restore it. */
  pausedSources(code, peerId) {
    const peer = this.rooms.get(code)?.peers.get(peerId);
    return peer ? [...peer.pausedSources] : [];
  }

  /** Leaves a call. Returns the ids of the tracks that stopped. */
  leave(code, peerId) {
    const room = this.rooms.get(code);
    const peer = room?.peers.get(peerId);
    if (!peer) return [];
    const closed = [...peer.producers.keys()];
    for (const t of peer.transports.values()) { try { t.close(); } catch { /* gone */ } }
    room.peers.delete(peerId);
    if (!room.peers.size) {
      try { room.router.close(); } catch { /* gone */ }
      room.slot.rooms.delete(code);
      this.rooms.delete(code);
    }
    return closed;
  }

  /**
   * Releases everything one call held in the relay: every peer's producers,
   * consumers and transports, then its router, and its place in the worker.
   * Used when the call's channel is deleted or its code rotated, where the
   * people are gone from the call as a whole rather than one at a time.
   * Safe to call again, and safe on a call whose mediasoup objects have already
   * gone (a worker crash leaves handles that throw when closed).
   * @returns {number} how many peers were released
   */
  closeChannel(code) {
    const room = this.rooms.get(code);
    if (!room) return 0;
    // Drop it first, so a peer disappearing mid-teardown cannot close the
    // router twice or put the call back in a worker slot.
    this.rooms.delete(code);
    try { room.slot.rooms.delete(code); } catch { /* gone */ }
    for (const peer of room.peers.values()) {
      for (const p of peer.producers.values()) { try { p.close(); } catch { /* gone */ } }
      for (const c of peer.consumers.values()) { try { c.close(); } catch { /* gone */ } }
      for (const t of peer.transports.values()) { try { t.close(); } catch { /* gone */ } }
      peer.producers.clear();
      peer.consumers.clear();
      peer.transports.clear();
      peer.watching.clear();
    }
    const count = room.peers.size;
    room.peers.clear();
    try { room.router.close(); } catch { /* gone */ }
    return count;
  }

  /** A call's code changed while it was live: carry the relay over with it. */
  renameChannel(oldCode, newCode) {
    if (oldCode === newCode) return false;
    const room = this.rooms.get(oldCode);
    if (!room) return false;
    // Something is already filed under the new code (a call that started after
    // the rotation). Only one router per code is possible, so the old call is
    // released rather than silently orphaned, holding a worker slot forever.
    if (this.rooms.has(newCode)) { this.closeChannel(oldCode); return false; }
    this.rooms.delete(oldCode);
    this.rooms.set(newCode, room);
    try {
      room.slot.rooms.delete(oldCode);
      room.slot.rooms.add(newCode);
    } catch { /* worker already gone */ }
    return true;
  }

  inCall(code, peerId) {
    return !!this.rooms.get(code)?.peers.has(peerId);
  }
}

module.exports = { MediasoupRelay, MEDIA_CODECS };
