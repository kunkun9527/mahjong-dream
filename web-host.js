/* Page-side host. Static hosting: load the backend into this page and keep the profile in localStorage.
 * Node service: the backend runs in local/server.mjs; save-editor requests go to its /api/profile.
 * Both expose window.__mjHost = { mode, ready, request({ action, ... }) } for game.html and modifier.js. */
(function () {
  'use strict';

  var BACKEND = ['mock/proto.js', 'mock/data.js', 'mock/userdata.js', 'mock/riichi.js', 'mock/server.js'];
  // One github.io origin is shared by all of a user's project pages, so the key carries the project name.
  var STORAGE_KEY = 'mahjong-dream/profile';
  var LEGACY_KEY = 'mahjong-dream-snapshot/profile'; // before the project was renamed
  var mode = window.__mjHostMode === 'node' ? 'node' : 'browser';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(script);
    });
  }

  // Keep an unreadable save next to the new one instead of overwriting it.
  function backupCorrupt(raw) {
    localStorage.setItem(STORAGE_KEY + '.corrupt-' + Date.now(), raw);
    console.warn('[web-host] 存档损坏，已备份并创建新档案');
  }

  function readSaved() {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw && (raw = localStorage.getItem(LEGACY_KEY))) {
      localStorage.setItem(STORAGE_KEY, raw);
      localStorage.removeItem(LEGACY_KEY);
    }
    if (!raw) return null;
    try { return JSON.parse(raw); }
    catch (e) {
      backupCorrupt(raw);
      return null;
    }
  }

  function bootBrowser() {
    return BACKEND.reduce(function (chain, src) {
      return chain.then(function () { return loadScript(src); });
    }, Promise.resolve()).then(function () {
      var mj = window.__mj;
      mj.server.quiet(new URLSearchParams(location.search).get('mjDebug') !== '1');
      var host = null, timer = null;
      function write() {
        clearTimeout(timer);
        timer = null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(host.snapshot()));
      }
      // Match callbacks and every client message batch their writes; save-editor writes are immediate and may throw.
      function persist(urgent) {
        if (urgent) return write();
        clearTimeout(timer);
        timer = setTimeout(function () {
          try { write(); } catch (e) { console.error('[web-host] 存档失败', e); }
        }, 300);
      }
      function createHost(saved) {
        return mj.host.createProfileHost(mj.server, mj.host.normalizeProfile(saved), {
          persist: persist,
          log: function (line) { console.log(line); },
        });
      }
      var changed;
      host = createHost(readSaved());
      try { changed = host.load(); }
      catch (e) {
        // Valid JSON whose lobby data cannot be loaded.
        backupCorrupt(localStorage.getItem(STORAGE_KEY));
        host = createHost(null);
        changed = host.load();
      }
      if (changed) write();
      // The first connection of this page picks up a match left by a reload (within the away limit) where it stopped.
      var resumePending = true;
      mj.server.onSessionCreated = function (session) {
        host.attach(session);
        if (!resumePending) return;
        resumePending = false;
        host.recoverMatch({ session: session }).catch(function (e) { console.error('[web-host] 恢复对局失败', e); });
      };
      // Shop purchases, equipment and other lobby changes have no callback; save after each client message like the Node service.
      // Every message also proves the player is still here (the away clock of an unfinished match).
      var send = mj.server.FakeWebSocket.prototype.send;
      mj.server.FakeWebSocket.prototype.send = function () {
        host.touch();
        var result = send.apply(this, arguments);
        persist(false);
        return result;
      };
      window.addEventListener('pagehide', function () {
        if (timer) {
          try { write(); } catch (e) { console.error('[web-host] 存档失败', e); }
        }
      });
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
      // Away longer than the limit: the AI finishes the saved match before the game starts, so the lobby shows the result.
      return host.recoverMatch().then(function () { return host; }, function (e) {
        console.error('[web-host] 代打上一场比赛失败', e);
        return host;
      });
    });
  }

  var started = mode === 'node' ? Promise.resolve(null) : bootBrowser();
  started.catch(function (error) {
    console.error('[web-host] 启动失败', error);
    alert('Failed to start the offline game: ' + (error && error.message || error));
  });

  window.__mjHost = {
    mode: mode,
    ready: started.then(function () {}),
    request: function (body) {
      if (mode === 'browser') return started.then(function (host) { return host.handle(body); });
      return fetch('api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (response) {
        return response.json().then(function (data) {
          if (!data.ok) throw new Error(data.error || ('HTTP ' + response.status));
          return data.result;
        });
      });
    },
  };
})();
