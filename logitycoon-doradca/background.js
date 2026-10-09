// LogiTycoon Doradca – service worker rozszerzenia.
// 1) Timer: Chrome mocno spowalnia setTimeout w kartach w tle (nawet do 1 wywołania na minutę), przez co autopilot "stał".
//    Odliczanie robi więc service worker, którego timery nie są dławione, a content script czeka na odpowiedź.
// 2) Powiadomienia systemowe, gdy bot potrzebuje człowieka (captcha, wylogowanie, problem z mediami).
// 3) Strażnik karty: włączony autopilot co 15 s daje znak życia; jeśli przez 3 min milczy (błąd sieci,
//    zawieszona albo zamrożona karta), karta gry jest przeładowywana i bot wraca do pracy.
const STALE_MS = 3 * 60 * 1000;
const RELOAD_GAP_MS = 5 * 60 * 1000;

const getWatch = async () => (await chrome.storage.session.get('ltdWatch')).ltdWatch || null;
const setWatch = w => chrome.storage.session.set({ ltdWatch: w });

async function checkStale() {
  const w = await getWatch();
  if (!w || !w.enabled || w.tabId == null) return;
  const now = Date.now();
  if (now - w.t < (self.__ltdStaleMs || STALE_MS) || now - (w.reloadedAt || 0) < RELOAD_GAP_MS) return;
  try {
    const tab = await chrome.tabs.get(w.tabId);
    if (!tab || !/logitycoon\.com/.test(tab.url || tab.pendingUrl || '') && !/^chrome-error:/.test(tab.url || '')) {
      await setWatch({ ...w, enabled: false });
      return;
    }
    await chrome.tabs.reload(w.tabId);
    await setWatch({ ...w, reloadedAt: now, t: now });
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icon128.png', priority: 1,
      title: 'LogiTycoon: wznawiam autopilota',
      message: 'Strona gry nie odpowiadała przez 3 minuty – przeładowałem kartę.'
    });
  } catch (e) {
    await setWatch({ ...w, enabled: false });   // karta zamknięta
  }
}
self.checkStale = checkStale;

chrome.alarms.create('ltd-watch', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => { if (a.name === 'ltd-watch') checkStale(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.ltd === 'sleep') {
    const ms = Math.max(0, Math.min(Number(msg.ms) || 0, 4 * 60 * 1000));
    setTimeout(() => {
      try { sendResponse({ ok: true }); } catch (e) {}
    }, ms);
    return true;
  }
  if (msg.ltd === 'alive') {
    if (sender.tab && sender.tab.id != null) {
      getWatch().then(w => setWatch({ ...(w || {}), tabId: sender.tab.id, enabled: !!msg.enabled, t: Date.now() }));
    }
    sendResponse({ ok: true });
    return false;
  }
  if (msg.ltd === 'notify') {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icon128.png',
        title: String(msg.title || 'LogiTycoon Autopilot').slice(0, 80),
        message: String(msg.msg || '').slice(0, 300),
        priority: 2
      });
    } catch (e) {}
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
