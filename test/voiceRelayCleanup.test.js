'use strict';
/**
 * Voice relay cleanup and fallback (Phase 1 of ARCHITECTURE_SFU.md).
 *
 * Three regressions are covered, all against the real relay classes rather than
 * a mock, because the bugs were about mediasoup objects that a mock cannot
 * faithfully reproduce:
 *
 *   #3 a person pruned out of a relayed call (their socket died without a clean
 *      leave) must be torn out of the relay too, or their transports stay open
 *      and the call never empties so the router is never closed;
 *   #4 a temporary channel being deleted releases the relay resources it held,
 *      while a live call carries over a code rotation instead of being dropped;
 *   #5 when the relay cannot carry a call any more, the call is pinned to
 *      direct connections and its dead relay resources are released.
 *
 * Also pinned: cleanup is idempotent (a disconnect racing a prune must not
 * throw), and closing one channel's call leaves another channel's call alone.
 *
 * The relay tests need mediasoup, which a normal install fetches on demand from
 * Large Server Setup; they skip without it:
 *   npm install --no-save mediasoup@3.27.1
 *   node --test test/voiceRelayCleanup.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MediasoupRelay } = require('../src/voiceRelay/mediasoup');
const { createVoiceRelay } = require('../src/voiceRelay');
const { clearChannelRuntimeState, rotateLiveChannelState } = require('../src/channelRotation');

let haveMediasoup = false;
try { require.resolve('mediasoup'); haveMediasoup = true; } catch { /* skipped */ }

const PORT = 40455;
const ADDRESS = '127.0.0.1';
// Enough for a real mediasoup handshake: these tests are about who owns which
// resources, not about codecs.
const RTP = {
  codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: { useinbandfec: 1 } }],
  headerExtensions: [],
  // mediasoup maps each encoding back to a stream, so it needs the ssrc the
  // browser would have picked.
  encodings: [{ ssrc: 1000001 }],
  rtcp: { cname: 'test', reducedSize: true },
};

/** A relay with one worker on a fixed port, torn down when the test ends. */
function createRelay(t, onRoomLost = () => {}) {
  const relay = new MediasoupRelay({
    settings: () => ({ port: PORT, workers: 1, address: ADDRESS }),
    onRoomLost,
  });
  t.after(async () => { await relay.stop(); });
  return relay;
}

/** Joins a peer with its two transports, as relay:join does. */
async function joinPeer(relay, code, peerId) {
  const joined = await relay.join(code, peerId, Number(peerId.replace('u', '')));
  return { send: joined.send, recv: joined.recv };
}

/** Alice sends a track that Bob receives, the shape of a working relayed call. */
async function pairTalking(relay, code) {
  const alice = await joinPeer(relay, code, 'u1');
  const bob = await joinPeer(relay, code, 'u2');
  const producer = await relay.produce(code, 'u1', alice.send.id, 'audio', RTP, 'mic');
  const consumed = await relay.consume(code, 'u2', producer, RTP);
  assert.ok(consumed, 'Bob was receiving Alice');
  return { alice, bob, producer };
}

/** The runtime state shape clearChannelRuntimeState and rotation expect. */
function runtimeState(voiceRelay, extra = {}) {
  return {
    voiceRelay,
    channelUsers: new Map(), voiceUsers: new Map(), activeMusic: new Map(),
    musicQueues: new Map(), activeScreenSharers: new Map(),
    activeScreenSessions: new Map(), activeWebcamUsers: new Map(),
    streamViewers: new Map(), pendingTempDelete: new Map(), pendingVoiceLeave: new Map(),
    nativeScreenOfferWindows: new Map(),
    ...extra,
  };
}

const stubIo = () => ({
  sockets: { adapter: { rooms: new Map() }, sockets: new Map() },
  to() { return { to() { return { emit() {} }; } }; },
});


test('#3 a person pruned out of a relayed call is torn out of the relay', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { producer } = await pairTalking(relay, '11111111');
  assert.equal(relay.inCall('11111111', 'u1'), true);
  assert.equal(relay.inCall('11111111', 'u2'), true);

  // What pruneStaleVoiceUsers does for somebody whose socket died without a
  // clean leave: remove them from the room, then release their relay session.
  // Bob was only receiving, so nothing of his stops for the rest of the call.
  const closed = relay.leave('11111111', 'u2');

  assert.deepEqual(closed, [], 'the ghost was not sending anything, so no track is reported as stopped');
  assert.equal(relay.inCall('11111111', 'u2'), false, 'the stale peer is gone from the router');
  assert.equal(relay.inCall('11111111', 'u1'), true, 'the rest of the call is untouched');
  assert.equal(relay.rooms.has('11111111'), true, 'the call keeps running for the others');
  // Alice's own track is untouched and still has a consumer waiting.
  assert.equal(relay.rooms.get('11111111').peers.get('u1').producers.size, 1);
  assert.equal(relay.rooms.get('11111111').peers.get('u1').consumers.size, 0);
});

test('#3 the router is closed once the last stale user is pruned', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  await pairTalking(relay, '11111111');
  const router = relay.rooms.get('11111111').router;

  relay.leave('11111111', 'u1');
  relay.leave('11111111', 'u2');

  assert.equal(relay.rooms.has('11111111'), false, 'the empty call is dropped from the relay');
  assert.equal(router.closed, true, 'so the router is closed and stops holding its port');
});

test('relay cleanup is idempotent and never throws', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  await pairTalking(relay, '11111111');
  const peer = relay.rooms.get('11111111').peers.get('u1');
  const send = [...peer.transports.values()][0];

  // A disconnect and a stale prune can land on the same ghost; the second pass
  // must find nothing and throw nothing.
  relay.leave('11111111', 'u1');
  assert.deepEqual(relay.leave('11111111', 'u1'), [], 'the second pass reports nothing to close');
  assert.doesNotThrow(() => relay.leave('11111111', 'u1'));
  assert.doesNotThrow(() => relay.leave('deadbeef', 'u9'), 'a call that is not here is not an error');
  assert.equal(relay.inCall('11111111', 'u1'), false);
  assert.equal(send.closed, true);

  // Same for the whole-channel teardown, and for a call whose mediasoup objects
  // are already gone (a worker crash leaves handles that throw when closed).
  await pairTalking(relay, '22222222');
  for (const transport of relay.rooms.get('22222222').peers.get('u1').transports.values()) {
    transport.close = () => { throw new Error('transport already closed'); };
  }
  assert.doesNotThrow(() => relay.closeChannel('22222222'));
  assert.doesNotThrow(() => relay.closeChannel('22222222'), 'closing the same call twice is safe');
  assert.equal(relay.rooms.has('22222222'), false);
});

test('#4 deleting a channel releases the relay resources it held', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  await pairTalking(relay, '11111111');
  const room = relay.rooms.get('11111111');
  const router = room.router;
  const peer = room.peers.get('u1');
  const producer = [...peer.producers.values()][0];

  // What the temp-channel delete callback does once the row is gone.
  const state = runtimeState(relay, {
    voiceUsers: new Map([['11111111', new Map([[1, { id: 1 }]])]]),
  });
  clearChannelRuntimeState(state, '11111111');

  assert.equal(router.closed, true, 'the router is closed, not merely forgotten');
  assert.equal(producer.closed, true, 'the producer is closed');
  for (const transport of peer.transports.values()) {
    assert.equal(transport.closed, true, 'the transports are closed');
  }
  assert.equal(peer.transports.size, 0, 'and released');
  assert.equal(relay.rooms.has('11111111'), false, 'the call is gone from the relay');
  assert.equal(state.voiceUsers.has('11111111'), false, 'the voice room is dropped too');
});

test('#4 releasing one channel leaves another live call working', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  await pairTalking(relay, '11111111');
  const keeper = await pairTalking(relay, '22222222');
  const keptRouter = relay.rooms.get('22222222').router;

  const state = runtimeState(relay, {
    voiceUsers: new Map([['11111111', new Map()], ['22222222', new Map([[2, { id: 2 }]])]]),
  });
  clearChannelRuntimeState(state, '11111111');

  assert.equal(relay.rooms.has('11111111'), false, 'the deleted channel’s call is gone');
  assert.equal(relay.rooms.has('22222222'), true, 'the other call is still here');
  assert.equal(keptRouter.closed, false, 'and its router was not closed');
  assert.equal(relay.inCall('22222222', 'u1'), true);
  assert.equal(relay.inCall('22222222', 'u2'), true);
  // Its peers are untouched, so the call keeps working: another track still flows.
  const more = await relay.produce('22222222', 'u1', keeper.alice.send.id, 'audio', RTP, 'mic');
  assert.ok(await relay.consume('22222222', 'u2', more, RTP), 'the other call still carries media');
  assert.equal(state.voiceUsers.has('22222222'), true, 'its voice room is untouched');
});

test('#4 rotating a channel code moves the live call instead of dropping it', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { alice } = await pairTalking(relay, '11111111');
  const room = relay.rooms.get('11111111');

  const state = runtimeState(relay, {
    voiceUsers: new Map([['11111111', new Map([[1, { id: 1 }]])]]),
    channelUsers: new Map([['11111111', new Map()]]),
  });
  rotateLiveChannelState(stubIo(), state, 7, '11111111', '33333333');

  assert.equal(relay.rooms.has('33333333'), true, 'the call is filed under the new code');
  assert.equal(relay.rooms.has('11111111'), false, 'the old code holds no call');
  assert.equal(room.router.closed, false, 'the router is still in use, so it stays up');
  assert.equal(room.slot.rooms.has('33333333'), true, 'the worker slot follows the call');
  assert.equal(relay.inCall('33333333', 'u1'), true, 'the people are still in the call');
  assert.equal(state.voiceUsers.has('33333333'), true, 'the roster moved across');
  assert.equal(state.voiceUsers.has('11111111'), false);
  assert.equal(state.channelUsers.has('33333333'), true);
});

test('#5 a lost relay falls the call back to direct and leaves nothing behind', async (t) => {
  const relay = createVoiceRelay({
    getSetting: (key) => ({ voice_relay_mode: 'builtin' })[key] ?? null,
    onRoomLost: () => {},
  });
  const inner = relay.builtin;
  t.after(async () => { await inner.stop(); });

  // Pin the call as relayed, as the first person joining does, then stand in
  // for a live call inside the running relay.
  assert.equal(relay.kindFor('11111111', false), 'relay');
  await inner.start();
  await pairTalking(inner, '11111111');
  const room = inner.rooms.get('11111111');
  const router = room.router;
  const peer = room.peers.get('u1');
  const producer = [...peer.producers.values()][0];
  const transports = [...peer.transports.values()];

  assert.equal(relay.fallback('11111111'), true, 'the relay could not carry it');

  assert.equal(relay.currentKind('11111111'), 'direct', 'the call finishes direct');
  assert.equal(relay.kindFor('11111111', true), 'direct', 'anyone joining later is told direct, not relay');
  assert.equal(inner.rooms.has('11111111'), false, 'no dead call is left in the relay');

// ── Client side: relay:ended must leave no SFU state behind ──────────────

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');

/** A VoiceManager loaded from source, with a socket whose events we can fire. */
function loadVoiceManager() {
  const handlers = new Map();
  const socket = { id: 's1', user: { id: 2 }, on: (e, h) => handlers.set(e, h), emit() {} };
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console: { log() {}, warn() {}, error() {} },
    RTCSessionDescription: (d) => d,
    // The fallback rebuilds the call peer to peer, so a peer connection is
    // constructed for real. It never gets to connect here; the assertions are
    // about which peers were (re)built, not about media.
    RTCPeerConnection: class {
      constructor() {
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
      }
      addEventListener() {}
      removeEventListener() {}
      createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
      createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
      setLocalDescription() { return Promise.resolve(); }
      setRemoteDescription() { return Promise.resolve(); }
      addIceCandidate() { return Promise.resolve(); }
      getSenders() { return []; }
      getReceivers() { return []; }
      close() { this.connectionState = 'closed'; }
    },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    document: { getElementById: () => null, createElement: () => ({ style: {}, addEventListener() {}, setAttribute() {} }) },
    window: {},
    setTimeout, clearTimeout, Date, Promise, Math, JSON, Map, Set, Object, Array, Number, String, Error, Boolean,
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  const VoiceManager = context.module.exports;
  const voice = new VoiceManager(socket);
  voice.socket = socket;
  voice.inVoice = true;
  voice.currentChannel = '11111111';
  voice._callTransport = 'relay';
  return { voice, socket, handlers, fire: (event, data) => handlers.get(event)?.(data) };
}

/** A relay session stand-in that records that it was torn down. */
function fakeRelaySession(voice) {
  const session = {
    code: '11111111',
    closed: false,
    isLive: () => true,
    close() { this.closed = true; },
  };
  voice._relay = session;
  return session;
}

test('#5 relay:ended moves the client to direct and drops the relay session', async () => {
  const { voice, fire } = loadVoiceManager();
  const session = fakeRelaySession(voice);
  voice._relayPeers.add(7);
  voice._voiceUserInfo.set(7, { username: 'peer', relayCapable: true });
  voice._screenDelivered.add(7);
  const ended = [];
  voice.onScreenStream = (userId, stream) => ended.push(['screen', userId, stream]);

  await fire('relay:ended', { channelCode: '11111111' });

  assert.equal(voice._callTransport, 'direct', 'the call is direct from here on');
  assert.equal(voice._relay, null, 'the SFU session is released');
  assert.equal(session.closed, true, 'and actually closed');
  assert.equal(voice._relayRetryTimer, undefined, 'no retry timer is left to restart the dead relay');
  assert.equal(voice._relayPeers.has(7), false, 'the relayed path is forgotten');
  assert.equal(voice._screenDelivered.has(7), false, 'the dead screen view is closed');
  assert.deepEqual(ended[0], ['screen', 7, null]);
});

test('#5 relay:ended is ignored for another channel and for a call already direct', async () => {
  const { voice, fire } = loadVoiceManager();
  const session = fakeRelaySession(voice);
  await fire('relay:ended', { channelCode: '22222222' });
  assert.equal(voice._callTransport, 'relay', 'another channel’s fallback does not touch this call');
  assert.equal(session.closed, false);

  voice._callTransport = 'direct';
  await fire('relay:ended', { channelCode: '11111111' });
  assert.equal(voice._relay, session, 'a direct call has no relay session to close');
  assert.equal(session.closed, false, 'and nothing is torn down twice');
});

  assert.equal(router.closed, true, 'its router is closed');
  assert.equal(producer.closed, true, 'its producers are closed');
  for (const transport of transports) {
    assert.equal(transport.closed, true, 'its transports are closed');
  }
  assert.equal(peer.transports.size, 0, 'and released');

  // A second failure signal must not undo the fallback, and a call that was
  // never relayed is not "fallen back".
  assert.equal(relay.fallback('11111111'), false, 'it falls back once');
  assert.equal(relay.currentKind('11111111'), 'direct');
  assert.doesNotThrow(() => relay.fallback('deadbeef'));
});

test('#5 turning the relay off moves every relayed call over to direct', async (t) => {
  let mode = 'builtin';
  const ended = [];
  const relay = createVoiceRelay({
    getSetting: (key) => ({ voice_relay_mode: mode })[key] ?? null,
    onRoomLost: (code) => ended.push(code),
    onRelayEnded: (code) => ended.push(code),
  });
  t.after(async () => { await relay.builtin.stop(); });
  assert.equal(relay.kindFor('11111111', false), 'relay');
  assert.equal(relay.kindFor('22222222', false), 'relay');

  mode = 'off';
  await relay.apply();

  assert.deepEqual(ended.sort(), ['11111111', '22222222'], 'each call is told to carry on directly');
  assert.equal(relay.currentKind('11111111'), 'direct', 'and stays direct, not sent back into the relay');
  assert.equal(relay.currentKind('22222222'), 'direct');
});
