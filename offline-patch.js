/* Offline single-player patch for Mahjong Dream: the game WebSocket connects to the local service (or to the in-page backend
   on static hosting, see web-host.js), and all external network requests are blocked. */
(function () {
  'use strict';

  // Directory of game.html; static hosting may serve the game under a sub-path such as /mahjong-dream/.
  var BASE = location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  var LOCAL_WS = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws' + location.search;
  function localUrl(value) {
    if (!value || /^(data:|blob:|about:)/i.test(String(value))) return true;
    try { return new URL(String(value), location.href).origin === location.origin; }
    catch (e) { return false; }
  }
  function localAssetUrl(value) {
    try {
      var parsed = new URL(String(value), location.href);
      if (parsed.pathname.indexOf('/StreamingAssets/') === 0) {
        return new URL(parsed.pathname.slice(1) + parsed.search, BASE).href;
      }
    } catch (e) { /* block below */ }
    return null;
  }
  function emptyResponse() {
    return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }

  var stats = { sent: 0, recv: 0, frames: [] };
  function recordFrame(frame) {
    stats.frames.push(frame);
    if (stats.frames.length > 200) stats.frames.shift();
  }
  // ---------------- Interface language ----------------
  // English is the first-run default; Unity's saved LanguageID takes precedence afterward.
  var requestedLanguage = 'en-US';
  if (requestedLanguage) {
    ['language', 'userLanguage'].forEach(function (key) {
      try { Object.defineProperty(navigator, key, { configurable: true, get: function () { return requestedLanguage; } }); }
      catch (e) { /* Ignore in read-only environments */ }
    });
    try { Object.defineProperty(navigator, 'languages', { configurable: true, get: function () { return [requestedLanguage]; } }); }
    catch (e) { /* Ignore in read-only environments */ }
  }

  window.__mjmock = {
    stats: stats,
    url: LOCAL_WS,
    inproc: false,
    server: null,
    // Manual trigger for the reconnect banner: __mjmock.reconnect.show('...') / .hide()
    reconnect: { show: function (t) { rcShow(t || '断线重连中…'); rc.stage = 'sync'; rc.openedAt = Date.now(); }, hide: rcHide, root: function () { return rc.root; } },
    exportLogs: function () { return window.__mjHost.downloadLogs(); },
    dump: function (n) { return stats.frames.slice(-(n || 20)); }
  };

  // ---------------- Reconnect banner ----------------
  // After a drop the client blocks its own UI while it re-syncs the match, so the player just sees dead clicks;
  // this banner says what is happening and for how long. It never takes pointer events, so it cannot block the game.
  var rc = { stage: 'idle', openedAt: 0, lastMsg: 0, burst: 0, hideTimer: null, clockTimer: null, root: null, textEl: null, secEl: null, since: 0 };
  function rcBuild() {
    if (rc.root) return rc.root;
    var css = document.createElement('style');
    css.textContent = '@keyframes mj-reconnect-spin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(css);
    var root = document.createElement('div');
    root.id = 'mj-reconnect';
    root.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;display:none;align-items:center;justify-content:center;'
      + 'background:rgba(0,0,0,.42);z-index:2147483000;pointer-events:none;color:#fff;'
      + 'font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif';
    var box = document.createElement('div');
    box.style.cssText = 'background:rgba(20,20,26,.92);border:1px solid rgba(255,255,255,.18);border-radius:12px;'
      + 'padding:18px 28px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.5);min-width:250px';
    var spin = document.createElement('div');
    spin.style.cssText = 'width:20px;height:20px;margin:0 auto 10px;border:2px solid rgba(255,255,255,.25);'
      + 'border-top-color:#7cc4ff;border-radius:50%;animation:mj-reconnect-spin .8s linear infinite';
    rc.textEl = document.createElement('div');
    rc.secEl = document.createElement('div');
    rc.secEl.style.cssText = 'opacity:.6;font-size:13px;margin-top:4px';
    box.appendChild(spin);
    box.appendChild(rc.textEl);
    box.appendChild(rc.secEl);
    var exportButton = document.createElement("button");
    exportButton.textContent = "导出诊断日志";
    exportButton.style.cssText = "pointer-events:auto;margin-top:12px;padding:5px 12px;cursor:pointer";
    exportButton.onclick = function () { window.__mjHost.downloadLogs().catch(function (error) { console.error("[offline] 日志导出失败", error); }); };
    box.appendChild(exportButton);
    root.appendChild(box);
    (document.body || document.documentElement).appendChild(root);
    rc.root = root;
    return root;
  }
  function rcShow(text) {
    rcBuild();
    rc.root.style.display = 'flex';
    rc.textEl.textContent = text;
    rc.since = Date.now();
    if (!rc.clockTimer) {
      rc.clockTimer = setInterval(function () {
        var s = Math.round((Date.now() - rc.since) / 1000);
        rc.secEl.textContent = s >= 1 ? '已等待 ' + s + ' 秒' : '';
      }, 500);
    }
  }
  function rcHide() {
    if (rc.hideTimer) { clearTimeout(rc.hideTimer); rc.hideTimer = null; }
    if (rc.clockTimer) { clearInterval(rc.clockTimer); rc.clockTimer = null; }
    rc.stage = 'idle'; rc.burst = 0;
    if (rc.root) rc.root.style.display = 'none';
  }
  function rcLater(ms) {
    if (rc.hideTimer) clearTimeout(rc.hideTimer);
    rc.hideTimer = setTimeout(function () {
      if (window.__mjClock && window.__mjClock.status().recovery) return;
      rcHide();
    }, ms);
  }
  // One banner per game socket: close -> "reconnecting", open -> "restoring", the replay burst ending -> hide.
  function watchGameSocket(ws) {
    var opened = false;
    ws.addEventListener('open', function () {
      if (opened) return;
      opened = true;
      if (rc.stage !== 'down') return;
      rc.stage = 'sync'; rc.openedAt = Date.now(); rc.lastMsg = 0; rc.burst = 0;
      rcShow('已重新连接，正在恢复牌局…');
      rcLater(4000);   // no replay frames at all (the hand already ended): hide once the handshake has surely passed
    });
    ws.addEventListener('close', function () {
      if (!opened) return;
      opened = false;
      rc.stage = 'down';
      rcShow('连接中断，正在重连…');
      if (rc.hideTimer) clearTimeout(rc.hideTimer);
      rc.hideTimer = setTimeout(function () {
        rc.hideTimer = null;
        if (rc.stage === "down") { rc.textEl.textContent = "仍未连接，正在重试；可导出日志排查"; console.warn("[offline] 断线超过20秒"); }
      }, 20000);
    });
    ws.addEventListener('message', function () {
      if (rc.stage !== 'sync') return;
      if (window.__mjClock && window.__mjClock.status().recovery) return;
      var now = Date.now();
      if (now - rc.openedAt > 12000) { rcHide(); return; }
      if (now - rc.lastMsg > 400) rc.burst = 0;
      rc.lastMsg = now;
      rc.burst++;
      // The resync replays this hand's frames back to back (a few ms apart); once that burst ends the table is rebuilt.
      if (rc.burst >= 3) rcLater(900);
    });
  }

  // ---------------- WebSocket hijack ----------------
  var NativeWS = window.WebSocket;
  var gameSocket = null;
  function PatchedWS(url, protocols) {
    var orig = url;
    var isGame = /riichiproxy|mahjongproxy|riichi_proxy/i.test(String(url));
    var target = isGame ? LOCAL_WS : url;
    if (!isGame && !localUrl(url)) throw new Error('离线模式阻止外部 WebSocket: ' + url);
    var InPage = isGame && window.__mjHostMode !== 'node' && window.__mj && window.__mj.server && window.__mj.server.FakeWebSocket;
    var Socket = InPage || NativeWS;
    var ws = protocols === undefined ? new Socket(target) : new Socket(target, protocols);
    if (isGame) console.log(InPage ? '[offline] 游戏 WS 交给页内后端' : '[offline] 游戏 WS 接到本机服务:', target);
    ws.binaryType = 'arraybuffer';
    var _send = ws.send.bind(ws);
    ws.send = function (d) {
      stats.sent++;
      recordFrame({ dir: 'send', len: d && d.byteLength || 0, t: Date.now() });
      return _send(d);
    };
    ws.addEventListener('message', function (e) {
      // Host-only clock sideband: consume before Unity sees the binary game protocol.
      if (isGame && typeof e.data === 'string' && window.__mjClock) {
        var packet;
        try { packet = JSON.parse(e.data); } catch (_) { packet = null; }
        if (packet && Object.prototype.hasOwnProperty.call(packet, 'mjSync')) {
          e.stopImmediatePropagation();
          window.__mjClock.synchronize(packet.mjSync, ws);
          return;
        }
        if (packet && Object.prototype.hasOwnProperty.call(packet, 'mjClock')) {
          e.stopImmediatePropagation();
          if (gameSocket === ws) window.__mjClock.accept(packet.mjClock);
          return;
        }
      }
      stats.recv++;
      recordFrame({ dir: 'recv', len: e.data && e.data.byteLength || 0, t: Date.now() });
    });
    ws.addEventListener('open', function () { console.log('[offline] WS 已连接', url); });
    ws.addEventListener('error', function (e) { console.warn('[offline] WS 错误', e.message || 'transport-error'); });
    ws.addEventListener('close', function (e) {
      if (window.__mjClock) window.__mjClock.disconnect(ws);
      console.log('[offline] WS 关闭', JSON.stringify({ code: e.code, reason: e.reason, wasClean: e.wasClean, sent: stats.sent, recv: stats.recv }));
    });
    if (isGame) {
      gameSocket = ws;
      if (window.__mjClock) window.__mjClock.connect(ws);
      watchGameSocket(ws);
    }
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  PatchedWS.CONNECTING = 0; PatchedWS.OPEN = 1;
  PatchedWS.CLOSING = 2; PatchedWS.CLOSED = 3;
  // FakeWebSocket is not an instance of the native WebSocket; this keeps instanceof working
  try {
    Object.defineProperty(PatchedWS, Symbol.hasInstance, {
      value: function (o) {
        var Fake = window.__mj && window.__mj.server && window.__mj.server.FakeWebSocket;
        return o instanceof NativeWS || (!!Fake && o instanceof Fake);
      }
    });
  } catch (e) { /* Ignore on old browsers */ }
  window.WebSocket = PatchedWS;

  // ---------------- fetch hijack ----------------
  var nativeFetch = window.fetch && window.fetch.bind(window);
  if (nativeFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var assetUrl = localAssetUrl(url);
      if (assetUrl) return nativeFetch(assetUrl, init);
      if (!localUrl(url)) {
        console.log('[offline] 拦截外部 fetch:', url);
        return emptyResponse();
      }
      return nativeFetch(input, init);
    };
  }

  // ---------------- XHR hijack ----------------
  var open = XMLHttpRequest.prototype.open;
  var setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    var args = Array.prototype.slice.call(arguments);
    var assetUrl = localAssetUrl(u);
    this._mjOfflineBlocked = typeof u === 'string' && !assetUrl && !localUrl(u);
    this._mjAsset = !!assetUrl;
    if (assetUrl) {
      args[1] = assetUrl;
    } else if (this._mjOfflineBlocked) {
      console.log('[offline] 拦截外部 XHR:', u);
      args[1] = BASE + 'mock/empty.json';
    }
    return open.apply(this, args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === 'range') {
      if (this._mjOfflineBlocked) return;
      // The game asks for StreamingAssets with "Range: bytes=0-" (the whole file). Dropping it keeps the request a plain
      // GET, so the browser HTTP cache can serve the bundle on later visits instead of downloading it again.
      if (this._mjAsset && /^bytes=0-$/i.test(String(value).trim())) return;
    }
    return setRequestHeader.call(this, name, value);
  };

  // ---------------- External <script> interception ----------------
  var setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (k, v) {
    if (this.tagName === 'SCRIPT' && k === 'src' && !localUrl(v)) {
      console.log('[offline] 拦截 script:', v);
      return;
    }
    return setAttr.apply(this, arguments);
  };
  var srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLScriptElement.prototype, 'src', {
      get: srcDesc.get,
      set: function (v) {
        if (!localUrl(v)) {
          console.log('[offline] 拦截 script.src:', v);
          return;
        }
        srcDesc.set.call(this, v);
      },
      configurable: true
    });
  }

  console.log('[offline] 补丁已加载');

  // ---------------- Safe override of webGLPluginHelper.getUrlParams ----------------
  // framework.js's implementation does split('?')[1] when the URL has no '?', getting undefined, and then split('&') blows up;
  // we reimplement it with URLSearchParams and install it at every possible mount point.
  function safeGetUrlParams() {
    try {
      var qs = window.location.search;
      var u = new URLSearchParams(qs);
      var obj = {};
      u.forEach(function (v, k) { obj[k] = v; });
      // Also reads parameters from the hash
      var h = window.location.hash || '';
      if (h.indexOf('?') >= 0) {
        new URLSearchParams(h.split('?')[1]).forEach(function (v, k) {
          if (!(k in obj)) obj[k] = v;
        });
      }
      return obj;
    } catch (e) {
      console.warn('[offline] safeGetUrlParams 失败', e);
      return {};
    }
  }
  function patchHelper(helper) {
    if (!helper || typeof helper.getUrlParams !== 'function') return false;
    if (helper.__patched) return true;
    helper.__patched = true;
    helper.getUrlParams = safeGetUrlParams;
    console.log('[offline] 已 patch webGLPluginHelper.getUrlParams');
    return true;
  }
  // Polling: framework.js loads asynchronously, so wait until Module/webGLPluginHelper appears
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var done = false;
    // Common mount points
    var candidates = [window, window.Module, window.unityInstance, window.QuickService];
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || !Object.prototype.hasOwnProperty.call(c, 'webGLPluginHelper')) continue;
      if (patchHelper(c.webGLPluginHelper)) done = true;
      }
    if (done || tries > 600) clearInterval(timer);  // At most 60 seconds
  }, 100);
})();
