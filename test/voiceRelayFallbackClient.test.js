'use strict';
/**
 * Client half of the SFU → P2P fallback (Phase 1 of ARCHITECTURE_SFU.md, #5).
 *
 * The server tells the call that the relay ended, or the relay session reports
 * it lost its worker. Either way the media that came through it is dead, so the
 * client has to forget the relay's state and carry the call on direct
 * connections without anybody leaving the call or reloading.
 *
 * The client is loaded the way the other voice tests load it, with a stubbed
 * DOM: what matters here is which state is dropped and which peers appear.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const VOICE_SOURCE = fs.readFileSync(path.join(ROOT, 'public/js/voice.js'), 'utf8');

function loadVoiceManager() {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      getElementById: () => null,
      createElement: () => ({ style: {}, srcObject: null, play() {} }),
      addEventListener() {}, removeEventListener() {},
    },
    // The manager only reads these to decide what is available; the fallback
    // itself must work with the relay and native screen both off.
    window: {},
    console: { log() {}, warn() {}, error() {} },
    RTCSessionDescription: function RTCSessionDescription(description) { return description; },
    setTimeout,
    clearTimeout,
    Date,
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return context.module.exports;
}

/**
 * A manager mid-way through a relayed call between A (us, id 1) and B (id 2).
 */
function relayedCallHarness(Voice) {
  const emitted = [];
  // The manager wires its socket listeners in the constructor, so the socket
  // has to be there before it is built.
  const socket = { emit(event, data) { emitted.push({ event, data }); }, on() {}, off() {} };
  const manager = new Voice(socket);
  manager.socket = socket;
  manager.inVoice = true;
  manager.currentChannel = '11111111';
  manager.localUserId = 1;
  manager._callTransport = 'relay';
  manager._voiceUserInfo = new Map([[2, { username: 'B', relayCapable: true, isBot: false }]]);
  manager._createPeer = async (userId) => { manager.peers.set(userId, { username: 'B' }); };
  return { manager, emitted };
}

test('#5 a lost relay drops the relay state and rebuilds the call peer to peer', async () => {
  const Voice = loadVoiceManager();
  const { manager, emitted } = relayedCallHarness(Voice);

  // A and B are in a relayed call, hearing each other through the relay.
  // B is not sharing screen or camera, so everything B's media produced here
  // came over the relay and is now dead.
  manager._relayPeers.add(2);
  manager._screenDelivered.add(2);
  manager.webcamUsers.add(2);
  const screenCleared = [];
  const webcamCleared = [];
  manager.onScreenStream = (userId, stream) => { if (stream === null) screenCleared.push(userId); };
  manager.onWebcamStream = (userId, stream) => { if (stream === null) webcamCleared.push(userId); };

  let closed = false;
  manager._relay = { isLive: () => true, close: () => { closed = true; } };

  // The relay dies and the server says so.
  await manager._fallbackToDirect('11111111', 'the relay lost its worker');

  assert.equal(manager._callTransport, 'direct', 'the call is direct now');
  assert.equal(closed, true, 'the relay session is closed, so no producers or consumers are left');
  assert.equal(manager._relay, null);
  // The state the relay was feeding is dropped, not left as silent media.
  assert.equal(manager._relayPeers.has(2), false);
  assert.equal(manager._screenDelivered.has(2), false);
  assert.deepEqual(screenCleared, [2], 'the relayed screen view is closed');
  assert.deepEqual(webcamCleared, [2], 'the relayed webcam view is closed');
  // B stays in the call, so it still hears A — peer to peer now, no restart.
  assert.equal(manager.inVoice, true);
  assert.equal(manager.currentChannel, '11111111');
  assert.equal(manager.peers.size, 1, 'B now has a direct peer for A');
  // We are A (id 1) and B (id 2) is the other person, so the peer is B.
  assert.equal([...manager.peers.keys()][0], 2, 'which is B');
  assert.ok(
    emitted.some(e => e.event === 'request-voice-users' && e.data.code === '11111111'),
    'and the live roster is re-fetched'
  );
});

test('#5 the fallback only applies to this relay call, and only once', async () => {
  const Voice = loadVoiceManager();
  const { manager } = relayedCallHarness(Voice);

  // Not in this call's relay: a different channel, or already direct.
  manager._callTransport = 'relay';
  manager._relay = { close() { throw new Error('another channel’s relay must not be closed'); } };
  await manager._fallbackToDirect('22222222', 'other channel');
  assert.equal(manager._callTransport, 'relay', 'another channel’s relay is left alone');
  assert.ok(manager._relay, 'and its session is not closed');

  // Already direct: nothing to fall back from, so the relay session is left as
  // it is rather than being torn down twice.
  manager._callTransport = 'direct';
  let closed = false;
  manager._relay = { close() { closed = true; } };
  await manager._fallbackToDirect('11111111', 'already direct');
  assert.equal(closed, false, 'a call that is already direct is left alone');
});
