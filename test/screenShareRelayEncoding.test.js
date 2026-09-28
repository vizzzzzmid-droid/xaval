/**
 * Screen share through the relay: what a capture is published as.
 *
 * A browser screen share goes up as two layers so a weak viewer can drop to the
 * small one (see test/voiceRelaySimulcast.test.js). The desktop app captures the
 * screen in its own preload override and hands the renderer one plain encoding
 * per track, which cannot be split into layers — so it must go up as a single
 * layer instead, or the relay would promise layers that never arrive.
 *
 *   node --test test/screenShareRelayEncoding.test.js
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const VOICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice.js'), 'utf8');
const RELAY_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public/js/voice-relay.js'), 'utf8');

function createStorage() {
  return { getItem() { return null; }, setItem() {}, removeItem() {} };
}

function loadVoiceManager(globals = {}) {
  const context = vm.createContext({
    module: { exports: {} },
    navigator: { userAgent: '', platform: '', maxTouchPoints: 0 },
    localStorage: createStorage(),
    console: { log() {}, warn() {}, error() {} },
    RTCSessionDescription: function RTCSessionDescription(d) { return d; },
    setTimeout,
    clearTimeout,
    Date,
    ...globals
  });
  vm.runInContext(`${VOICE_SOURCE}\nmodule.exports = VoiceManager;`, context, { filename: 'voice.js' });
  return context.module.exports;
}

/** A capture that holds exactly the tracks it is given, like a real one. */
function capturedStream({ video = true, audio = false } = {}) {
  const tracks = [];
  if (video) tracks.push({ kind: 'video', contentHint: '', stop() {} });
  if (audio) tracks.push({ kind: 'audio', stop() {} });
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio')
  };
}

/**
 * The manager, mid screen share, with a relay session that records what it was
 * asked to publish. `_screenFromElectron` is the flag the capture path records.
 */
function sharing({ electron, stream }) {
  const manager = Object.create(loadVoiceManager().prototype);
  const published = [];
  manager._relay = {
    publish: async (source, track, opts) => { published.push({ source, opts: opts || {} }); return { id: source }; },
    setPaused: async () => {},
  };
  manager.isScreenSharing = true;
  manager.screenStream = stream;
  manager._screenFromElectron = electron;
  manager._screenBitrates = { 1080: 2500000 };
  manager.screenResolution = 1080;
  return { manager, published };
}

const videoShare = () => capturedStream({ video: true });
const videoAndAudioShare = () => capturedStream({ video: true, audio: true });

test('a browser screen share is still published with layers', async () => {
  const { manager, published } = sharing({ electron: false, stream: videoShare() });
  await manager._publishRelayTracks();
  assert.equal(published.length, 1);
  assert.equal(published[0].source, 'screen');
  assert.equal(published[0].opts.simulcast, true, 'a browser encoder can be split into layers');
  assert.equal(published[0].opts.maxBitrate, 2500000, 'and the chosen quality is still what is asked for');
});

test('an Electron screen share is published as a single layer', async () => {
  const { manager, published } = sharing({ electron: true, stream: videoShare() });
  await manager._publishRelayTracks();
  assert.equal(published.length, 1);
  assert.equal(published[0].source, 'screen');
  assert.equal(published[0].opts.simulcast, false,
    'its capture is one encoding, so asking for two would promise layers that never arrive');
  assert.equal(published[0].opts.maxBitrate, 2500000, 'the bitrate still applies to that one layer');
});

test('a screen share with no audio never sends screen audio', async () => {
  for (const electron of [false, true]) {
    const { manager, published } = sharing({ electron, stream: videoShare() });
    await manager._publishRelayTracks();
    assert.deepEqual(published.map(p => p.source), ['screen'],
      `no screen-audio producer is invented (electron=${electron})`);
  }
});

test('a screen share that does carry audio sends both, either way', async () => {
  for (const electron of [false, true]) {
    const { manager, published } = sharing({ electron, stream: videoAndAudioShare() });
    await manager._publishRelayTracks();
    assert.deepEqual(published.map(p => p.source), ['screen', 'screen-audio'],
      `both tracks go up when the capture has both (electron=${electron})`);
    assert.equal(published[1].opts.simulcast, undefined,
      'screen audio is audio, so layers are not a question for it');
  }
});

test('nothing is published while not sharing, or by a native P2P share', async () => {
  const idle = sharing({ electron: false, stream: videoShare() });
  idle.manager.isScreenSharing = false;
  await idle.manager._publishRelayTracks();
  assert.deepEqual(idle.published, []);

  // The other native path (main-process capture, P2P only) is untouched by
  // this: it keeps its own transport and must not also appear in the relay.
  const p2p = sharing({ electron: true, stream: videoAndAudioShare() });
  p2p.manager._nativeScreenSharing = true;
  await p2p.manager._publishRelayTracks();
  assert.deepEqual(p2p.published, [], 'one share never rides both paths');
});


test('the relay really sends one encoding for a single-layer share', async () => {
  // The flag matters because of what the relay then does with it, so check the
  // encodings the producing side would actually build, not just the flag.
  const context = vm.createContext({
    module: { exports: {} },
    console: { log() {}, warn() {}, error() {} },
    window: {},
    setTimeout, clearTimeout, Date,
  });
  vm.runInContext(RELAY_SOURCE, context, { filename: 'voice-relay.js' });
  const Session = context.window.HavenRelaySession;
  const produce = async (opts) => {
    const session = Object.create(Session.prototype);
    const produced = [];
    session.producers = new Map();
    session.sendTransport = { produce: async (o) => { produced.push(o); return { id: `p${produced.length}` }; } };
    await session.publish('screen', { kind: 'video' }, opts);
    return produced[0];
  };

  const layered = await produce({ maxBitrate: 2500000, simulcast: true });
  assert.equal(layered.encodings.length, 2, 'a layered share really goes up as two');
  assert.equal(layered.codecOptions.videoGoogleStartBitrate, 1000);

  const single = await produce({ maxBitrate: 2500000, simulcast: false });
  assert.equal(single.encodings.length, 1, 'a single-layer share promises one layer, which is what it sends');
  assert.equal(single.encodings[0].scaleResolutionDownBy, undefined);
  assert.equal(single.codecOptions, undefined);
});
