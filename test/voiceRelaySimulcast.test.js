'use strict';
/**
 * Phase 3 of ARCHITECTURE_SFU.md: simulcast layer selection.
 *
 * Needs mediasoup, which a normal install fetches on demand:
 *   npm install --no-save mediasoup@3.27.1
 *   node --test test/voiceRelaySimulcast.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { MediasoupRelay } = require('../src/voiceRelay/mediasoup');
const registerVoiceRelay = require('../src/socketHandlers/voiceRelay');

const ADDRESS = '127.0.0.1';
const RTP = {
  codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: { useinbandfec: 1 } }],
  headerExtensions: [],
  encodings: [{ ssrc: 3000001 }],
  rtcp: { cname: 'test', reducedSize: true },
};
const VIDEO_RTP = {
  codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96, parameters: { 'x-google-start-bitrate': 1000 } }],
  headerExtensions: [],
  encodings: [{ ssrc: 3000002 }],
  rtcp: { cname: 'test', reducedSize: true },
};

// Each relay binds one UDP port, and a test file runs its cases concurrently,
// so every case gets a port of its own instead of fighting over one.
let nextPort = 40470;
function makeRelay(t, settings) {
  const relay = new MediasoupRelay({
    settings: settings || (() => ({ port: nextPort++, workers: 1, address: ADDRESS })),
    onRoomLost() {},
  });
  t.after(async () => { await relay.stop(); });
  return relay;
}
const createRelay = (t) => makeRelay(t);

async function joinPeer(relay, code, peerId) {
  return relay.join(code, peerId, Number(peerId.replace('u', '')));
}

let nextSsrc = 3000001;
const audioRtp = () => ({ ...RTP, encodings: [{ ssrc: nextSsrc++ }] });
const videoRtp = () => ({ ...VIDEO_RTP, encodings: [{ ssrc: nextSsrc++ }] });
/** A screen share, as the client publishes it: two encodings, half and full. */
const screenRtp = () => ({ ...VIDEO_RTP, encodings: [{ ssrc: nextSsrc++ }, { ssrc: nextSsrc++ }] });
const producerOf = (relay, code, peerId, source) => {
  const peer = relay.rooms.get(code).peers.get(peerId);
  return [...peer.producers.values()].find(p => p.appData.source === source);
};
const consumerOf = (relay, code, peerId, source) => {
  const peer = relay.rooms.get(code).peers.get(peerId);
  return [...peer.consumers.values()].find(c => c.appData.source === source);
};

/** Alice, in a call, sharing her screen. */
async function sharing(relay, code = '11111111') {
  const alice = await joinPeer(relay, code, 'u1');
  const screen = await relay.produce(code, 'u1', alice.send.id, 'video', screenRtp(), 'screen');
  return { alice, screen };
}

/** The socket layer with a stub relay, for what it must refuse before any relay call. */
function socketHarness() {
  const handlers = new Map();
  const relay = { calls: [], currentKind: () => 'relay', inCall: () => true };
  relay.setPreferredLayers = async (code, peerId, producerId, opts) => {
    relay.calls.push({ code, peerId, producerId, opts });
    return { spatialLayer: opts.spatialLayer, temporalLayer: opts.temporalLayer };
  };
  const socket = {
    id: 's1',
    user: { id: 1, username: 'alice' },
    on: (event, fn) => handlers.set(event, fn),
    emit() {},
    to() { return { emit() {} }; },
  };
  registerVoiceRelay(socket, {
    io: { sockets: { sockets: new Map() } },
    state: { voiceUsers: new Map([['11111111', new Map([[1, { id: 1, socketId: 's1' }]])]]), voiceRelay: relay },
    floodCheck: () => false,
    micBitrate: () => 0,
  });
  return {
    relay,
    call: (event, payload) => new Promise((resolve) => handlers.get(event)(payload, resolve)),
  };
}



// ── 1. Simulcast layer selection ──────────────────────────────

test('#1 the screen really is published with two layers', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { screen } = await sharing(relay);
  await joinPeer(relay, '11111111', 'u2');
  const view = await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  // The client publishes scaleResolutionDownBy 2 and 1, so layer 0 is half size
  // and layer 1 full. There is no third layer to invent.
  assert.equal(view.spatialLayer, null, 'an un-narrowed viewer is served the top layer');
  const encodings = consumerOf(relay, '11111111', 'u2', 'screen').rtpParameters.encodings;
  assert.equal(encodings.length, 1, 'a consumer is forwarded one encoding at a time, its own');
});

test('#1 a viewer gets the layer it asks for, and only its own moves', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { screen } = await sharing(relay);
  await joinPeer(relay, '11111111', 'u2');
  await joinPeer(relay, '11111111', 'u3');
  await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  await relay.consume('11111111', 'u3', screen, VIDEO_RTP);
  const bob = consumerOf(relay, '11111111', 'u2', 'screen');
  const carol = consumerOf(relay, '11111111', 'u3', 'screen');
  const sharer = producerOf(relay, '11111111', 'u1', 'screen');

  // Bob's link is weak, so he asks for the small layer.
  assert.deepEqual(
    await relay.setPreferredLayers('11111111', 'u2', screen, { spatialLayer: 0 }),
    { spatialLayer: 0, temporalLayer: null },
    'the relay settles on layer 0 for him'
  );
  assert.equal(bob.appData.spatialLayer, 0);
  assert.equal(carol.appData.spatialLayer, null, 'Carol keeps the full picture');
  assert.equal(sharer.closed, false, 'the sharer keeps sending exactly as before');

  // Bob's link recovers: null means "the top layer".
  assert.deepEqual(
    await relay.setPreferredLayers('11111111', 'u2', screen, { spatialLayer: null }),
    { spatialLayer: 1, temporalLayer: null },
    'and the top real layer is what comes back'
  );
  assert.equal(bob.appData.spatialLayer, 1);
  assert.equal(carol.appData.spatialLayer, null, 'still without disturbing Carol');
});

test('#1 a layer the producer does not send is clamped to a real one', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { screen } = await sharing(relay);
  await joinPeer(relay, '11111111', 'u2');
  await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  const bob = consumerOf(relay, '11111111', 'u2', 'screen');

  // A client that believes in three layers gets the top real one, not an error
  // and not a stream the relay cannot forward.
  assert.equal((await relay.setPreferredLayers('11111111', 'u2', screen, { spatialLayer: 2 })).spatialLayer, 1);
  assert.equal(bob.appData.spatialLayer, 1);
  assert.equal((await relay.setPreferredLayers('11111111', 'u2', screen, { spatialLayer: 0 })).spatialLayer, 0);
  assert.equal(bob.appData.spatialLayer, 0);
});

test('#1 somebody else\'s screen cannot be moved, and a missing one is refused', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { screen } = await sharing(relay);
  await joinPeer(relay, '11111111', 'u2');
  await joinPeer(relay, '11111111', 'u3');
  await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  const bob = consumerOf(relay, '11111111', 'u2', 'screen');

  // Bob guessing a producer he does not receive, or naming a call he is not in.
  await assert.rejects(() => relay.setPreferredLayers('11111111', 'u3', screen, { spatialLayer: 0 }), /not receiving/i);
  await assert.rejects(() => relay.setPreferredLayers('deadbeef', 'u2', screen, { spatialLayer: 0 }), /not in this call/i);
  assert.equal(bob.appData.spatialLayer, null, 'his own screen is untouched by the attempt');
  assert.equal(relay.inCall('11111111', 'u2'), true, 'and the call carries on');
});

test('#1 a voice and a screen\'s audio have no layer to choose', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  const mic = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  const screenAudio = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'screen-audio');
  await relay.consume('11111111', 'u2', mic, RTP);
  await relay.consume('11111111', 'u2', screenAudio, RTP);

  // Both have a single encoding, so there is nothing to pick: saying so beats
  // pretending the call worked, and neither is left changed by the attempt.
  await assert.rejects(() => relay.setPreferredLayers('11111111', 'u2', mic, { spatialLayer: 0 }), /no quality layers/);
  await assert.rejects(() => relay.setPreferredLayers('11111111', 'u2', screenAudio, { spatialLayer: 0 }), /no quality layers/);
});

test('#1 narrowing a layer does not disturb the viewer-gating', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const { screen } = await sharing(relay);
  await joinPeer(relay, '11111111', 'u2');
  await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  const bob = consumerOf(relay, '11111111', 'u2', 'screen');

  assert.equal(bob.paused, true, 'a screen nobody is looking at is still not being sent');
  await relay.setPreferredLayers('11111111', 'u2', screen, { spatialLayer: 0 });
  assert.equal(bob.paused, true, 'choosing a layer does not start the stream');

  await relay.setWatching('11111111', 'u2', 1, true);
  assert.equal(bob.paused, false, 'opening the tile does');
  assert.equal(bob.appData.spatialLayer, 0, 'and the chosen layer is still the one in force');
});

test('#1 the socket refuses a layer that is not a plain number', async () => {
  // The relay clamps a number; it is the socket's job to reject the rest, so a
  // client cannot pass a string or an object through to mediasoup.
  const { relay, call } = socketHarness();
  for (const opts of [
    { spatialLayer: 'high' },
    { spatialLayer: 1.5 },
    { spatialLayer: NaN },
    { spatialLayer: {}, temporalLayer: 1 },
    { temporalLayer: 'x' },
  ]) {
    const reply = await call('relay:set-preferred-layers', { code: '11111111', producerId: 'abcdef01', ...opts });
    assert.match(reply.error, /Bad request/, `refused: ${JSON.stringify(opts)}`);
  }
  // A producer id that could not be a mediasoup id, and the wrong channel.
  assert.match((await call('relay:set-preferred-layers', { code: '11111111', producerId: 'nope!', spatialLayer: 0 })).error, /Bad request/);
  assert.match((await call('relay:set-preferred-layers', { code: '22222222', producerId: 'abcdef01', spatialLayer: 0 })).error, /Not in a relayed call/);
  assert.equal(relay.calls.length, 0, 'none of those reached the relay');
});

test('#1 a valid request reaches the relay under the caller\'s own peer', async () => {
  const { relay, call } = socketHarness();
  const reply = await call('relay:set-preferred-layers', {
    code: '11111111', producerId: 'abcdef01', spatialLayer: 0, temporalLayer: 1, peerId: 'u999',
  });
  assert.equal(reply.error, undefined, 'accepted');
  // The peer is the caller's own, taken from the socket: a client cannot name
  // somebody else's peer in the payload.
  assert.deepEqual(relay.calls[0], {
    code: '11111111', peerId: 'u1', producerId: 'abcdef01', opts: { spatialLayer: 0, temporalLayer: 1 },
  });
  assert.equal(reply.spatialLayer, 0, 'what the relay settled on comes back to the caller');
});

test('#1 the event is registered, so it is covered like the rest', () => {
  assert.ok(registerVoiceRelay.RELAY_EVENTS.includes('relay:set-preferred-layers'));
});

// ── the client's own choice, loaded as-is from the shipped file ──

const CLIENT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'voice-relay.js'), 'utf8');

/** HavenRelaySession's layer choice, driven with a fake receiving transport. */
function loadPicker(connectionState = 'connected') {
  const context = vm.createContext({
    module: { exports: {} },
    window: {},
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date,
  });
  vm.runInContext(CLIENT_SOURCE, context, { filename: 'voice-relay.js' });
  const Session = context.window.HavenRelaySession;
  const session = Object.create(Session.prototype);
  const asked = [];
  session.consumers = new Map();
  session.recvTransport = { closed: false, connectionState };
  session.setPreferredLayers = async (producerId, spatialLayer, temporalLayer = null) => {
    asked.push({ producerId, spatialLayer, temporalLayer });
  };
  return { session, asked, setState: (s) => { session.recvTransport.connectionState = s; } };
}

test('#1 the client takes the small layer on a weak link, and the full one back', () => {
  const { session, asked, setState } = loadPicker('connected');
  const screen = { consumer: {}, source: 'screen', layer: null };
  session.consumers.set('p-screen', screen);
  session._recheckLayers();
  assert.deepEqual(asked, [], 'a healthy link is left alone, with no needless message to the relay');

  setState('disconnected');
  session._recheckLayers();
  assert.deepEqual(asked, [{ producerId: 'p-screen', spatialLayer: 0, temporalLayer: null }]);
  assert.equal(screen.layer, 0, 'and the choice is remembered, so it is not re-sent on every change');

  setState('connected');
  session._recheckLayers();
  assert.deepEqual(asked[1], { producerId: 'p-screen', spatialLayer: null, temporalLayer: null },
    'the full layer is taken back as soon as the link returns');
  assert.equal(screen.layer, null);
});

test('#1 the client never changes the layer of a voice or a screen\'s audio', () => {
  const { session, asked } = loadPicker('disconnected');
  session.consumers.set('p-mic', { consumer: {}, source: 'mic' });
  session.consumers.set('p-audio', { consumer: {}, source: 'screen-audio' });
  session.consumers.set('p-cam', { consumer: {}, source: 'webcam' });
  session._recheckLayers();
  assert.deepEqual(asked, [], 'only screen video has layers, and only that is judged');
});
