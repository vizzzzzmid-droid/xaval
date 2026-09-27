'use strict';
/**
 * The voice relay, whichever kind the admin picked in Large Server Setup.
 *
 *   off      - calls go peer to peer, as always
 *   builtin  - mediasoup, running inside Haven (./mediasoup.js)
 *   livekit  - reserved for a LiveKit server the admin runs themselves
 *
 * The rest of Haven talks to the relay only through this module, so a second
 * kind can be added without touching the voice code that uses it.
 *
 * A call keeps the kind it started with until everyone has left, so turning
 * the relay on never splits a call in two. Turning it off (or it failing to
 * restart) moves relayed calls over to direct connections: onRelayEnded
 * tells the people in each one to connect to each other directly.
 */

const fs = require('fs');
const { MediasoupRelay } = require('./mediasoup');
const addon = require('./addon');

const MODES = ['off', 'builtin'];
const DEFAULT_PORT = 40000;
const MAX_WORKERS = 8;

function createVoiceRelay({ getSetting, onRoomLost, onRelayEnded = () => {} }) {
  const readSettings = () => {
    const port = parseInt(getSetting('voice_relay_port'), 10);
    const workers = parseInt(getSetting('voice_relay_workers'), 10);
    return {
      port: Number.isInteger(port) && port >= 1024 && port <= 65535 - MAX_WORKERS ? port : DEFAULT_PORT,
      workers: Number.isInteger(workers) && workers >= 1 ? Math.min(workers, MAX_WORKERS) : 1,
      address: String(getSetting('voice_relay_address') || '').trim(),
    };
  };
  const mode = () => {
    const m = getSetting('voice_relay_mode');
    return MODES.includes(m) ? m : 'off';
  };

  const builtin = new MediasoupRelay({ settings: readSettings, onRoomLost: (code) => relayLost(code) });
  // Restarts run one after another, so two quick saves never overlap.
  let applying = Promise.resolve();
  // code -> 'relay' | 'direct', fixed for as long as the call has anyone in it
  const callKinds = new Map();

  /**
   * A call's relay went away — its worker crashed, or the relay was stopped
   * under it. Everything it was carrying is dead media now, so the call is
   * moved onto direct connections: the kind is pinned to 'direct' (so nobody
   * is sent back into a relay that is not there) and the dead call is released
   * from the relay, rather than leaving a dead router, transports, producers
   * and consumers behind. The people in it are told to connect directly.
   */
  function relayLost(code) {
    if (callKinds.get(code) === 'relay') callKinds.set(code, 'direct');
    builtin.closeChannel(code);
    onRoomLost(code);
  }

  return {
    MODES,
    DEFAULT_PORT,
    MAX_WORKERS,
    mode,
    readSettings,
    available: () => MediasoupRelay.available(),
    // The relay engine itself, for tests and for diagnosing a live relay.
    builtin,

    status() {
      return {
        mode: mode(), available: MediasoupRelay.available(), installing: addon.isInstalling(),
        // In Docker the port also has to be mapped in docker-compose.yml.
        docker: fs.existsSync('/.dockerenv'),
        ...builtin.status(),
      };
    },

    /** Installs the media engine (Large Server Setup). */
    install: (onLine) => addon.install(onLine),

    /** Called when the admin saves relay settings: start, stop or restart. */
    apply() {
      applying = applying.catch(() => {}).then(async () => {
        await builtin.stop();
        const running = mode() === 'builtin' && await builtin.start();
        if (!running) {
          for (const [code, kind] of callKinds) {
            if (kind !== 'relay') continue;
            // Pinned to 'direct' and told to the call, so it finishes peer to
            // peer instead of waiting on a relay that is not running.
            callKinds.set(code, 'direct');
            // The relay is stopping: release what it still holds for this call,
            // so a stopped relay leaves no router or transports behind.
            builtin.closeChannel(code);
            onRelayEnded(code);
          }
        }
        return this.status();
      });
      return applying;
    },

    /** Starts the relay at boot when it is switched on. */
    async boot() {
      if (mode() === 'builtin') await builtin.start();
    },

    /**
     * Which way a call goes: decided by the first person in, kept until the
     * last one leaves. `occupied` says whether anyone is in the call already.
     */
    kindFor(code, occupied) {
      if (occupied && callKinds.has(code)) return callKinds.get(code);
      const kind = mode() === 'builtin' && MediasoupRelay.available() ? 'relay' : 'direct';
      callKinds.set(code, kind);
      return kind;
    },
    currentKind: (code) => callKinds.get(code) || null,
    callEnded(code) { callKinds.delete(code); },

    /**
     * A channel is gone (deleted, or a temp voice channel cleaned up), so
     * whatever the relay was holding for it has to go with it. This closes the
     * real mediasoup resources — transports, producers, consumers and the
     * router — rather than forgetting the code, and drops the call's kind so a
     * later call in a fresh channel starts clean. Safe to call twice.
     * @returns {boolean} whether a relayed call was released
     */
    closeChannel(code) {
      if (callKinds.get(code) === 'relay') callKinds.delete(code);
      return builtin.closeChannel(code) > 0;
    },

    /**
     * The channel code was rotated mid-call. The relayed call carries on under
     * the new code — its router and transports are still in use by the people
     * talking — so the relay is told to re-file it rather than tear it down.
     * @returns {boolean} whether the relayed call was moved across
     */
    renameChannel(oldCode, newCode) {
      if (callKinds.get(oldCode) === 'relay') {
        callKinds.delete(oldCode);
        callKinds.set(newCode, 'relay');
      }
      return builtin.renameChannel(oldCode, newCode);
    },

    /**
     * The relay could not carry this call, so the call finishes on direct
     * connections instead. The kind is pinned to 'direct' (not deleted) so
     * every later join of the same call is told 'direct' too, and the relay's
     * resources for it are released — a fallback must not leave a dead router
     * and transports behind.
     * @returns {boolean} whether this was a relayed call being moved over
     */
    fallback(code) {
      if (callKinds.get(code) !== 'relay') return false;
      callKinds.set(code, 'direct');
      builtin.closeChannel(code);
      return true;
    },

    // The relayed-call operations, passed straight to the running relay.
    join: (...a) => {
      if (mode() !== 'builtin') return Promise.reject(new Error('The voice relay is off'));
      return builtin.join(...a);
    },
    connect: (...a) => builtin.connect(...a),
    produce: (...a) => builtin.produce(...a),
    closeProducer: (...a) => builtin.closeProducer(...a),
    setProducerPaused: (...a) => builtin.setProducerPaused(...a),
    producers: (...a) => builtin.producers(...a),
    consume: (...a) => builtin.consume(...a),
    resumeConsumer: (...a) => builtin.resumeConsumer(...a),
    setWatching: (...a) => builtin.setWatching(...a),
    leave: (...a) => builtin.leave(...a),
    inCall: (...a) => builtin.inCall(...a),
  };
}

module.exports = { createVoiceRelay };
