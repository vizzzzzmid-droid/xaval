'use strict';
/**
 * SFU behaviour of the built-in voice relay (Phase 2 of ARCHITECTURE_SFU.md).
 *
 * These four were not real before, and each one cost the server resources that
 * only the relay can see, so they are covered against the real relay rather
 * than a mock:
 *
 *   1. Mute was local only. `track.enabled = false` on the sender, RTP kept
 *      crossing the server, so a muted person still cost a full audio stream to
 *      every listener. Now the producer itself is paused, the pause survives a
 *      rejoin, and a mic published while muted starts paused rather than
 *      leaking a burst.
 *   2. `voice_bitrate` was honoured on direct calls and silently ignored on
 *      relayed ones, so a channel capped at 32 kbps still cost a full-rate
 *      stream per person. It is now applied as a hard cap on the consumer.
 *   3. Screen video was only sent to people with the tile open, but screen
 *      *audio* went to the whole call — a silent desktop at full rate to
 *      everyone. Both are now gated by the same thing.
 *   4. `relay:consume` could be looped without limit; every accepted call
 *      allocates a real mediasoup Consumer, so it is the one relay message
 *      where frequency is cost.
 *
 * Needs mediasoup, which a normal install fetches on demand:
 *   npm install --no-save mediasoup@3.27.1
 *   node --test test/voiceRelaySfu.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { MediasoupRelay } = require('../src/voiceRelay/mediasoup');
const registerVoiceRelay = require('../src/socketHandlers/voiceRelay');

const ADDRESS = '127.0.0.1';
const RTP = {
  codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: { useinbandfec: 1 } }],
  headerExtensions: [],
  encodings: [{ ssrc: 2000001 }],
  rtcp: { cname: 'test', reducedSize: true },
};
const VIDEO_RTP = {
  codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96, parameters: { 'x-google-start-bitrate': 1000 } }],
  headerExtensions: [],
  encodings: [{ ssrc: 2000002 }],
  rtcp: { cname: 'test', reducedSize: true },
};

// Each relay binds one UDP port, and a test file runs its cases concurrently,
// so every case gets a port of its own instead of fighting over one.
let nextPort = 40457;
function createRelay(t) {
  const relay = new MediasoupRelay({ settings: () => ({ port: nextPort++, workers: 1, address: ADDRESS }), onRoomLost() {} });
  t.after(async () => { await relay.stop(); });
  return relay;
}

async function joinPeer(relay, code, peerId) {
  return relay.join(code, peerId, Number(peerId.replace('u', '')));
}

// mediasoup maps an encoding back to a stream by ssrc, so every track produced
// into the same call needs its own — a repeat is rejected outright.
let nextSsrc = 2000001;
const audioRtp = () => ({ ...RTP, encodings: [{ ssrc: nextSsrc++ }] });
const videoRtp = () => ({ ...VIDEO_RTP, encodings: [{ ssrc: nextSsrc++ }] });
const producerOf = (relay, code, peerId, source) => {
  const peer = relay.rooms.get(code).peers.get(peerId);
  return [...peer.producers.values()].find(p => p.appData.source === source);
};
const consumerOf = (relay, code, peerId, source) => {
  const peer = relay.rooms.get(code).peers.get(peerId);
  return [...peer.consumers.values()].find(c => c.appData.source === source);
};


// ── 1. Server-side mute ─────────────────────────────────────

test('#1 muting pauses the producer, so the RTP stops crossing the server', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  const mic = producerOf(relay, '11111111', 'u1', 'mic');
  assert.equal(mic.paused, false);

  assert.equal(await relay.setPeerSourcePaused('11111111', 'u1', 'mic', true), 1, 'the producer was paused');
  assert.equal(mic.paused, true, 'mediasoup is sending no RTP for it at all');

  // The producer is kept, so unmuting is instant rather than a fresh publish.
  assert.equal(relay.inCall('11111111', 'u1'), true);
  assert.equal(await relay.setPeerSourcePaused('11111111', 'u1', 'mic', false), 1, 'and resumed');
  assert.equal(mic.paused, false, 'the same producer carries audio again');
  assert.equal(mic.closed, false, 'without having been rebuilt');
});

test('#1 a mute already in force is not counted or re-applied', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');

  assert.equal(await relay.setPeerSourcePaused('11111111', 'u1', 'mic', true), 1);
  assert.equal(await relay.setPeerSourcePaused('11111111', 'u1', 'mic', true), 0,
    'a second mute changes nothing and does not re-announce');
  assert.equal(await relay.setPeerSourcePaused('11111111', 'u1', 'mic', false), 1);
  assert.equal(await relay.setPeerSourcePaused('11111111', 'u1', 'mic', false), 0);
  assert.deepEqual(relay.pausedSources('11111111', 'u1'), [], 'nothing is left marked muted');
});

test('#1 a mic published while muted starts paused, and the mute outlives a device switch', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');

  // The mute arrives before the track, as it does when somebody joins already
  // muted, or mutes during the join handshake.
  await relay.setPeerSourcePaused('11111111', 'u1', 'mic', true);
  const first = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  assert.equal(producerOf(relay, '11111111', 'u1', 'mic').paused, true,
    'the track starts muted, so no burst of audio leaks to the call');

  // Picking a different mic rebuilds the producer; the mute must follow it.
  const second = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  assert.notEqual(second, first, 'the new device really is a new producer');
  assert.equal(producerOf(relay, '11111111', 'u1', 'mic').paused, true,
    'and it is muted too, not live by accident');
  assert.deepEqual(relay.pausedSources('11111111', 'u1'), ['mic'], 'so a rejoin can restore it');
});

test('#1 mute is per person, and forgets the dead', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');

  await relay.setPeerSourcePaused('11111111', 'u1', 'mic', true);
  assert.deepEqual(relay.pausedSources('11111111', 'u1'), ['mic'], 'Alice is muted');
  assert.deepEqual(relay.pausedSources('11111111', 'u2'), [], 'Bob is not — mute is not contagious');
  assert.equal(producerOf(relay, '11111111', 'u1', 'mic').paused, true);

  relay.leave('11111111', 'u1');
  assert.deepEqual(relay.pausedSources('11111111', 'u1'), [], 'a gone peer keeps no mute flag');
  // Somebody who is not even in the call changes nothing and throws nothing.
  assert.equal(await relay.setPeerSourcePaused('11111111', 'u404', 'mic', true), 0);
  assert.doesNotThrow(() => relay.pausedSources('deadbeef', 'u1'));
});
// ── 2. voice_bitrate ─────────────────────────────────────────

test('#2 a mic is capped at the channel setting, for every receiver', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  await joinPeer(relay, '11111111', 'u3');
  const producer = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');

  const b = await relay.consume('11111111', 'u2', producer, audioRtp(), { micBitrate: 32000 });
  const c = await relay.consume('11111111', 'u3', producer, audioRtp(), { micBitrate: 32000 });
  assert.ok(b && c, 'both are receiving the voice');
  // The cap is on the consumer, so the server cannot send more to anybody,
  // whatever the sender negotiated for itself.
  assert.equal(consumerOf(relay, '11111111', 'u2', 'mic').appData.micBitrate, 32000);
  assert.equal(consumerOf(relay, '11111111', 'u3', 'mic').appData.micBitrate, 32000);
});

test('#2 an unset bitrate, or a source it does not describe, is left alone', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  const mic = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  const screen = await relay.produce('11111111', 'u1', alice.send.id, 'video', videoRtp(), 'screen');

  // The channel has no bitrate set: the relay must not invent one.
  await relay.consume('11111111', 'u2', mic, audioRtp(), { micBitrate: 0 });
  assert.equal(consumerOf(relay, '11111111', 'u2', 'mic').appData.micBitrate, null,
    'no cap invented when the admin set none');

  // The setting describes voices, so a screen share is not squeezed to it.
  await relay.consume('11111111', 'u2', screen, videoRtp(), { micBitrate: 32000 });
  assert.equal(consumerOf(relay, '11111111', 'u2', 'screen').appData.micBitrate, null,
    'the voice bitrate setting does not apply to a screen share');

  // A client that sends no options at all must still be served.
  const legacy = await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  assert.ok(legacy, 'an older client that knows nothing about bitrates still consumes');
});

// ── 3. Screen-audio viewer gating ────────────────────────────

test('#3 screen audio only flows to the people with the tile open', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  await joinPeer(relay, '11111111', 'u3');
  const audio = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'screen-audio');
  const video = await relay.produce('11111111', 'u1', alice.send.id, 'video', videoRtp(), 'screen');
  const mic = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  for (const peerId of ['u2', 'u3']) {
    await relay.consume('11111111', peerId, audio, RTP);
    await relay.consume('11111111', peerId, video, VIDEO_RTP);
    const voice = await relay.consume('11111111', peerId, mic, RTP);
    // A consumer arrives paused and the client resumes it once it is wired up,
    // which is what relay:resume is for; a voice is resumed right away.
    await relay.resumeConsumer('11111111', peerId, voice.id);
  }

  // Nobody has the tile open, so nothing screen-related is being sent.
  for (const peerId of ['u2', 'u3']) {
    assert.equal(consumerOf(relay, '11111111', peerId, 'screen-audio').paused, true,
      'a screen’s audio is not carried to a viewer who is not looking at it');
    assert.equal(consumerOf(relay, '11111111', peerId, 'screen').paused, true,
      'and neither is its video');
    assert.equal(consumerOf(relay, '11111111', peerId, 'mic').paused, false,
      'but a voice is not gated on a tile');
  }

  // Bob opens the share: his copy of the screen *and* its audio starts.
  await relay.setWatching('11111111', 'u2', 1, true);
  assert.equal(consumerOf(relay, '11111111', 'u2', 'screen-audio').paused, false,
    'opening the tile starts the screen’s audio too');
  assert.equal(consumerOf(relay, '11111111', 'u2', 'screen').paused, false);
  assert.equal(consumerOf(relay, '11111111', 'u3', 'screen-audio').paused, true,
    'and the other viewer is still not sent it');

  // Bob closes it again: both stop, which is the point of the gating.
  await relay.setWatching('11111111', 'u2', 1, false);
  assert.equal(consumerOf(relay, '11111111', 'u2', 'screen-audio').paused, true);
});

// ── 4. relay:consume rate limit, bitrate and set-paused ──────
// These go through the socket layer, because the limit, the setting and the
// permission check all live there and none of them are visible from the relay.

function relayHarness({ bitrate = 64, floodAfter = Infinity } = {}) {
  const handlers = new Map();
  const emitted = [];
  const socket = {
    id: 's1',
    user: { id: 1, username: 'alice' },
    on: (event, fn) => handlers.set(event, fn),
    emit() {},
    to() { return { emit: (e, p) => emitted.push({ e, p }) }; },
  };
  const voiceUsers = new Map([['11111111', new Map([[1, { id: 1, socketId: 's1' }]])]]);
  const calls = [];
  const state = {
    voiceUsers,
    activeScreenSharers: new Map(),
    activeWebcamUsers: new Map(),
    voiceRelay: {
      currentKind: () => 'relay',
      inCall: () => true,
      consume: async (code, peerId, producerId, rtp, opts) => {
        calls.push(opts);
        return { id: `c${calls.length}`, producerId };
      },
      setPeerSourcePaused: async () => 1,
    },
  };
  let used = 0;
  registerVoiceRelay(socket, {
    io: { to: () => ({ emit: () => {} }) },
    db: { prepare: () => ({ get: () => ({ voice_bitrate: bitrate }) }) },
    state,
    // The real floodCheck is a sliding window; here it reports flooded once the
    // given number of calls have been let through, which is the only property
    // the handler relies on.
    floodCheck: () => ++used >= floodAfter,
  });
  const call = (event, data) => new Promise((resolve) => handlers.get(event)(data, resolve));
  return { call, calls, emitted };
}

test('#4 relay:consume is rate limited, and says so instead of allocating', async () => {
  const { call, calls } = relayHarness({ floodAfter: 5 });
  for (let i = 0; i < 4; i++) {
    assert.equal((await call('relay:consume', { code: '11111111', producerId: `p${i}`, rtpCapabilities: {} })).error,
      undefined, `call ${i + 1} is inside the budget`);
  }
  assert.equal(calls.length, 4);

  // Past the budget the message is refused and nothing is allocated, which is
  // the resource being protected.
  const refused = await call('relay:consume', { code: '11111111', producerId: 'p9', rtpCapabilities: {} });
  assert.match(refused.error, /Slow down/);
  assert.equal(calls.length, 4, 'no consumer was created for the refused call');
});

test('#4 a bad payload is rejected before the rate limiter is charged', async () => {
  const { call, calls } = relayHarness({ floodAfter: 3 });
  assert.match((await call('relay:consume', { code: '11111111', producerId: '../etc', rtpCapabilities: {} })).error, /Bad request/);
  assert.match((await call('relay:consume', { code: '11111111', producerId: 'p1' })).error, /Bad request/);
  assert.equal(calls.length, 0);
});

test('#4 consume is not attempted from outside that relayed call', async () => {
  const { call, calls } = relayHarness();
  const reply = await call('relay:consume', { code: '22222222', producerId: 'p1', rtpCapabilities: {} });
  assert.match(reply.error, /Not in a relayed call/);
  assert.equal(calls.length, 0);
});

test('the channel voice bitrate reaches the relay in bits per second', async () => {
  const { call, calls } = relayHarness({ bitrate: 64 });
  await call('relay:consume', { code: '11111111', producerId: 'p1', rtpCapabilities: {} });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].micBitrate, 64000, 'the setting is kbps, and the relay wants bps');

  // A channel that never had the setting changed must not be capped to zero,
  // which would take everybody's voice away.
  const unset = relayHarness({ bitrate: 0 });
  await unset.call('relay:consume', { code: '11111111', producerId: 'p1', rtpCapabilities: {} });
  assert.equal(unset.calls[0].micBitrate, 0, 'unset means "no cap", not "mute everything"');
});

test('relay:set-paused mutes your own microphone, and tells the call', async () => {
  const { call, emitted } = relayHarness();
  assert.equal((await call('relay:set-paused', { code: '11111111', source: 'mic', paused: true })).error, undefined);
  assert.equal(emitted.length, 1, 'the call is told, so viewers can show the mute');
  assert.equal(emitted[0].e, 'relay:producer-paused');
  assert.deepEqual(
    { userId: emitted[0].p.userId, source: emitted[0].p.source, paused: emitted[0].p.paused },
    { userId: 1, source: 'mic', paused: true }
  );

  // Screen audio is gated for viewers by whether they have the tile open, not
  // by the sharer, so accepting it here would silence everybody's screen audio.
  assert.match((await call('relay:set-paused', { code: '11111111', source: 'screen-audio', paused: true })).error, /Bad request/);
  assert.match((await call('relay:set-paused', { code: '11111111', source: 'nope', paused: true })).error, /Bad request/);
  assert.match((await call('relay:set-paused', { code: '11111111', source: 'mic', paused: 'yes' })).error, /Bad request/);
  assert.equal(emitted.length, 1, 'none of those announced anything');
});

test('relay:set-paused outside your own relayed call is refused', async () => {
  const { call, emitted } = relayHarness();
  const reply = await call('relay:set-paused', { code: '22222222', source: 'mic', paused: true });
  assert.match(reply.error, /Not in a relayed call/);
  assert.equal(emitted.length, 0);
});

test('set-paused is registered with the relay, so the client can rely on it', () => {
  // The flood-exempt list is built from these names, so an event that is not
  // exported here would be silently unprotected.
  assert.ok(registerVoiceRelay.RELAY_EVENTS.includes('relay:set-paused'));
});

test('#3 a voice is never gated on a tile being open', async (t) => {
  const relay = createRelay(t);
  await relay.start();
  const alice = await joinPeer(relay, '11111111', 'u1');
  await joinPeer(relay, '11111111', 'u2');
  const mic = await relay.produce('11111111', 'u1', alice.send.id, 'audio', audioRtp(), 'mic');
  const voice = await relay.consume('11111111', 'u2', mic, RTP);
  await relay.resumeConsumer('11111111', 'u2', voice.id);

  // Bob opens and closes somebody's screen. Neither is about Alice's voice.
  await relay.setWatching('11111111', 'u2', 1, true);
  await relay.setWatching('11111111', 'u2', 1, false);
  assert.equal(consumerOf(relay, '11111111', 'u2', 'mic').paused, false,
    'Alice stays audible throughout');
});

