'use strict';
/**
 * Phase 3 of ARCHITECTURE_SFU.md: worker management, resource limits, and what
 * a dead worker does to a live call.
 *
 * Needs mediasoup, which a normal install fetches on demand:
 *   npm install --no-save mediasoup@3.27.1
 *   node --test test/voiceRelayLimits.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { MediasoupRelay } = require('../src/voiceRelay/mediasoup');

const ADDRESS = '127.0.0.1';
const RTP = {
  codecs: [{ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: {} }],
  headerExtensions: [],
  encodings: [{ ssrc: 4100001 }],
  rtcp: { cname: 'test', reducedSize: true },
};
const VIDEO_RTP = {
  codecs: [{ mimeType: 'video/VP8', clockRate: 90000, payloadType: 96, parameters: {} }],
  headerExtensions: [],
  encodings: [{ ssrc: 4100002 }],
  rtcp: { cname: 'test', reducedSize: true },
};
let nextSsrc = 4100000;
const audioRtp = () => ({ ...RTP, encodings: [{ ssrc: nextSsrc++ }] });
const videoRtp = () => ({ ...VIDEO_RTP, encodings: [{ ssrc: nextSsrc++ }] });

// Each relay binds its own UDP port, and a test file runs its cases concurrently.
let nextPort = 40520;
function makeRelay(t, { settings, limits, onRoomLost } = {}) {
  const relay = new MediasoupRelay({
    settings: settings || (() => ({ port: nextPort++, workers: 1, address: ADDRESS })),
    onRoomLost: onRoomLost || (() => {}),
    limits,
  });
  t.after(async () => { await relay.stop(); });
  return relay;
}
const join = (relay, code, peerId) => relay.join(code, peerId, Number(peerId.replace('u', '')));
const HOST_WORKERS = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;


// ── 3 + 4. Workers: how many, and when there is no room for more ──

test('#3 one worker per channel is never what happens', async (t) => {
  const relay = makeRelay(t, { settings: () => ({ port: nextPort++, workers: 1, address: ADDRESS }) });
  await relay.start();
  assert.equal(relay.workers.length, 1, 'the pool is built once, from the setting');

  for (const code of ['11111111', '22222222', '33333333']) await join(relay, code, 'u1');
  assert.equal(relay.workers.length, 1, 'three calls did not make three workers');
  assert.equal(relay.rooms.size, 3, 'each call got its own router');
  assert.equal(new Set([...relay.rooms.values()].map(r => r.slot)).size, 1,
    'all of them landed on the one worker');
});

test('#3 a second worker is used only when the admin asked for one', async (t) => {
  const relay = makeRelay(t, { settings: () => ({ port: nextPort++, workers: 2, address: ADDRESS }) });
  await relay.start();
  assert.equal(relay.workers.length, 2, 'the setting decides the size of the pool');
  for (const code of ['11111111', '22222222', '33333333', '44444444']) await join(relay, code, 'u1');
  assert.equal(relay.workers.length, 2, 'and more calls do not grow it further');
  // Spread, not lumped on the first: each worker takes its share of the calls.
  const perWorker = relay.workers.map(w => w.rooms.size);
  assert.ok(perWorker.every(n => n <= 2), `calls are spread across the pool: ${perWorker}`);
});

test('#4 the pool cannot be pushed past the configured cap', async (t) => {
  // A cap of two and a request for sixty: what starts is the cap, and the relay
  // is still usable afterwards.
  const relay = makeRelay(t, {
    settings: () => ({ port: nextPort++, workers: 60, address: ADDRESS }),
    limits: { maxWorkers: 2 },
  });
  assert.equal(relay.limits().maxWorkers, 2);
  await relay.start();
  assert.equal(relay.workers.length, 2, 'asking for 60 starts only what is allowed');
  assert.equal(relay.state, 'running', 'and the relay still runs');
  await join(relay, '11111111', 'u1');
  assert.equal(relay.rooms.has('11111111'), true, 'a call still works on the capped pool');
});

test('#4 the default cap is sized for a real server', () => {
  const relay = new MediasoupRelay({ settings: () => ({ port: 1, workers: 1, address: ADDRESS }) });
  const limits = relay.limits();
  assert.ok(limits.maxWorkers >= 1, 'at least one worker is always allowed');
  assert.ok(limits.maxWorkers <= 64, 'and the cap itself is not unbounded');
  // A normal call of 5-20 people with a screen share must fit inside the caps.
  assert.ok(limits.maxPeersPerRoom >= 20, `the room cap is not tighter than a normal room (${limits.maxPeersPerRoom})`);
  assert.ok(limits.maxProducersPerPeer >= 4, 'one person can send mic, screen, its audio and camera');
  assert.ok(limits.maxConsumersPerPeer >= 60, `a 20-person room fits (${limits.maxConsumersPerPeer})`);
  assert.ok(limits.maxScreenProducersPerRoom >= 2, 'more than one screen share is normal');
});

test('#4 a call that cannot get a router is refused, not crashed', async (t) => {
  // A relay whose workers cannot be started at all: the port is taken, or
  // mediasoup is missing. This is the state a real outage leaves behind.
  const relay = makeRelay(t, {
    settings: () => { throw new Error('Voice relay worker could not be started'); },
  });
  assert.equal(await relay.start(), false, 'the pool does not come up');

  await assert.rejects(() => join(relay, '11111111', 'u1'), /not running|could not be started/i);
  assert.equal(relay.rooms.has('11111111'), false, 'no half-made room is left behind');
  assert.equal(relay.workers.length, 0, 'and no worker was left running');

  // The server is still up and simply has no relay, which is what lets the call
  // carry on directly instead of the whole request failing.
  assert.doesNotThrow(() => relay.status());
  assert.equal(relay.status().calls, 0);
  assert.equal(relay.status().state, 'error', 'the admin can see that the relay is unwell');

  // Every entry point refuses the same way, and none of them leaves state behind.
  await assert.rejects(() => relay.join('22222222', 'u1', 1));
  await assert.rejects(() => relay.produce('22222222', 'u1', 'abc', 'audio', audioRtp(), 'mic'));
  assert.equal(relay.rooms.size, 0, 'still nothing was created');

  // And once the cause is gone, a later call brings the pool back on its own
  // rather than needing a restart.
  relay.settings = () => ({ port: nextPort++, workers: 1, address: ADDRESS });
  assert.equal(await relay.start(), true, 'a later call brings the pool back');
  await join(relay, '11111111', 'u1');
  assert.equal(relay.rooms.has('11111111'), true, 'so calls work again after the outage');
});

// ── 5 + 6. Room, peer and track limits, and what a refusal leaves behind ──

test('#5 a room holds as many people as a real call needs', async (t) => {
  const relay = makeRelay(t);
  await relay.start();
  for (let i = 0; i < 20; i++) await join(relay, '11111111', `u${i}`);
  assert.equal(relay.rooms.get('11111111').peers.size, 20, 'a normal 20-person call is not refused');
});

test('#5 the room refuses one person too many, and leaves no trace', async (t) => {
  // A small cap for the test: what is being checked is that the check happens
  // before anything is created, not the size of the number.
  const relay = makeRelay(t, { limits: { maxPeersPerRoom: 3 } });
  await relay.start();
  for (const peerId of ['u1', 'u2', 'u3']) await join(relay, '11111111', peerId);
  const room = relay.rooms.get('11111111');

  await assert.rejects(() => join(relay, '11111111', 'u4'), /full/i);
  assert.equal(relay.rooms.get('11111111').peers.size, 3, 'the refused person is not in the room');
  assert.equal(relay.rooms.get('11111111').peers.has('u4'), false, 'and left no peer state');
  assert.equal(relay.rooms.get('11111111').router, room.router, 'the call and its router are untouched');
  // Which means the call still works for the people who are in it.
  const transports = [...relay.rooms.get('11111111').peers.get('u1').transports.keys()];
  const mic = await relay.produce('11111111', 'u1', transports[0], 'audio', audioRtp(), 'mic');
  assert.ok(mic, 'a refused join does not break the call for the others');
});

test('#5 the track cap refuses one too many and leaves the peer as it was', async (t) => {
  const relay = makeRelay(t, { limits: { maxProducersPerPeer: 3 } });
  await relay.start();
  await join(relay, '11111111', 'u1');
  await join(relay, '11111111', 'u2');
  const peer = relay.rooms.get('11111111').peers.get('u1');
  const send = [...peer.transports.values()].find(t => t.appData.direction === 'send');
  const u2send = [...relay.rooms.get('11111111').peers.get('u2').transports.values()].find(t => t.appData.direction === 'send');

  for (const source of ['mic', 'screen', 'screen-audio']) {
    await relay.produce('11111111', 'u1', send.id, 'audio', audioRtp(), source);
  }
  assert.equal(peer.producers.size, 3);

  await assert.rejects(() => relay.produce('11111111', 'u1', send.id, 'video', videoRtp(), 'webcam'), /too many tracks/i);
  assert.equal(peer.producers.size, 3, 'the refused track was not created');
  assert.equal([...peer.producers.values()].some(p => p.appData.source === 'webcam'), false,
    'and the earlier ones are all still there');
  // Switching a device replaces a track, so it is never the "one too many".
  const replaced = await relay.produce('11111111', 'u1', send.id, 'audio', audioRtp(), 'mic');
  assert.ok(replaced, 'replacing an existing track still works at the cap');
  assert.equal(peer.producers.size, 3);
});

test('#5 the receive cap refuses one too many and creates no consumer', async (t) => {
  const relay = makeRelay(t, { limits: { maxConsumersPerPeer: 2 } });
  await relay.start();
  await join(relay, '11111111', 'u1');
  await join(relay, '11111111', 'u2');
  const u1 = relay.rooms.get('11111111').peers.get('u1');
  const u1send = [...u1.transports.values()].find(t => t.appData.direction === 'send');
  const u2 = relay.rooms.get('11111111').peers.get('u2');

  const mic = await relay.produce('11111111', 'u1', u1send.id, 'audio', audioRtp(), 'mic');
  const screen = await relay.produce('11111111', 'u1', u1send.id, 'video', videoRtp(), 'screen');
  const cam = await relay.produce('11111111', 'u1', u1send.id, 'video', videoRtp(), 'webcam');
  await relay.consume('11111111', 'u2', mic, RTP);
  await relay.consume('11111111', 'u2', screen, VIDEO_RTP);
  assert.equal(u2.consumers.size, 2);

  await assert.rejects(() => relay.consume('11111111', 'u2', cam, VIDEO_RTP), /too many|limit/i);
  assert.equal(u2.consumers.size, 2, 'the refused consumer was not created');
  assert.equal([...u2.consumers.values()].some(c => c.producerId === cam), false,
    'and none of the two that exist was disturbed');
  // The sharer is unaffected: refusing a viewer never touches the producer.
  assert.equal([...u1.producers.values()].filter(p => !p.closed).length, 3);
});

test('#5 the screen-share cap counts people, not tracks', async (t) => {
  const relay = makeRelay(t, { limits: { maxScreenProducersPerRoom: 2 } });
  await relay.start();
  for (const peerId of ['u1', 'u2', 'u3']) await join(relay, '11111111', peerId);
  const sendOf = (peerId) => {
    const peer = relay.rooms.get('11111111').peers.get(peerId);
    return [...peer.transports.values()].find(t => t.appData.direction === 'send');
  };

  // A share is a person, and a screen is a video plus its audio: two sharers
  // fill the room even though that is four tracks.
  await relay.produce('11111111', 'u1', sendOf('u1').id, 'video', videoRtp(), 'screen');
  await relay.produce('11111111', 'u1', sendOf('u1').id, 'audio', audioRtp(), 'screen-audio');
  await relay.produce('11111111', 'u2', sendOf('u2').id, 'video', videoRtp(), 'screen');
  assert.equal(relay.rooms.get('11111111').peers.get('u1').producers.size, 2);

  await assert.rejects(
    () => relay.produce('11111111', 'u3', sendOf('u3').id, 'video', videoRtp(), 'screen'),
    /screen shares/i
  );
  // The audio of somebody already sharing is their own share, not a new one.
  const u2audio = await relay.produce('11111111', 'u2', sendOf('u2').id, 'audio', audioRtp(), 'screen-audio');
  assert.ok(u2audio, 'so a second sharer can still send their screen audio');
  assert.equal(relay.rooms.get('11111111').peers.get('u3').producers.size, 0, 'the refused share left nothing');
});


/**
 * A real crash: the worker's own process is killed, and the test waits for the
 * relay to have noticed. Faking the 'died' event instead would leave a live
 * worker behind that keeps the test runner from ever exiting.
 */
function crashWorker(t, slot) {
  const died = new Promise((resolve) => slot.worker.once('died', resolve));
  process.kill(slot.worker.pid, 'SIGKILL');
  return died;
}

// ── 7. A worker that dies ──

test('#7 a dead worker takes its calls down and tells each one to go direct', async (t) => {
  // mediasoup reports a crashed worker by emitting 'died'. Emitting it here is
  // the same path a real crash takes, without a process actually dying under
  // the test runner.
  const lost = [];
  const relay = makeRelay(t, {
    settings: () => ({ port: nextPort++, workers: 2, address: ADDRESS }),
    onRoomLost: (code) => lost.push(code),
  });
  await relay.start();
  await join(relay, '11111111', 'u1');
  await join(relay, '22222222', 'u1');
  const slot = relay.workers.find(w => w.rooms.has('11111111'));
  const router = relay.rooms.get('11111111').router;
  assert.ok(slot, 'the call is on a worker of its own');

  await crashWorker(t, slot);

  assert.ok(lost.includes('11111111'), 'that call is told its relay went away, so it can go direct');
  assert.equal(relay.rooms.has('11111111'), false, 'the dead call is not left hanging in the relay');
  assert.equal(router.closed, true, 'and its router is closed');
  assert.equal(relay.workers.includes(slot), false, 'the dead worker is out of the pool');
  assert.equal(relay.rooms.has('22222222'), true, 'a call on another worker is untouched');
  assert.ok(!lost.includes('22222222'), 'and was not told anything');
  // The relay is still usable on what is left, rather than shutting itself down.
  assert.equal(relay.state, 'running');
  await join(relay, '33333333', 'u1');
  assert.equal(relay.rooms.has('33333333'), true, 'a new call works on the surviving worker');
});
test('#7 losing every worker leaves the relay unable, and the server up', async (t) => {
  const lost = [];
  const relay = makeRelay(t, {
    settings: () => ({ port: nextPort++, workers: 1, address: ADDRESS }),
    onRoomLost: (code) => lost.push(code),
  });
  await relay.start();
  await join(relay, '11111111', 'u1');
  const router = relay.rooms.get('11111111').router;
  const slot = relay.workers[0];
  await crashWorker(t, slot);

  assert.deepEqual(lost, ['11111111'], 'the call is told, so it can carry on directly');
  assert.equal(relay.workers.length, 0, 'no workers left');
  assert.equal(router.closed, true, 'and nothing of the call is left open');
  assert.equal(relay.state, 'error', 'the relay says so rather than pretending to be fine');
  assert.ok(relay.error, 'with a reason the admin can read');
  // The server is still running: the next call simply settles as direct, which
  // is the existing fallback, not a new code path.
  assert.doesNotThrow(() => relay.status());
  assert.equal(relay.status().state, 'error');
  assert.equal(relay.status().calls, 0, 'and holds no call state');
  assert.equal(relay.status().people, 0);
});

test('#7 a dead worker leaves no transports or producers of its own behind', async (t) => {
  const relay = makeRelay(t, { settings: () => ({ port: nextPort++, workers: 1, address: ADDRESS }) });
  await relay.start();
  await join(relay, '11111111', 'u1');
  const peer = relay.rooms.get('11111111').peers.get('u1');
  const transports = [...peer.transports.values()];
  const send = transports.find(x => x.appData.direction === 'send');
  await relay.produce('11111111', 'u1', send.id, 'audio', audioRtp(), 'mic');
  const producer = [...peer.producers.values()][0];

  const slot = relay.workers[0];
  await crashWorker(t, slot);

  assert.equal(producer.closed, true, 'the producer is closed, not left sending into nothing');
  for (const transport of transports) {
    assert.equal(transport.closed, true, 'and so are the transports');
  }
  assert.equal(relay.rooms.size, 0, 'no room state survives the crash');

test('#6 stopping the relay closes what the calls were holding', async () => {
  // stop() used to empty the room map without closing anything, so the
  // routers and transports stayed alive and the worker processes outlived the
  // relay. Everything must really be closed.
  const relay = new MediasoupRelay({ settings: () => ({ port: nextPort++, workers: 1, address: ADDRESS }) });
  await relay.start();
  await relay.join('11111111', 'u1', 1);
  const room = relay.rooms.get('11111111');
  const router = room.router;
  const peer = room.peers.get('u1');
  const transports = [...peer.transports.values()];
  const slot = relay.workers[0];

  await relay.stop();

  assert.equal(router.closed, true, 'the router is closed');
  for (const transport of transports) assert.equal(transport.closed, true, 'and so are the transports');
  assert.equal(relay.rooms.size, 0, 'no call is left behind');
  assert.equal(relay.workers.length, 0, 'and no worker is kept');
  assert.equal(slot.rooms.size, 0, 'the worker slot forgot its calls');
  assert.doesNotThrow(() => relay.stop(), 'stopping twice is safe');
});

});
