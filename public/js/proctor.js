// Records suspicious behaviour during a test and sends it to the server.
// Needs common.js ($ and api) to be loaded first.
const Proctor = (() => {
  const CFG = {
    block: true,        // also block copy / paste / right-click / shortcuts (not just record them)
    fullscreen: true,   // ask for full screen and record when the student leaves it
    devtools: false     // weak guess based on window size; keep off unless you want it
  };
  const LABEL = {
    tab_hidden: 'switched tab or minimised the window', tab_return: 'returned to the test',
    window_blur: 'clicked outside the test window', copy: 'tried to copy', cut: 'tried to cut',
    paste: 'tried to paste', contextmenu: 'opened the right-click menu', shortcut: 'used a blocked shortcut',
    printscreen: 'pressed Print Screen', fullscreen_exit: 'left full screen',
    devtools_suspected: 'possibly opened developer tools'
  };
  const MIN_GAP = { devtools_suspected: 60000 };   // ms between repeats of the same event

  let testId = null, getQ = () => null, on = false, bound = false, fsSeen = false;
  let queue = [], last = {}, hiddenAt = 0, blurTimer = null, flushTimer = null, devTimer = null;

  function log(kind, detail) {
    if (!on) return;
    const now = Date.now();
    if (last[kind] && now - last[kind] < (MIN_GAP[kind] || 800)) return;
    last[kind] = now;
    if (queue.length < 100) queue.push({ kind, detail: detail || '', q: getQ(), at: now });
    const w = $('#warn');
    if (w && kind !== 'tab_return') w.textContent = 'Recorded and shown to your teacher: you ' + (LABEL[kind] || kind) + '.';
    flush();
  }

  async function flush() {
    if (!queue.length || !testId) return;
    const batch = queue.splice(0, 20);
    try { await api(`/student/tests/${testId}/events`, { method: 'POST', body: { events: batch } }); }
    catch (e) { queue.unshift(...batch); }
  }

  const h = {
    vis() {
      if (document.hidden) { hiddenAt = Date.now(); log('tab_hidden'); }
      else if (hiddenAt) { log('tab_return', Math.round((Date.now() - hiddenAt) / 1000) + 's away'); hiddenAt = 0; }
    },
    blur() {   // another window got focus (alt-tab, split screen, pop-up). Ignore pure tab switches.
      clearTimeout(blurTimer);
      blurTimer = setTimeout(() => { if (on && !document.hidden && !document.hasFocus()) log('window_blur'); }, 400);
    },
    focus() { clearTimeout(blurTimer); },
    clip(e) { if (!on) return; if (CFG.block) e.preventDefault(); log(e.type); },
    menu(e) { if (!on) return; if (CFG.block) e.preventDefault(); log('contextmenu'); },
    key(e) {
      if (!on) return;
      const mod = e.ctrlKey || e.metaKey;
      const letter = e.code && e.code.startsWith('Key') ? e.code.slice(3) : '';
      const bad = (mod && 'CVXAPSUFG'.includes(letter) && letter) ||
                  e.key === 'F12' ||
                  ((e.ctrlKey || (e.metaKey && e.altKey)) && (e.shiftKey || e.altKey) && 'IJC'.includes(letter) && letter);
      if (bad) {
        if (CFG.block) e.preventDefault();
        log('shortcut', (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Cmd+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (letter || e.key));
      }
    },
    keyup(e) { if (on && e.key === 'PrintScreen') log('printscreen'); },
    fs() {
      if (document.fullscreenElement) fsSeen = true;
      else if (on && fsSeen && CFG.fullscreen) log('fullscreen_exit');
    },
    click() { if (on && CFG.fullscreen && fsSeen && !document.fullscreenElement) goFullscreen(); }
  };

  const listeners = () => [
    [document, 'visibilitychange', h.vis], [window, 'blur', h.blur], [window, 'focus', h.focus],
    [document, 'copy', h.clip], [document, 'cut', h.clip], [document, 'paste', h.clip],
    [document, 'contextmenu', h.menu], [document, 'keydown', h.key, true], [document, 'keyup', h.keyup],
    [document, 'fullscreenchange', h.fs], [document, 'click', h.click]
  ];

  // Call this directly inside the Start button's click handler (browsers only allow it after a click).
  function goFullscreen() {
    if (!CFG.fullscreen) return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {});
  }

  function start(id, qGetter) {
    testId = id; getQ = qGetter || getQ; on = true; queue = []; last = {}; hiddenAt = 0;
    if (!bound) { listeners().forEach(([t, ev, fn, cap]) => t.addEventListener(ev, fn, !!cap)); bound = true; }
    clearInterval(flushTimer); flushTimer = setInterval(flush, 5000);
    clearInterval(devTimer);
    if (CFG.devtools) devTimer = setInterval(() => {
      if (window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 250) log('devtools_suspected');
    }, 2000);
    document.body.classList.add('proctored');
    const w = $('#warn'); if (w) w.textContent = '';
  }
  function stop() {
    flush(); on = false; clearInterval(flushTimer); clearInterval(devTimer);
    document.body.classList.remove('proctored');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }
  const pause = () => { on = false; };    // use around confirm() dialogs, which blur the window
  const resume = () => { on = true; };

  return { start, stop, pause, resume, goFullscreen };
})();
