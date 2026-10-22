/* Offline single-player patch for Mahjong Dream: the game WebSocket connects to the local service, and all external network requests are blocked. */
(function () {
  'use strict';

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
        return location.origin + parsed.pathname + parsed.search;
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
    dump: function (n) { return stats.frames.slice(-(n || 20)); }
  };

  // ---------------- WebSocket hijack ----------------
  var NativeWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    var orig = url;
    var isGame = /riichiproxy|mahjongproxy|riichi_proxy/i.test(String(url));
    var target = isGame ? LOCAL_WS : url;
    if (!isGame && !localUrl(url)) throw new Error('离线模式阻止外部 WebSocket: ' + url);
    var ws = protocols === undefined ? new NativeWS(target) : new NativeWS(target, protocols);
    if (isGame) console.log('[offline] 游戏 WS 接到本机服务:', target);
    ws.binaryType = 'arraybuffer';
    var _send = ws.send.bind(ws);
    ws.send = function (d) {
      stats.sent++;
      recordFrame({ dir: 'send', len: d && d.byteLength || 0, t: Date.now() });
      return _send(d);
    };
    ws.addEventListener('message', function (e) {
      stats.recv++;
      recordFrame({ dir: 'recv', len: e.data && e.data.byteLength || 0, t: Date.now() });
    });
    ws.addEventListener('open', function () { console.log('[offline] WS 已连接', url); });
    ws.addEventListener('error', function (e) { console.warn('[offline] WS 错误', e); });
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  PatchedWS.CONNECTING = 0; PatchedWS.OPEN = 1;
  PatchedWS.CLOSING = 2; PatchedWS.CLOSED = 3;
  // FakeWebSocket is not an instance of the native WebSocket; this keeps instanceof working
  try {
    Object.defineProperty(PatchedWS, Symbol.hasInstance, {
      value: function (o) {
        return o instanceof NativeWS;
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
    if (assetUrl) {
      args[1] = assetUrl;
    } else if (this._mjOfflineBlocked) {
      console.log('[offline] 拦截外部 XHR:', u);
      args[1] = location.origin + '/mock/empty.json';
    }
    return open.apply(this, args);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._mjOfflineBlocked && String(name).toLowerCase() === 'range') return;
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
