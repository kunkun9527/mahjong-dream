/* Save editor: a tab on the right edge opens a panel to edit nickname, rank and wallet, reset match records,
 * and export/import/reset the save. All changes go through window.__mjHost (web-host.js), then the game reloads
 * so the client fetches the new lobby data. Single-player only, so there is nothing to protect against. */
(function () {
  'use strict';

  var host = window.__mjHost;
  if (!host) return;

  var CSS = [
    // Above the vertical middle, where translation extensions usually park their floating button.
    '#mj-mod-tab{position:fixed;right:0;top:30%;transform:translateY(-50%);z-index:2147483646;width:22px;height:64px;',
    'border:0;border-radius:8px 0 0 8px;background:rgba(20,24,32,.55);color:#e8d9a8;font:16px/64px sans-serif;cursor:pointer;',
    'padding:0;opacity:.45;transition:opacity .2s}',
    '#mj-mod-tab:hover,#mj-mod-tab[aria-expanded=true]{opacity:1}',
    '#mj-mod{position:fixed;right:26px;top:50%;transform:translateY(-50%);z-index:2147483647;width:300px;max-height:92vh;',
    'overflow:auto;box-sizing:border-box;padding:12px 14px;border-radius:10px;background:rgba(20,24,32,.94);color:#eee;',
    'font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
    '#mj-mod[hidden]{display:none}',
    '#mj-mod h2{margin:0 0 8px;font-size:15px;color:#e8d9a8;display:flex;justify-content:space-between}',
    '#mj-mod h3{margin:12px 0 6px;font-size:12px;color:#9aa4b2;text-transform:uppercase;letter-spacing:.05em}',
    '#mj-mod label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0}',
    '#mj-mod input,#mj-mod select{width:130px;box-sizing:border-box;padding:3px 5px;border:1px solid #445;border-radius:4px;',
    'background:#11151c;color:#eee;font:inherit}',
    '#mj-mod .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
    '#mj-mod button.act{flex:1;padding:6px 8px;border:0;border-radius:5px;background:#3a4558;color:#fff;font:inherit;cursor:pointer}',
    '#mj-mod button.act:hover{background:#4b5970}',
    '#mj-mod button.primary{background:#b8862b}#mj-mod button.primary:hover{background:#cf9a37}',
    '#mj-mod button.danger{background:#7a2f2f}#mj-mod button.danger:hover{background:#963a3a}',
    '#mj-mod button:disabled{opacity:.4;cursor:default}',
    '#mj-mod .close{border:0;background:none;color:#aaa;font-size:18px;line-height:1;cursor:pointer}',
    '#mj-mod .note{margin:6px 0 0;color:#9aa4b2;font-size:12px}',
    '#mj-mod .msg{margin:8px 0 0;min-height:1em;color:#e8d9a8}#mj-mod .msg.error{color:#ff8a80}',
    // One-time host notice, e.g. a match the AI finished while the player was away.
    '#mj-notice{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;',
    'align-items:center;max-width:min(560px,90vw);box-sizing:border-box;padding:10px 14px;border-radius:8px;',
    'background:rgba(20,24,32,.94);color:#eee;font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}',
    '#mj-notice button{flex:none;padding:5px 12px;border:0;border-radius:5px;background:#b8862b;color:#fff;font:inherit;cursor:pointer}'
  ].join('');

  var HTML = [
    '<h2>Save Editor <button type="button" class="close" title="Close">&times;</button></h2>',
    '<p class="note busy" hidden>A match is in progress. Finish or leave it before changing the save.</p>',
    '<h3>Account</h3>',
    '<label>Nickname <input name="nickname" maxlength="24"></label>',
    '<h3>Rank</h3>',
    '<label>4-Player <select name="yonma.level"></select></label>',
    '<label>4-Player PT <input name="yonma.point" type="number" min="0" step="1"></label>',
    '<label>3-Player <select name="sanma.level"></select></label>',
    '<label>3-Player PT <input name="sanma.point" type="number" min="0" step="1"></label>',
    '<h3>Wallet</h3><div class="items"></div>',
    '<div class="row"><button type="button" class="act primary apply">Apply &amp; Reload</button></div>',
    '<h3>Match Records</h3><p class="note games"></p>',
    '<div class="row"><button type="button" class="act danger reset-stats">Reset Match Records</button></div>',
    '<h3>Save File</h3>',
    '<div class="row"><button type="button" class="act export">Export</button>',
    '<button type="button" class="act import">Import</button>',
    '<button type="button" class="act danger new-account">New Account</button></div>',
    '<input type="file" accept="application/json,.json" hidden>',
    '<p class="note where"></p>',
    '<p class="msg" role="status"></p>'
  ].join('');

  function start() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    var tab = document.createElement('button');
    tab.id = 'mj-mod-tab';
    tab.type = 'button';
    tab.title = 'Save Editor';
    tab.setAttribute('aria-expanded', 'false');
    tab.textContent = '\u2699';
    var panel = document.createElement('div');
    panel.id = 'mj-mod';
    panel.hidden = true;
    panel.innerHTML = HTML;
    document.body.appendChild(tab);
    document.body.appendChild(panel);


    function $(selector) { return panel.querySelector(selector); }
    var message = $('.msg');
    var fileInput = $('input[type=file]');
    var actions = panel.querySelectorAll('button.act');
    var current = null;

    $('.where').textContent = host.mode === 'node'
      ? 'Saved to userdata/profile.json by the local service.'
      : 'Saved in this browser only. Export a backup before clearing site data.';

    function say(text, isError) {
      message.textContent = text || '';
      message.className = 'msg' + (isError ? ' error' : '');
    }

    function setBusy(busy) {
      for (var i = 0; i < actions.length; i++) {
        var readOnly = actions[i].classList.contains('export');
        actions[i].disabled = busy || (!readOnly && !!(current && current.inMatch));
      }
    }

    function render(state) {
      current = state;
      $('.busy').hidden = !state.inMatch;
      $('[name=nickname]').value = state.nickname;
      ['yonma', 'sanma'].forEach(function (mode) {
        var select = $('[name="' + mode + '.level"]');
        select.innerHTML = '';
        state.rankNames.forEach(function (name, index) {
          var option = document.createElement('option');
          option.value = String(index + 1);
          option.textContent = (index + 1) + '. ' + name;
          select.appendChild(option);
        });
        select.value = String(state.ranks[mode].level);
        $('[name="' + mode + '.point"]').value = state.ranks[mode].point;
      });
      var items = $('.items');
      items.innerHTML = '';
      state.items.forEach(function (item) {
        var label = document.createElement('label');
        label.textContent = item.name + ' ';
        var input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.name = 'item.' + item.id;
        input.value = item.count;
        label.appendChild(input);
        items.appendChild(label);
      });
      $('.games').textContent = '4-Player: ' + state.games.yonma + ' games \u00b7 3-Player: ' + state.games.sanma + ' games';
      setBusy(false);
    }

    function run(body, done) {
      setBusy(true);
      say('Working\u2026');
      return host.request(body).then(function (result) {
        say('');
        done(result);
      }).catch(function (error) {
        say(error && error.message || String(error), true);
        setBusy(false);
      });
    }

    function reloadGame(text) {
      say(text + ' Reloading\u2026');
      setTimeout(function () { location.reload(); }, 400);
    }

    function refresh() {
      say('');
      return run({ action: 'state' }, render);
    }

    function toggle(open) {
      panel.hidden = !open;
      tab.setAttribute('aria-expanded', String(open));
      if (open) refresh();
    }

    tab.addEventListener('click', function () { toggle(panel.hidden); });
    $('.close').addEventListener('click', function () { toggle(false); });

    $('.apply').addEventListener('click', function () {
      var changes = { nickname: $('[name=nickname]').value, ranks: {}, items: {} };
      ['yonma', 'sanma'].forEach(function (mode) {
        changes.ranks[mode] = {
          level: Number($('[name="' + mode + '.level"]').value),
          point: Number($('[name="' + mode + '.point"]').value),
        };
      });
      current.items.forEach(function (item) {
        changes.items[item.id] = Number($('[name="item.' + item.id + '"]').value);
      });
      run({ action: 'edit', changes: changes }, function () { reloadGame('Saved.'); });
    });

    $('.reset-stats').addEventListener('click', function () {
      if (!confirm('Clear all 4-player and 3-player match records? Rank and wallet are kept.')) return;
      run({ action: 'resetStats' }, function () { reloadGame('Match records cleared.'); });
    });

    $('.new-account').addEventListener('click', function () {
      if (!confirm('Start a new account? The current save is replaced. Export it first if you want to keep it.')) return;
      run({ action: 'reset' }, function () { reloadGame('New account created.'); });
    });

    $('.export').addEventListener('click', function () {
      run({ action: 'export' }, function (profile) {
        var blob = new Blob([JSON.stringify(profile, null, 2) + '\n'], { type: 'application/json' });
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'mahjong-dream-profile-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
        say('Exported.');
        setBusy(false);
      });
    });

    function showNotice(text) {
      var box = document.createElement('div');
      box.id = 'mj-notice';
      box.setAttribute('role', 'status');
      var span = document.createElement('span');
      span.textContent = text;
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.textContent = 'OK';
      ok.addEventListener('click', function () {
        box.remove();
        host.request({ action: 'dismissNotice' }).catch(function () {});
      });
      box.appendChild(span);
      box.appendChild(ok);
      document.body.appendChild(box);
    }
    host.ready.then(function () { return host.request({ action: 'state' }); }).then(function (state) {
      if (state && state.notice) showNotice(state.notice);
    }).catch(function () {});

    $('.import').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      file.text().then(function (text) {
        var profile;
        try { profile = JSON.parse(text); }
        catch (e) { return say('Not a valid JSON save file.', true); }
        if (!confirm('Replace the current save with "' + file.name + '"?')) return;
        run({ action: 'import', profile: profile }, function () { reloadGame('Imported.'); });
      });
    });
  }

  // Unity listens for keys on window in the capture phase and swallows typed characters. This listener is registered
  // before Unity starts, so it runs first and keeps keys typed inside the panel away from the game.
  ['keydown', 'keyup', 'keypress'].forEach(function (type) {
    window.addEventListener(type, function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('#mj-mod')) event.stopImmediatePropagation();
    }, true);
  });

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
