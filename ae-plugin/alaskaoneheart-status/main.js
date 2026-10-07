/* alaskaoneheart status: tells Pavel's site what is open in After Effects, without Discord.
   Runs hidden inside After Effects. Every 15 seconds it reads the project through host/status.jsx, and it reports to the Worker
   every 30 seconds or as soon as something changes. The site shows the card from these reports; 75 seconds of silence means AE is closed. */
(function () {
  var URL = 'https://super-forest-c227.avantgardeqqe.workers.dev/ae';
  var cep = window.__adobe_cep__;
  if (!cep) return;
  var since = Date.now(), last = null, lastSent = 0, sentState = '', batch = 0, asking = 0;
  var fs = null, path = null, proc = null;
  try {
    var node = window.cep_node || {}, req = typeof require === 'function' ? require : node.require;
    proc = typeof process !== 'undefined' ? process : node.process;
    fs = req('fs'); path = req('path');
  } catch (e) { fs = null; /* Node is off: the token lives in localStorage only */ }

  // the token proves the reports come from this computer; the Worker remembers the first one it sees
  function tokenFile() {
    var base = (proc && proc.env && proc.env.APPDATA) || '';
    return fs && path && base ? path.join(base, 'alaskaoneheart', 'token') : '';
  }
  function newToken() {
    var a = new Uint8Array(24), s = '';
    window.crypto.getRandomValues(a);
    for (var i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return s;
  }
  function loadToken() {
    var t = '', f = tokenFile();
    try { if (f && fs.existsSync(f)) t = String(fs.readFileSync(f, 'utf8')).trim(); } catch (e) {}
    if (!t) try { t = localStorage.getItem('aoh_token') || ''; } catch (e) {}
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(t)) t = newToken();
    try { if (f) { if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f)); fs.writeFileSync(f, t); } } catch (e) {}
    try { localStorage.setItem('aoh_token', t); } catch (e) {}
    return t;
  }
  var token = loadToken();

  function body(s, quit) {
    var b = { t: token, project: s.project, comp: s.comp, layers: s.layers, rendering: s.rendering, rq: s.rq, since: since, v: 1 };
    if (quit) b.quit = true;
    return JSON.stringify(b);
  }
  // text/plain keeps it a simple request, so no CORS preflight is needed
  function send(s) {
    lastSent = Date.now();
    sentState = JSON.stringify(s);
    try { fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body(s) })['catch'](function () {}); } catch (e) {}
  }

  // After Effects loads host/status.jsx together with the extension; if it ever skipped it, load it by hand once
  var loaded = false;
  function loadHost() {
    loaded = true;
    try {
      var dir = decodeURI(cep.getSystemPath('extension')).replace(/^file:\/\/(\/(?=[A-Za-z]:))?/, '');
      cep.evalScript('$.evalFile(' + JSON.stringify(dir + '/host/status.jsx') + ')', function () {});
    } catch (e) {}
  }

  function read() {
    if (asking && Date.now() - asking < 60000) return;   // AE is busy (a long render): the 30-second beat below keeps the last state alive meanwhile
    asking = Date.now();
    cep.evalScript('aohStatus()', function (res) {
      asking = 0;
      var s;
      try { s = JSON.parse(res); } catch (e) { if (!loaded) loadHost(); return; }
      // render queue: count the batch when rendering starts, then show which item of it is rendering
      if (s.rendering) { if (!batch) batch = s.queued + s.active; s.rq = [Math.max(1, batch - s.queued), batch]; }
      else { batch = 0; s.rq = [0, 0]; }
      delete s.queued; delete s.active;
      last = s;
      if (JSON.stringify(s) !== sentState || Date.now() - lastSent > 29000) send(s);
    });
  }
  read();
  setInterval(read, 15000);
  setInterval(function () { if (last && Date.now() - lastSent > 29000) send(last); }, 30000);

  // closing After Effects: one last report, so the site switches to "last in AE" at once instead of after 75 seconds
  var gone = false;
  function bye() {
    if (gone || !last) return;
    gone = true;
    var b = body(last, true);
    try { if (navigator.sendBeacon && navigator.sendBeacon(URL, b)) return; } catch (e) {}
    try { fetch(URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: b, keepalive: true }); } catch (e) {}
  }
  try { cep.addEventListener('com.adobe.csxs.events.ApplicationBeforeQuit', bye); } catch (e) {}
  window.addEventListener('beforeunload', bye);
})();
