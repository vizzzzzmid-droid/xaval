'use strict';
/**
 * Socket messages for relayed calls (see src/voiceRelay).
 *
 * A relayed call still joins through voice-join like any other, so every
 * check there (membership, role gate, voice permission, user limit) has
 * already passed. These messages only move media: each one first confirms
 * the socket is the one in the call, and that the call really is relayed.
 *
 *   relay:join       -> router capabilities + a sending and a receiving connection
 *   relay:connect    -> finish connecting one of them
 *   relay:produce    -> start sending a track (mic, screen, screen-audio, webcam)
 *   relay:producers  -> what everyone else is sending right now
 *   relay:consume    -> start receiving one of those
 *   relay:resume     -> unpause a received track once it is wired up
 *   relay:set-paused -> server-side mute of one of your own sources
 *   relay:close-producer -> stop sending a track
 *
 * The server announces relay:new-producer and relay:producer-closed to the
 * rest of the call, and relay:lost when the relay itself went away.
 */

const SOURCES = new Set(['mic', 'screen', 'screen-audio', 'webcam']);
// A person can only mute their own microphone this way. Screen audio is
// paused for the *viewers* (by whether they have the tile open), not by the
// sharer, so allowing it here would let one member silence everybody's audio.
const MUTABLE = new Set(['mic']);
const ID = /^[A-Za-z0-9-]{1,64}$/;

module.exports = function registerVoiceRelay(socket, ctx) {
  const { io, state, db, floodCheck } = ctx;
  const { voiceUsers, activeScreenSharers, activeWebcamUsers, voiceRelay } = state;
  if (!voiceRelay) return;

  // The channel's voice bitrate setting, in bits per second, for the server to
  // cap each mic stream at. Read per call rather than cached: the admin can
  // change it while a call is running, and the next track started picks it up.
  function micBitrate(code) {
    try {
      const kbps = db.prepare('SELECT voice_bitrate FROM channels WHERE code = ?').get(code)?.voice_bitrate || 0;
      return kbps > 0 ? kbps * 1000 : 0;
    } catch { return 0; }
  }

  const peerId = () => `u${socket.user.id}`;

  // The socket is the one in this relayed call, or null.
  function inRelayedCall(code) {
    if (typeof code !== 'string' || !/^[a-f0-9]{8}$/i.test(code)) return false;
    const entry = voiceUsers.get(code)?.get(socket.user.id);
    return !!entry && entry.socketId === socket.id && voiceRelay.currentKind(code) === 'relay';
  }

  // Every handler answers through the ack: { ok: true, ... } or { error }.
  function handle(event, fn) {
    socket.on(event, async (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!data || typeof data !== 'object' || !inRelayedCall(data.code)) {
          return reply({ error: 'Not in a relayed call' });
        }
        reply({ ok: true, ...(await fn(data)) });
      } catch (err) {
        reply({ error: err.message || 'Relay error' });
      }
    });
  }

  handle('relay:join', async ({ code }) => {
    // Joining again (a reconnect) replaces the old session; tell the call
    // its tracks stopped so nobody keeps a dead one.
    if (voiceRelay.inCall(code, peerId())) {
      for (const producerId of voiceRelay.leave(code, peerId())) {
        socket.to(`voice:${code}`).emit('relay:producer-closed', { channelCode: code, producerId, userId: socket.user.id });
      }
    }
    return voiceRelay.join(code, peerId(), socket.user.id);
  });

  handle('relay:connect', async ({ code, transportId, dtlsParameters }) => {
    if (!ID.test(String(transportId)) || !dtlsParameters || typeof dtlsParameters !== 'object') throw new Error('Bad request');
    await voiceRelay.connect(code, peerId(), transportId, dtlsParameters);
    return {};
  });

  handle('relay:produce', async ({ code, transportId, kind, rtpParameters, source }) => {
    if (!ID.test(String(transportId)) || !SOURCES.has(source) || (kind !== 'audio' && kind !== 'video')) throw new Error('Bad request');
    if (!rtpParameters || typeof rtpParameters !== 'object') throw new Error('Bad request');
    // Screen and webcam go through the same announcements as a direct call,
    // which is where streams_enabled and the rest are checked.
    if ((source === 'screen' || source === 'screen-audio') && !activeScreenSharers.get(code)?.has(socket.user.id)) {
      throw new Error('Start the screen share first');
    }
    if (source === 'webcam' && !activeWebcamUsers.get(code)?.has(socket.user.id)) {
      throw new Error('Start the camera first');
    }
    if (source === 'mic' && kind !== 'audio') throw new Error('Bad request');
    const producerId = await voiceRelay.produce(code, peerId(), transportId, kind, rtpParameters, source);
    socket.to(`voice:${code}`).emit('relay:new-producer', {
      channelCode: code, producerId, userId: socket.user.id, source, kind,
    });
    return { producerId };
  });

  handle('relay:producers', async ({ code }) => {
    // A session the relay no longer has (the server restarted) must hear so,
    // or the client keeps a dead connection that "has nothing to receive".
    if (!voiceRelay.inCall(code, peerId())) throw new Error('Not in this call');
    return { producers: voiceRelay.producers(code, peerId()) };
  });

  handle('relay:consume', async ({ code, producerId, rtpCapabilities }) => {
    if (!ID.test(String(producerId)) || !rtpCapabilities || typeof rtpCapabilities !== 'object') throw new Error('Bad request');
    // Consume is the one relay call a client can repeat freely with different
    // producer ids, and each one that lands costs a real consumer in the
    // router — enough of them fill the call's resources on their own, and they
    // are what a runaway or hostile client loops on. Producers are few and
    // bounded, so consuming past this budget is never legitimate.
    if (floodCheck('relayConsume', code)) {
      throw new Error('Slow down — too many tracks requested at once');
    }
    const consumer = await voiceRelay.consume(code, peerId(), producerId, rtpCapabilities, { micBitrate: micBitrate(code) });
    if (!consumer) throw new Error('This track cannot be played here');
    return { consumer };
  });

  handle('relay:set-paused', async ({ code, source, paused }) => {
    // Only the microphone. Screen audio is already gated per viewer, so the
    // sharer has no business pausing it for the whole call, and nothing else
    // is a thing a person mutes about themselves.
    if (source !== 'mic' || typeof paused !== 'boolean') throw new Error('Bad request');
    // Server-side mute: the RTP itself stops, so the rest of the call stops
    // receiving this track rather than receiving silence. Only the person
    // sending it can mute it — the server never mutes somebody for them.
    if (await voiceRelay.setPeerSourcePaused(code, peerId(), source, paused)) {
      // Tell the call so viewers can show the muted state and drop the audio
      // element; the consumers themselves are already silent at the source.
      socket.to(`voice:${code}`).emit('relay:producer-paused', {
        channelCode: code, userId: socket.user.id, source, paused,
      });
    }
    return {};
  });

  handle('relay:resume', async ({ code, consumerId }) => {
    if (!ID.test(String(consumerId))) throw new Error('Bad request');
    await voiceRelay.resumeConsumer(code, peerId(), consumerId);
    return {};
  });

  handle('relay:close-producer', async ({ code, producerId, source }) => {
    if (!ID.test(String(producerId))) throw new Error('Bad request');
    if (voiceRelay.closeProducer(code, peerId(), producerId)) {
      socket.to(`voice:${code}`).emit('relay:producer-closed', {
        channelCode: code, producerId, userId: socket.user.id, source: SOURCES.has(source) ? source : null,
      });
    }
    return {};
  });
};

module.exports.RELAY_EVENTS = [
  'relay:join', 'relay:connect', 'relay:produce', 'relay:producers',
  'relay:consume', 'relay:resume', 'relay:set-paused', 'relay:close-producer',
];
