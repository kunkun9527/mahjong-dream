// Host projection for the hash-pinned derived Unity client. Never patches WebAssembly globals.
(function () {
  'use strict';
  var sourceHash = '730effb3ff74fb93975c29e48249f29c43d32b9c65d55805a03f765de260cab9';
  var sample = null, receivedAt = 0, cached = null, applied = 0, ready = false;
  var playable = null;
  var socket = null, recovery = null, reloadPending = 0, reloadScope = 0, reloadMachine = 0, idle = false, revision = 0;

  function connect(ws) {
    socket = ws; recovery = null; playable = null; reloadScope = 0; reloadMachine = 0; reloadPending = 0; idle = false; revision++;
  }
  function disconnect(ws) {
    if (socket !== ws) return;
    socket = null; recovery = null; playable = null; idle = false; revision++; freeze();
  }
  function canStart(state) {
    return !state.sent && playable === state && socket && socket === state.socket && socket.readyState === 1 && !recovery && idle && current()?.id === state.id;
  }
  // Background tabs do not get animation frames: keep their connected game progressing.
  // Only foreground decisions require the native HUD to be visible before charging time.
  function startInBackground() {
    if (!document.hidden || !socket || socket.readyState !== 1 || recovery) return;
    var clock = current();
    if (!clock || clock.running) return;
    if (!playable || playable.id !== clock.id || playable.socket !== socket) {
      playable = { id: clock.id, socket: socket, sent: false, scheduled: false };
    }
    if (playable.sent) return;
    playable.sent = true;
    socket.send(JSON.stringify({ mjClockReady: clock.id }));
  }
  document.addEventListener('visibilitychange', startInBackground);
  function startWhenPainted() {
    var state = playable;
    if (!state || state.scheduled || state.sent || !canStart(state)) return;
    state.scheduled = true;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        state.scheduled = false;
        if (!canStart(state)) return;
        state.sent = true;
        socket.send(JSON.stringify({ mjClockReady: state.id }));
      });
    });
  }
  function canConfirm(state) {
    return recovery === state && socket && socket.readyState === 1 && !document.hidden &&
      state.end && state.consumed.has(state.counter) && idle && reloadPending === 0 &&
      (!current() || playable?.id === current().id) &&
      (!state.reload || state.reloadDone);
  }
  function confirmWhenPainted() {
    var state = recovery;
    if (!state || state.scheduled || state.sent || !canConfirm(state)) return;
    state.scheduled = true;
    var version = revision;
    // Wait for a paint opportunity after Unity's real packet, reload-task and render-queue completion.
    // No elapsed-time guess is allowed to open the server's gate.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        state.scheduled = false;
        if (revision !== version || !canConfirm(state)) { confirmWhenPainted(); return; }
        state.sent = true;
        socket.send(JSON.stringify({ mjSyncAck: { id: state.id, counter: state.counter } }));
        console.log('[clock-bridge] recovery consumed id=' + state.id + ' counter=' + state.counter);
      });
    });
  }
  function synchronize(message, ws) {
    if (ws !== socket || !message || typeof message.id !== 'string') return;
    if (message.phase === 'start') {
      playable = null;
      recovery = { id: message.id, reload: !!message.reload, reloadDone: false, consumed: new Set(), end: false };
      idle = false; revision++; freeze();
      console.log('[clock-bridge] recovery started id=' + message.id);
    } else if (recovery && message.id === recovery.id && message.phase === 'end') {
      if (!Number.isSafeInteger(message.counter) || message.counter < 1 || message.counter > 0xffffffff) return;
      recovery.end = true; recovery.counter = message.counter;
      confirmWhenPainted();
    } else if (recovery && message.id === recovery.id && message.phase === 'complete') {
      recovery = null;
      startWhenPainted();
      if (window.__mjmock && window.__mjmock.reconnect) window.__mjmock.reconnect.hide();
    }
  }
  function nativeSync(kind, value) {
    if (kind === 1) {
      if (recovery) recovery.consumed.add(value >>> 0);
      idle = false; revision++;
    } else if (kind === 2) {
      if (idle !== !!value) { idle = !!value; revision++; }
    } else if (kind === 3 && reloadScope > 0) {
      // The actual Riichi process enters Reload (9) during Ntf_ReLoad dispatch.
      reloadMachine = value; reloadPending = 1;
      if (recovery) recovery.reloadDone = false;
      revision++;
    } else if (kind === 4 && reloadPending && value === reloadMachine) {
      // Only that machine returning successfully to its gameplay state (4) completes restoration.
      reloadPending = 0;
      if (recovery) recovery.reloadDone = true;
      revision++;
    } else if (kind === 5) {
      reloadScope++;
    } else if (kind === 6) {
      reloadScope = Math.max(0, reloadScope - 1);
    } else if (kind === 7) {
      // InitCountDown is emitted by the native playable-hand UI, after dealing/drawing presentation.
      var state = current();
      if (state && (!playable || playable.id !== state.id || playable.socket !== socket)) {
        playable = { id: state.id, socket: socket, sent: false, scheduled: false };
      }
    }
    confirmWhenPainted();
    startWhenPainted();
  }

  function current() {
    if (window.__mjHostMode !== 'node') {
      return window.__mjHost && window.__mjHost.humanClock ? window.__mjHost.humanClock() : null;
    }
    if (!sample) return null;
    var elapsed = sample.running ? Math.max(0, performance.now() - receivedAt) : 0;
    var baseMs = Math.max(0, sample.baseMs - elapsed);
    var totalMs = Math.max(0, sample.baseMs + sample.extraMs - elapsed);
    return { id: sample.id, baseMs: baseMs, extraMs: totalMs - baseMs, running: sample.running };
  }
  function accept(state) {
    if (state !== null && (!state || !Number.isSafeInteger(state.id) || state.id < 1 ||
        !Number.isFinite(state.baseMs) || state.baseMs < 0 || state.baseMs > 3600000 ||
        !Number.isFinite(state.extraMs) || state.extraMs < 0 || state.extraMs > 3600000 ||
        typeof state.running !== 'boolean')) throw new Error('Invalid host clock projection');
    sample = state === null ? null : { id: state.id, baseMs: state.baseMs, extraMs: state.extraMs, running: state.running };
    receivedAt = performance.now();
    startInBackground();
  }
  function freeze() {
    if (window.__mjHostMode !== 'node' || !sample) return;
    var state = current();
    state.running = false;
    accept(state);
  }
  function clock(field) {
    if (field === 0) {
      cached = current();
      if (!cached) return 0;
      applied++;
      return 1;
    }
    // Round base and bank separately so the native "+N" (total - base) stays fixed during the base phase.
    var base = Math.ceil(cached.baseMs / 1000);
    return field === 1 ? base : base + Math.ceil(cached.extraMs / 1000);
  }
  async function configure(config) {
    var response = await fetch('Build_intl/mj-h5.clock.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Clock client manifest missing; restore the complete game directory');
    var manifest = await response.json();
    if (manifest.v !== 3 || manifest.sourceHash !== sourceHash || !/^[a-f0-9]{64}$/.test(manifest.wasmHash) ||
        manifest.codeFile !== 'mj-h5.clock-' + manifest.wasmHash.slice(0, 16) + '.wasm.unityweb') {
      throw new Error('Unsupported Unity clock build; re-audit and regenerate the derived client');
    }
    config.codeUrl = 'Build_intl/' + manifest.codeFile;
    // Verified loader copies config into Module and sets Module.wasmBinary before invoking this hook.
    config.instantiateWasm = function (imports, receiveInstance) {
      var module = this;
      Promise.resolve().then(async function () {
        var bytes = module.wasmBinary;
        var digest = await crypto.subtle.digest('SHA-256', bytes);
        var actual = Array.from(new Uint8Array(digest), function (value) { return value.toString(16).padStart(2, '0'); }).join('');
        if (actual !== manifest.wasmHash) throw new Error('Unity clock client hash mismatch; restore the verified derived file');
        imports.mj = { clock: clock, sync: nativeSync };
        var result = await WebAssembly.instantiate(bytes, imports);
        receiveInstance(result.instance, result.module);
        ready = true;
        console.log('[clock-bridge] ready host=' + window.__mjHostMode + ' build=' + actual.slice(0, 16));
      }).catch(function (error) {
        console.error('[clock-bridge] initialization failed', error);
        // Loader abortHandler rejects createUnityInstance; never silently fall back to the incompatible original clock.
        module.abortHandler('[clock-bridge] ' + error.message);
      });
      return {};
    };
  }
  window.__mjClock = {
    configure: configure, accept: accept, freeze: freeze, current: current,
    connect: connect, disconnect: disconnect, synchronize: synchronize,
    status: function () { return { ready: ready, applied: applied, windowId: current()?.id ?? null,
      recovery: recovery ? { id: recovery.id, counter: recovery.counter, end: recovery.end,
        consumed: recovery.consumed.has(recovery.counter), reloadDone: recovery.reloadDone,
        sent: !!recovery.sent, idle: idle, reloadPending: reloadPending } : null }; },
  };
})();
