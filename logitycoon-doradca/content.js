(() => {
  'use strict';
  // LogiTycoon Doradca & Autopilot 3.6 – samodzielne prowadzenie firmy 24/7:
  //  • cykl ładunków bez premium: Trasy → Przydział zestawu → Załaduj → Jedź! → Rozładuj → Zakończ,
  //  • paliwo: zbiornik firmy → korporacja → publiczne; sen, naprawy, opony (zmiana + zakup), media (odnawianie umów),
  //  • ekonomia z danych gry: spalanie/prędkość/moc modeli z salonu, prognozy kosztów z ładunków, czasy etapów,
  //    ceny paliwa w krajach (flaga = kraj), koszty stałe z Finansów,
  //  • plan inwestycji wg czasu zwrotu, patrol budzony na koniec etapu, watchdog, powiadomienia,
  //  • długość tras dopasowana do tego, ile zestawów bot nadąży obsłużyć; limit pełnego baku i kondycji pojazdów.
  const VERSION = '3.6';
  const PAGE_T0 = Date.now();

  // hp = moc wymagana przez naczepę (KM), pts = punkty poziomu za ładunek; ceny naczep 3–9 to szacunki (salon pokazuje je po licencji)
  const TIERS = {
    1: { id: 1, name: 'Domyślny transport', trailerName: 'Domyślna naczepa', hp: 200, pts: 6, level: 1, licCompany: 0, licDriver: 0, trailerPrice: 19239 },
    2: { id: 2, name: 'Transport kontenerowy', trailerName: 'Naczepa podkontenerowa', hp: 240, pts: 7, level: 2, licCompany: 4000, licDriver: 390, trailerPrice: 42500 },
    3: { id: 3, name: 'Transport wywrotką', trailerName: 'Wywrotka', hp: 300, pts: 8, level: 4, licCompany: 7000, licDriver: 780, trailerPrice: 55000 },
    4: { id: 4, name: 'Transport chłodniczy', trailerName: 'Chłodnia', hp: 300, pts: 9, level: 6, licCompany: 10000, licDriver: 1170, trailerPrice: 70000 },
    5: { id: 5, name: 'Transport płynów', trailerName: 'Cysterna', hp: 300, pts: 10, level: 8, licCompany: 15000, licDriver: 1560, trailerPrice: 90000 },
    6: { id: 6, name: 'Transport naczepą niskopodłogową', trailerName: 'Naczepa niskopodłogowa', hp: 400, pts: 11, level: 12, licCompany: 25000, licDriver: 2335, trailerPrice: 120000 },
    7: { id: 7, name: 'Transport chemikaliów', trailerName: 'Naczepa do przewozu chemikaliów', hp: 400, pts: 14, level: 16, licCompany: 40000, licDriver: 3110, trailerPrice: 160000 },
    8: { id: 8, name: 'Transport substancji radioaktywnych', trailerName: 'Naczepa do przewozu substancji radioaktywnych', hp: 500, pts: 16, level: 20, licCompany: 70000, licDriver: 4280, trailerPrice: 220000 },
    9: { id: 9, name: 'Ciężki transport', trailerName: 'Naczepa do transportu ładunków ciężkich', hp: 600, pts: 18, level: 25, licCompany: 120000, licDriver: 5445, trailerPrice: 300000 }
  };
  const TYPES = {};
  for (const [k, v] of Object.entries(TIERS)) TYPES[k] = v.trailerName;

  // Sezon trwa 24 h: wiosna → lato (opony letnie) → jesień → zima (opony zimowe)
  const SEASON_KEY = { wiosna: 'spring', spring: 'spring', lato: 'summer', summer: 'summer', jesien: 'autumn', autumn: 'autumn', fall: 'autumn', zima: 'winter', winter: 'winter' };
  const SEASON_PL = { spring: 'Wiosna', summer: 'Lato', autumn: 'Jesień', winter: 'Zima' };
  const TIRE_PL = { summer: 'letnie', winter: 'zimowe' };

  const DEF = {
    target: 2000000,
    reserve: 5000,        // rezerwa na koszty dzienne (ubezpieczenie, media) – zakup opon jej nie ruszy
    repairAt: 40,         // naprawa poniżej % stanu
    condReserve: 5,       // trasa tylko taka, po której ciężarówce i naczepie zostanie co najmniej tyle % kondycji
    sleepAt: 30,          // sen poniżej % energii (100% = wypoczęty)
    tireMinCond: 20,      // komplet opon poniżej tego stanu traktujemy jak zużyty
    tireWornAt: 30,       // opony założone na ciężarówkę poniżej tego stanu – wymiana (gra przy zużytych blokuje "Jedź!")
    utilHoursAhead: 3,    // nowa umowa na media / kontrakt mechaników, gdy do wygaśnięcia zostało mniej godzin
    mechanics: 0,         // ilu mechaników utrzymywać (0 = auto: ok. 40% liczby pojazdów, min. 2, więcej po odmowie naprawy)
    earnWinMin: 30,       // zarobek na godzinę w panelu – z ostatnich tylu minut (bieżące tempo)
    fuelManual: 0,        // € za litr na sztywno (0 = ceny z gry)
    syncMin: 15           // co ile minut pełne odświeżenie danych w tle
  };

  const DEF_AP = {
    enabled: false,
    autoTrips: true,
    autoFuel: true,
    autoSleep: true,
    autoRepair: true,
    autoTires: true,            // zmiana opon na sezon + dokupowanie brakujących kompletów
    autoUtilities: true,        // odnawianie umów na prąd i wodę ("Autoodnawianie" jest tylko dla premium)
    sendWorker: true,           // pracownik magazynu jedzie z ładunkiem i rozładowuje go na miejscu
    avoidRouteRefuel: true,     // trasa nie dłuższa niż pełny bak (tankowanie w trasie po ~€2/L) – sztywny limit
    stealthMode: true,          // losowe opóźnienia + przerwy AFK
    autoExpandFleet: true,      // licencja kolejnego typu + naczepa + Transferio
    targetTier: 0,              // 0 = kolejny typ po najlepszej posiadanej naczepie, albo 2..9
    expandReserve: 0,           // inwestycje tylko ponad tę kwotę na koncie (0 = auto: rezerwa gotówki / koszty stałe doby)
    investState: null,
    minDelay: 400,
    maxDelay: 950,
    breakMinInterval: 28,
    breakDuration: 180,
    status: 'Wyłączony',
    statusDetail: 'Gotowy do pracy. Kliknij Uruchom Autopilota.',
    stats: { trips: 0, profitEst: 0, repairs: 0, refuels: 0, sleeps: 0, investments: 0, tires: 0, contracts: 0, hires: 0, startTime: 0 },
    breakUntil: 0,
    lastBreakTime: 0,
    nextPatrolTime: 0,
    patrolInfo: '',
    cool: {},                   // klucz → do kiedy pomijać rzecz, której teraz nie da się zrobić (zamiast zapętlenia)
    blocked: {},                // ładunki czekające na zasoby – pokazywane w panelu
    att: null,                  // licznik prób tej samej akcji na tym samym ładunku
    due: {},                    // ładunek → kiedy kończy się bieżący etap (patrol budzi się dokładnie wtedy)
    fuelRound: null,            // objazd zakładek stacji paliw { visited: [f], refuels }
    lastFuelRound: 0,
    fuelSoon: false,            // po rozładunku/zakończeniu zatankuj zwolnioną ciężarówkę
    tripPlan: null,             // [{ city, type, n, truckId, trailerId }] – zlecenia dla wolnych zestawów
    sleepTarget: null,
    manualSel: null,
    losowyPremium: false,
    autoHire: true,             // zatrudnianie: brak kierowcy/pracownika przy zestawie, następca przed emeryturą, brak menedżerów
    autoNewSets: true,          // rozbudowa floty: ciężarówka do nieużywanej naczepy / nowy zestaw, gdy zwrot ≤ 48 h
    badModels: {},              // model ciężarówki → do kiedy pomijać (przycisk zakupu zablokowany mimo pieniędzy)
    maxPaybackH: 168,           // inwestycja tylko, gdy zwróci się w tylu godzinach (7 dni; gotówka na koncie nic nie zarabia)
    holdTruck: null,            // { id, until } – ciężarówka czeka na naczepę nowego typu (przewóz Transferio)
    hireTask: null,             // { role, city, why, replaces, lic }
    licenseTask: null,          // { driverId, targetTier } – egzaminy nowo zatrudnionego kierowcy
    newSet: null,               // { step, model, type, total, trailerId, city, transfer, hireDriver, hireWorker } – budowa zestawu
    replaced: {},               // pracownik → kiedy zatrudniono następcę (emerytura)
    gap: {},                    // "miasto|rola" → od kiedy przy zestawie brakuje ludzi
    mgrShort: null,             // { n, t } – ile razy zabrakło menedżera do "Zakończ"
    fleetBusy: null,            // { v, t } – odsetek ciężarówek w ruchu (średnia krocząca)
    busyFuel: {},               // ciężarówka → do kiedy tankuje (z kolumny "Czas" na stacji)
    busyRepair: {},             // "truckID"/"trailerID" → do kiedy jest w serwisie (minimum, potem decyduje status z garażu)
    routeRefuel: null,          // { until, t } – tankowanie w trasie: po nim wejście w ładunek i "Kontynuuj"
    tireTask: null,             // { action: 'buy'|'switch', type: 'summer'|'winter', n, worn: [truckId] }
    tireTry: {},                // ciężarówka → kiedy bot próbował wymienić jej zużyte opony
    utilTask: null,             // { key: 'elec'|'water', offerId }
    autoMechanics: true,        // kontrakt z mechanikami: najtańszy pokrywający potrzebę, odnawiany przed końcem (bez premium)
    mechTask: null,             // { offerId, amount, perHour, hours } – kontrakt do przyjęcia
    driverPick: null,           // { n, id, name, lic } – konkretny kierowca do ładunku (najniższe wystarczające uprawnienia)
    mechLearned: 0,             // ilu mechaników okazało się potrzebnych (gra odmówiła naprawy z braku mechaników)
    autoReorg: true,            // porządek floty: przewozy ludzi (taksówka) i pojazdów (Transferio) zamiast zakupów
    autoRenew: true,            // wymiana starej ciężarówki/naczepy na nową, gdy szybko się zwraca (sprzedaż starej)
    moves: {},                  // "emp:ID" / "truck:ID" / "trailer:ID" → przewóz w toku { from, to, t }
    moveTask: null,             // { kind: 'emp'|'truck'|'trailer', id, name, from, to, why } – przewóz do zlecenia
    sellTask: null,             // { kind: 'truck'|'trailer', id, name, why } – sprzedaż dealerowi
    fireTask: null,             // { id, name, why } – zwolnienie (tylko gdy brak miejsca w budynku)
    upgradeTask: null,          // { building: 'garage'|'warehouse', why, levelBefore } – ulepszenie budynku
    spare: {},                  // pracownik → od kiedy jest naprawdę wolny (bez zestawu w swoim mieście)
    repairFor: {},              // "truckID"/"trailerID" → { km, why, t } – naprawa przed dłuższą trasą (kondycja nie wystarcza)
    repClick: {},               // "truckID"/"trailerID" → kiedy bot zlecił naprawę (nauka czasu serwisu)
    repLast: {},                // "truckID"/"trailerID" → ostatnia naprawa (bez ponownej naprawy "pod trasę" przez 30 min)
    work: { b: [] },            // czas pracy bota: [minuta, ms] z ostatnich 2 h (bez patrolu i przerw)
    lastGoT: 0,                 // kiedy bot przeszedł na kolejną stronę (wczytanie strony też jest pracą)
    fastNav: true,              // szybkie przejścia: decyzja planera bez wchodzenia na stronę Magazynu (Magazyn pobrany w tle)
    navStat: null,              // { navMs, fetchMs, saved, full } – ile trwa wejście na stronę, a ile pobranie Magazynu w tle
    lastGameMsg: null,
    log: []                     // dziennik zdarzeń [{ t, msg }]
  };

  // Dane uczone z gry (prognozy kosztów z zakładki "Przegląd finansów" ładunku i timery etapów)
  const LEARN0 = {
    trucks: {}, trailers: {}, driverPerKm: 0.02, workerUnit: 5, managerFee: 50, secPerGameHour: 27,
    phase: { load: 30, unload: 20, finish: 70 }, seen: [], net: {},
    // kondycja: "truckID"/"trailerID" → { r: % na km, n }; odmowy gry przy przydziale { kind, km, cond, t, msg }
    cond: {}, condFail: [], refuelSec: 60, repairSec: 180, botW: null
  };

  let S = { ...DEF }, ST = {}, AP = { ...DEF_AP };
  let obs, timer, syncing = false, syncMsg = '';
  // Stan panelu między stronami: bot co chwilę przechodzi na inną stronę gry, a panel powstaje od nowa – przewinięcie,
  // zwinięcie i otwarte ustawienia pamiętamy w tej karcie (inaczej przy pracy autopilota nie dało się czytać niższych sekcji)
  const UI_KEY = 'ltd3_ui';
  let UI = {};
  try { UI = JSON.parse(sessionStorage.getItem(UI_KEY) || '{}') || {}; } catch (e) { UI = {}; }
  const saveUI = () => { try { sessionStorage.setItem(UI_KEY, JSON.stringify(UI)); } catch (e) {} };
  let restoreTop = null, restoreUntil = 0, panelPos = null;
  let apRunning = false, lastProgress = Date.now(), lastToast = null, lastAlive = 0;
  let panel, body, setEl;

  // Strona liczona za każdym razem – gra potrafi podmienić treść AJAX-em bez przeładowania
  const pageName = () => new URLSearchParams(location.search).get('a') || 'home';
  const urlParam = k => new URLSearchParams(location.search).get(k);

  // Parametry konkretnej podstrony nie mogą "przeciekać" do kolejnych adresów (np. t= z garażu na stację paliw)
  const PAGE_PARAMS = ['n', 'e', 't', 'f', 'p', 'x', 'type', 'returnfr'];

  // Zachowuje serwer (np. /eu1/index.php) oraz parametry globalne (np. lang=en-US)
  function gameUrl(action, extra = {}) {
    const u = new URL(location.href);
    PAGE_PARAMS.forEach(k => u.searchParams.delete(k));
    u.searchParams.set('a', action);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    u.hash = '';
    return u.href;
  }

  // ---------- liczby i formatowanie ----------
  const fmt = n => !Number.isFinite(n) ? '?' : (n < 0 ? '−' : '') + '€' + Math.abs(Math.round(n)).toLocaleString('pl-PL');
  function parseMoney(s) {
    s = String(s == null ? '' : s).replace(/[^\d.,-]/g, '');
    if (!/\d/.test(s)) return NaN;
    const neg = s.startsWith('-'); s = s.replace(/-/g, '');
    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (s.includes('.')) s = s.replace(/\./g, '');
    else s = s.replace(',', '.');
    const v = parseFloat(s);
    return neg ? -v : v;
  }
  const num = s => parseFloat(String(s == null ? '' : s).replace(',', '.'));
  const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = s => String(s || '').toLowerCase().replace(/ł/g, 'l').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const ema = (old, v, a = 0.35) => (old == null || !Number.isFinite(old) ? v : old + (v - old) * a);
  const hms = s => { const m = String(s).match(/(\d+):(\d{2}):(\d{2})/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN; };
  const hoursOf = s => {
    const m = String(s).match(/([\d,.]+)\s*(godz|hour|h\b|minut|min|dzie|dni|day)/i);
    if (!m) return NaN;
    const v = num(m[1]);
    return /minut|min/i.test(m[2]) ? v / 60 : /dzie|dni|day/i.test(m[2]) ? v * 24 : v;
  };
  const fmtDur = sec => {
    if (!Number.isFinite(sec)) return '?';
    if (sec < 90) return Math.max(0, Math.round(sec)) + ' s';
    if (sec < 5400) return Math.round(sec / 60) + ' min';
    if (sec < 172800) return (sec / 3600).toFixed(1).replace('.', ',') + ' h';
    return Math.round(sec / 86400) + ' dni';
  };
  const flagOf = el => {
    const im = el && el.querySelector && el.querySelector('img[src*="flags/small/"]');
    const m = im && im.getAttribute('src').match(/flags\/small\/(\d+)\./);
    return m ? +m[1] : null;
  };

  function jtxt(el) {
    if (!el) return '';
    const out = [], w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (n.parentElement && n.parentElement.closest('.ltd-badge, script, style')) continue;
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out.join(' | ');
  }
  const pct = t => { const m = String(t).match(/(\d+)\s*%/g); return m ? parseInt(m[m.length - 1]) : NaN; };
  const mins = t => t ? Math.max(0, Math.round((Date.now() - t) / 60000)) : null;
  const plural = (n, one, few, many) => (n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many);

  // Odliczanie czasu robi service worker rozszerzenia: Chrome dławi setTimeout w kartach w tle
  // (nawet do 1 wywołania na minutę), przez co bot potrafił "stać". setTimeout zostaje jako zapas.
  const sleep = ms => new Promise(resolve => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    setTimeout(fin, ms + 300);
    try {
      chrome.runtime.sendMessage({ ltd: 'sleep', ms }, r => {
        if (!chrome.runtime.lastError && r && r.ok) fin();
      });
    } catch (e) {}
  });
  async function waitFor(pred, timeout = 6000, step = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (pred()) return true; } catch (e) {}
      await sleep(step);
    }
    return false;
  }
  const later = (ms, fn = autopilotLoop) => { sleep(ms).then(() => { if (AP.enabled) fn(); }); };
  const extAlive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };

  function lines(doc) {
    const root = doc.getElementById('page-content') || doc.body;
    const out = [], w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement;
      if (!p || p.closest('script, style, #ltd-panel, .ltd-badge')) continue;
      const t = n.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
    return out;
  }

  // ---------- Humanizer & Stealth Helpers ----------
  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function gaussianRand(min, max) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    let n = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    n = n / 10.0 + 0.5;
    if (n > 1 || n < 0) return rand(min, max);
    return Math.floor(min + n * (max - min));
  }

  async function humanDelay(mult = 1) {
    const min = (AP.minDelay || 1400) * mult;
    const max = (AP.maxDelay || 3200) * mult;
    await sleep(gaussianRand(min, max));
  }

  async function humanClick(el) {
    if (!el || !el.isConnected) return false;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {}
    await sleep(rand(80, 160));
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * (0.25 + Math.random() * 0.5);
    const y = rect.top + rect.height * (0.25 + Math.random() * 0.5);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    await sleep(rand(30, 70));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    await sleep(rand(30, 60));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    // Jedno kliknięcie – podwójne (zdarzenie 'click' + el.click()) dublowało akcje AJAX
    el.click();
    return true;
  }

  function beepAlarm() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
  }

  // Powiadomienie systemowe (przez service worker), najwyżej raz na 10 min dla tego samego tytułu
  const notified = {};
  function notify(title, msg) {
    if (notified[title] && Date.now() - notified[title] < 10 * 60000) return;
    notified[title] = Date.now();
    try { chrome.runtime.sendMessage({ ltd: 'notify', title, msg }, () => void chrome.runtime.lastError); } catch (e) {}
  }

  function logEvent(msg) {
    AP.log = Array.isArray(AP.log) ? AP.log : [];
    if (AP.log[0] && AP.log[0].msg === msg && Date.now() - AP.log[0].t < 120000) return;
    AP.log.unshift({ t: Date.now(), msg });
    if (AP.log.length > 40) AP.log.length = 40;
  }

  // Zatrzymanie tylko przy prawdziwej blokadzie (captcha / ekran weryfikacji / wylogowanie)
  function checkSafety() {
    const challenge = document.querySelector('iframe[src*="captcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile, #challenge-form, #cf-challenge-running');
    const head = ((document.title || '') + ' ' + (document.body ? document.body.innerText.slice(0, 4000) : '')).toLowerCase();
    const phrase = ['nie jesteś robotem', 'czy jesteś człowiekiem', 'że jesteś człowiekiem', 'verify you are human', 'are you a robot', 'bot detected', 'dostęp zablokowany', 'access denied']
      .find(s => head.includes(s));
    if (challenge || phrase) {
      stopAutopilot(`🚨 WYKRYTO zabezpieczenie (${phrase || 'captcha'})! Sprawdź ekran!`);
      beepAlarm();
      notify('LogiTycoon: autopilot zatrzymany', 'Gra pokazała zabezpieczenie – sprawdź ekran.');
      return false;
    }
    if (!document.getElementById('breadcrumb-money') && pageName() !== 'login' && document.querySelector('form[action*="login"]')) {
      stopAutopilot('🚨 Wylogowano z konta gry!');
      beepAlarm();
      notify('LogiTycoon: wylogowano', 'Zaloguj się ponownie i uruchom autopilota.');
      return false;
    }
    return true;
  }

  // =========================================================================
  // ---------- PARSERY STRON ----------
  // =========================================================================

  // Kafelki "dashboard-stat2" (Tablica, Finanse, Opony): etykieta → wartość
  function dashStats(doc) {
    const out = {};
    for (const d of doc.querySelectorAll('.dashboard-stat2')) {
      const label = txt(d.querySelector('.number small'));
      if (label) out[label] = txt(d.querySelector('.number h3'));
    }
    return out;
  }

  function readTop(doc) {
    const b = parseMoney(txt(doc.getElementById('breadcrumb-money')));
    const c = parseMoney(txt(doc.getElementById('breadcrumb-moneychange')));
    if (Number.isFinite(c)) ST.change = c;
    if (Number.isFinite(b)) ST.balance = b;
  }

  // Bieżący sezon (Tablica, Opony)
  function readSeason(doc) {
    for (const d of doc.querySelectorAll('.dashboard-stat2')) {
      if (!/bieżący sezon|current season/i.test(txt(d.querySelector('.number small')))) continue;
      const key = SEASON_KEY[norm(txt(d.querySelector('.number h3')))];
      if (!key) return;
      if (ST.season && ST.season.key && ST.season.key !== key) logEvent(`🗓 Nowy sezon: ${SEASON_PL[key]}`);
      ST.season = { key, t: Date.now() };
      return;
    }
  }

  // Tablica: poziom, postęp, punkty, konta
  function readHome(doc) {
    const L = lines(doc);
    const before = re => { const i = L.findIndex(l => re.test(l)); return i > 0 ? L[i - 1] : null; };
    const level = parseInt(before(/^(Poziom|Level)$/i));
    if (!Number.isFinite(level)) return;
    ST.company = {
      level,
      progress: pct(before(/^(Postęp|Progress)$/i)),
      points: parseMoney(before(/^(Punkty firmy|Company points)$/i)),
      savings: parseMoney(before(/^(Konto oszczędnościowe|Savings account)$/i)),
      t: Date.now()
    };
  }

  // Licencja Transportowa: gotowe / egzamin dostępny / zablokowane (za niski poziom)
  function readLicenses(doc) {
    const list = {};
    for (const tr of doc.querySelectorAll('table tr')) {
      const t = txt(tr);
      const tier = Object.values(TIERS).find(x => t.includes(x.name));
      if (!tier) continue;
      list[tier.id] = /gotowe|done|completed/i.test(t) ? 'done' : tr.querySelector('button[id^="upgrade-"]:not([disabled])') ? 'exam' : 'locked';
    }
    if (Object.keys(list).length) ST.licenses = { list, t: Date.now() };
  }

  // Etap ładunku z etykiety statusu (Magazyn / strona ładunku)
  const FREIGHT_STATES = [
    ['finish', /roz[łl]adowan|unloaded/i],      // Rozładowany → Zakończ
    ['unload', /przyby|arrived/i],               // Przybył → Rozładuj
    ['drive', /za[łl]adowan|\bloaded/i],          // Załadowane → Jedź!
    ['fuel', /bez paliwa|out of fuel|no fuel/i], // stoi w trasie bez paliwa
    ['load', /przyj[ęe]t|accepted/i]             // Przyjęty → przydział zestawu + Załaduj
  ];
  function freightState(s) {
    for (const [k, re] of FREIGHT_STATES) if (re.test(s)) return k;
    return 'other';
  }

  // Zakładka "Dostępne" = ładunki czekające na ruch gracza. "W trakcie" (timery) bot pomija.
  function readWarehouse(doc) {
    const m = txt(doc.querySelector('.page-title')).match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/);
    if (!m) return [];
    const rows = [...doc.querySelectorAll('#tbody-available tr')]
      .filter(r => /a=freight&n=\d+/.test(r.getAttribute('onclick') || ''))
      .map(r => {
        const n = r.getAttribute('onclick').match(/n=(\d+)/)[1];
        const statusText = txt([...r.querySelectorAll('span.label')].find(s => !s.querySelector('img')));
        const cells = [...r.querySelectorAll('td')].filter(td => td.querySelector('img.imgflagsmall') && !/#|km|->/.test(txt(td)));
        const ft = r.querySelector('img[src*="freighttypes/"]');
        return {
          n, label: (txt(r).match(/#\d+/) || ['#' + n.slice(-3)])[0],
          state: freightState(statusText), statusText,
          from: txt(cells[0]), to: txt(cells[1]), fromC: flagOf(cells[0]), toC: flagOf(cells[1]),
          type: ft ? parseInt((ft.getAttribute('src').match(/freighttypes\/(\d+)/) || [])[1]) || 1 : 1
        };
      });
    // "W trakcie": faza (Ładowanie / Jedzie / Rozładunek / Kończenie), czas do końca (licznik gry) i kto jest jeszcze
    // przy ładunku (ikona ciężarówki/naczepy na niebiesko; przy "Kończeniu" pojazdy są już wolne – zostaje menedżer)
    const timers = pageTimers(doc), now = Date.now();
    const prog = [...doc.querySelectorAll('#tab_1_2 tr[id^="row-"]')].map(r => {
      const n = r.id.slice(4);
      const statusText = cleanStatus(txt(doc.getElementById(`noxs-progress-${n}`) || r.querySelector('span.label')));
      const tm = timers[`ready-noxs${n}`] || timers[`ready-xs${n}`];
      const left = hms(txt(doc.getElementById(`ready-noxs${n}`)));
      const on = k => { const el = doc.getElementById(`${k}icon-noxs-${n}`); return !!(el && /font-blue/.test(el.className)); };
      const cells = [...r.querySelectorAll('td.visible-lg')];
      const ft = r.querySelector('img[src*="freighttypes/"]');
      return {
        n, label: '#' + n.slice(-3), statusText, phase: progPhase(statusText),
        until: tm ? tm.until : Number.isFinite(left) ? now + left * 1000 : null,
        truck: on('truck'), trailer: on('trailer'),
        from: txt(cells[0]), to: txt(cells[1]), fromC: flagOf(cells[0]), toC: flagOf(cells[1]),
        km: parseMoney((txt(r).match(/([\d.]+)\s*km/) || [])[1]),
        type: ft ? parseInt((ft.getAttribute('src').match(/freighttypes\/(\d+)/) || [])[1]) || 1 : 1
      };
    }).filter(p => /^\d+$/.test(p.n));
    // Jazda ładunku, którego ciężarówkę znamy (ze strony ładunku) → koniec jazdy tej ciężarówki
    ST.driveEnd = ST.driveEnd || {};
    for (const p of prog) {
      const fm = ST.fmap && ST.fmap[p.n];
      if (p.phase === 'drive' && p.until && fm && fm.truckId) ST.driveEnd[fm.truckId] = Math.max(ST.driveEnd[fm.truckId] || 0, p.until);
    }
    // Patrol obudzi się na koniec najbliższego etapu
    const left = prog.map(p => p.until).filter(u => u > now)
      .concat([...doc.querySelectorAll('#tab_1_2 tbody tr')].map(r => hms((txt(r).match(/\d{1,2}:\d{2}:\d{2}/) || [])[0]))
        .filter(x => Number.isFinite(x) && x > 0 && x < 6 * 3600).map(x => now + x * 1000));
    ST.warehouse = {
      nextDone: left.length ? Math.min(...left) : null,
      used: +m[1], cap: +m[2], rows, prog,
      noFuel: rows.filter(x => x.state === 'fuel').length,
      inProgress: parseInt(txt(doc.getElementById('tripsinprogressamount'))) || prog.length,
      t: now
    };
    return rows;
  }
  // Faza ładunku w toku z etykiety (rozładunek sprawdzamy przed załadunkiem – oba zawierają "ładun")
  const progPhase = s => /jedzie|jazda|w drodze|driv/i.test(s) ? 'drive' : /roz[łl]ad|unload/i.test(s) ? 'unload'
    : /[łl]adow|za[łl]adun|loading/i.test(s) ? 'load' : /ko[ńn]cz|finish/i.test(s) ? 'finish' : /tankow|refuel/i.test(s) ? 'refuel' : 'other';

  // Liczniki gry ze skryptów strony: new SwitchingTimer(35, "action-truck3093074", 'Jedzie', …), new Timer(63, "ready-noxs84284891", …).
  // Strona pobrana w tle nie wykonuje skryptów, a stan pojazdu w ruchu gra podaje TYLKO w takim liczniku –
  // dlatego status i czas do końca bierzemy wprost z treści skryptu (na żywej stronie: liczone od jej załadowania).
  function pageTimers(doc) {
    const out = {};
    const base = doc === document ? PAGE_T0 : Date.now();
    const code = [...doc.querySelectorAll('script')].map(s => s.textContent).join('\n');
    for (const m of code.matchAll(/new\s+SwitchingTimer\(\s*(\d+)\s*,\s*["']([\w-]+)["']\s*,\s*["']([^"']*)["']/g)) {
      out[m[2]] = { sec: +m[1], label: m[3].trim(), until: base + +m[1] * 1000 };
    }
    for (const m of code.matchAll(/new\s+Timer\(\s*(\d+)\s*,\s*["']([\w-]+)["']/g)) {
      if (!out[m[2]]) out[m[2]] = { sec: +m[1], label: '', until: base + +m[1] * 1000 };
    }
    return out;
  }
  // Etykieta stanu bez licznika dopisanego przez grę ("Jedzie 00:00:34", "Tankowanie...")
  const cleanStatus = s => String(s || '').replace(/^(Akcja|Action):\s*/i, '').replace(/\(?\s*\d{1,2}:\d{2}:\d{2}\s*\)?/g, '').replace(/\.{2,}|…/g, '').trim();

  // Garaż: model ciężarówki i typ naczepy z obrazka (trucks/23.jpg = model 23, trailers/2.jpg = kontener),
  // kraj z flagi, opony z dymka przy nazwie, stan z etykiety albo z licznika gry (jazda, tankowanie, serwis)
  function readGarage(doc) {
    const units = [];
    const timers = pageTimers(doc), now = Date.now();
    for (const condEl of doc.querySelectorAll('[id^="condition-truck"], [id^="condition-trailer"]')) {
      const m = condEl.id.match(/^condition-(truck|trailer)(\d+)$/);
      if (!m) continue;
      const kind = m[1], id = m[2];
      const card = condEl.closest('.mt-action') || condEl.closest('.mt-action-body') || condEl.parentElement;
      const head = card && card.querySelector('.mt-action-row');
      const name = (txt(head).match(/(Ciężarówka|Naczepa|Truck|Trailer)\s+[\d.]+/i) || [txt(head)])[0];
      const img = card && card.querySelector(`img[src*="${kind}s/"]`);
      const imgN = img ? parseInt((img.getAttribute('src').match(/(?:trucks|trailers)\/(\d+)\./) || [])[1]) : NaN;
      const bs = card ? [...card.querySelectorAll('.mt-action-desc b')] : [];
      const ageB = bs.find(b => /\d\s*(lat|years?)/i.test(txt(b)));
      const locB = bs.find(b => b.querySelector('img[src*="flags/small/"], img.imgflagsmall, .caption-helper'));
      const valB = bs.find(b => /€/.test(txt(b)));
      const tipEl = head && head.querySelector('[data-tooltip]');
      const tip = tipEl ? tipEl.getAttribute('data-tooltip') : '';
      // Stan: etykieta na karcie; pojazd w ruchu ma go tylko w liczniku gry (bez elementu na karcie)
      const tm = timers[`action-${kind}${id}`];
      const live = tm && tm.until > now;
      let status = cleanStatus(txt(doc.getElementById(`action-${kind}${id}`)));
      if (live && tm.label && (!status || !isIdleStatus(status))) status = cleanStatus(tm.label);
      units.push({
        kind, id, name, el: condEl,
        model: kind === 'truck' && Number.isFinite(imgN) ? imgN : null,
        type: kind === 'trailer' && Number.isFinite(imgN) ? imgN : null,
        age: ageB ? num(txt(ageB)) : NaN,
        cond: pct(txt(condEl)),
        loc: txt(locB),
        country: flagOf(locB),
        value: valB ? parseMoney(txt(valB)) : NaN,
        status,
        statusUntil: live ? tm.until : null,
        tires: kind === 'truck' ? (/zimow|winter/i.test(tip) ? 'winter' : /letni|summer/i.test(tip) ? 'summer' : null) : undefined
      });
    }
    if (!units.length) return [];
    const trucks = units.filter(u => u.kind === 'truck'), trailers = units.filter(u => u.kind === 'trailer');
    trucks.forEach(t => {
      const same = trailers.filter(x => x.loc && t.loc && x.loc.toLowerCase() === t.loc.toLowerCase());
      t.type = same.length ? Math.max(...same.map(x => x.type || 1)) : null;
    });
    // Liczniki gry → koniec jazdy (paliwo po kursie), koniec tankowania i serwisu (żadnej drugiej obsługi w tym czasie)
    ST.driveEnd = ST.driveEnd || {};
    AP.busyFuel = AP.busyFuel || {};
    AP.busyRepair = AP.busyRepair || {};
    for (const u of units) {
      if (!u.statusUntil) continue;
      if (u.kind === 'truck' && /jedzie|jazda|w drodze|driv/i.test(u.status)) ST.driveEnd[u.id] = Math.max(ST.driveEnd[u.id] || 0, u.statusUntil);
      if (u.kind === 'truck' && /tankow|refuel/i.test(u.status)) {
        AP.busyFuel[u.id] = Math.max(AP.busyFuel[u.id] || 0, u.statusUntil);
        // Stacja w trakcie tankowania pokazuje jeszcze stary stan baku – po końcu tankowania bak jest pełny
        ST.fuelLevels = ST.fuelLevels || {};
        const lv = ST.fuelLevels[u.id];
        const max = (lv && lv.max) || truckSpec(u).tank;
        ST.fuelLevels[u.id] = { cur: max, max, t: u.statusUntil, projected: true };
      }
      if (/konserwac|maintenance/i.test(u.status)) {
        AP.busyRepair[u.kind + u.id] = Math.max(AP.busyRepair[u.kind + u.id] || 0, u.statusUntil);
        // Ile trwa naprawa: od kliknięcia bota do końca licznika serwisu (do decyzji "naprawa przed dłuższą trasą")
        const rc = AP.repClick && AP.repClick[u.kind + u.id];
        if (rc && u.statusUntil - rc > 5000 && u.statusUntil - rc < 3 * 3600000) {
          learn().repairSec = ema(learn().repairSec, (u.statusUntil - rc) / 1000, 0.4);
          delete AP.repClick[u.kind + u.id];
        }
      }
    }
    condTripLearn(units);
    // Kiedy ciężarówka stanęła po kursie: od tej chwili przed kolejną trasą musi przejść przez stację (pełny bak).
    // Gdy znamy prawdziwy koniec jazdy (licznik gry), liczymy od niego – nie od chwili, w której bot to zauważył
    // (inaczej tankowanie zrobione zaraz po kursie wyglądało na "przed kursem" i ciężarówka jechała na stację drugi raz).
    const prev = ST.garage ? Object.fromEntries(ST.garage.trucks.map(t => [t.id, t.status])) : {};
    ST.idleSince = ST.idleSince || {};
    for (const t of trucks) {
      const was = prev[t.id];
      if (isIdleStatus(t.status) && (was == null || (!isIdleStatus(was) && !/tankow|refuel|konserwac|maintenance/i.test(was)))) {
        const de = ST.driveEnd[t.id];
        ST.idleSince[t.id] = de && de <= now && now - de < 15 * 60000 ? de : now;
      }
    }
    const strip = u => { const { el, ...r } = u; return r; };
    ST.garage = { trucks: trucks.map(strip), trailers: trailers.map(strip), t: Date.now() };
    return units;
  }

  // Prawo jazdy kierowcy → najwyższy typ ładunku, który może wieźć
  // (nazwy jak w grze: "Domyślny", "Kontener", "Wywrotka", "Ciekłe" = płyny/cysterna… – nieznana nazwa = 0, wtedy bot
  // nie szkoli i nie wybiera świadomie, więc lista musi pokrywać wszystkie)
  const LIC_TIER = [
    [/ci[ęe][żz]k|heavy/i, 9], [/radioakt|radioact/i, 8], [/chemik|chemic/i, 7], [/niskopod|low.?bed|low.?loader/i, 6],
    [/p[łl]yn|ciek[łl]|cystern|liquid|tanker/i, 5], [/ch[łl]od|reefer|refrig/i, 4], [/wywrot|tipper|dump/i, 3],
    [/kontener|container/i, 2], [/domy[śs]ln|default/i, 1]
  ];
  const unknownLic = new Set();
  const licTier = s => {
    for (const [re, t] of LIC_TIER) if (re.test(s)) return t;
    const k = String(s || '').trim();
    if (k && !unknownLic.has(k)) { unknownLic.add(k); logEvent(`⚠️ Nieznana nazwa uprawnień kierowcy: "${k}" – daj znać, dopiszę ją (do tego czasu bez szkoleń i wyboru tego kierowcy)`); }
    return 0;
  };

  // % przy łóżku = energia (100% = wypoczęty). Rola z nagłówka tabeli: Kierowcy / Pracownicy magazynowi / Menadżerowie.
  function readEmployees(doc) {
    const roleOf = s => /(kierowc|driver)/i.test(s) ? 'driver' : /(magazyn|warehouse|worker)/i.test(s) ? 'worker'
      : /(mened|menad|manager)/i.test(s) ? 'manager' : /(ksi[ęe]gow|account)/i.test(s) ? 'accountant' : null;
    const timers = pageTimers(doc), now = Date.now();
    const rows = [...doc.querySelectorAll('tr[onclick*="employees_select"]')].map(r => {
      const t = jtxt(r), name = txt(r.querySelector('a')) || t.split(' | ')[0];
      const portlet = r.closest('.portlet');
      const role = roleOf(txt(portlet && portlet.querySelector('.caption-subject')))
        || (/(Kierowca|Driver)/i.test(name) ? 'driver' : /(Pracownik|Worker|Employee)/i.test(name) ? 'worker' : /(Mened|Manager)/i.test(name) ? 'manager' : 'other');
      const tds = [...r.querySelectorAll('td')];
      const locTd = tds.find(td => td.querySelector('img.imgflagsmall, .fa-route'));
      const licEl = role === 'driver' ? r.querySelector('span.label') : null;
      const id = ((r.getAttribute('onclick') || '').match(/[?&]e=(\d+)/) || [])[1] || null;
      const tm = id && timers['ready' + id];
      return {
        row: r, name, role, energy: pct(t), id,
        loc: txt(locTd),
        action: cleanStatus(txt(r.querySelector('[id^="employee-"][id$="-action"]'))),
        // do kiedy trwa czynność (sen, jazda…) – z licznika gry
        actionUntil: tm && tm.until > now ? tm.until : null,
        lic: licEl ? licTier(txt(licEl)) : 0,
        // płaca (kierowca za 1000 km, pracownik za akcję) – starsi ludzie bywają dużo tańsi niż nowe oferty
        wage: parseMoney(txt(tds.find(td => /€/.test(txt(td))))) || null,
        // ostatnia kolumna: ładunek, do którego jest przypisany (#708) albo "Brak"
        freight: (txt(tds[tds.length - 1]).match(/#\d+/) || [null])[0]
      };
    });
    if (!rows.length) return [];
    ST.employees = { list: rows.map(({ row, ...r }) => r), t: Date.now() };
    return rows;
  }

  // Strona pracownika: wiek (emerytura w wieku 65 lat, 1 dzień = 1 rok), energia, czas snu
  function readEmployeeDetail(doc, id) {
    if (!id) return;
    const info = {};
    for (const row of doc.querySelectorAll('.row-static.static-info')) {
      const k = txt(row.querySelector('.name')).replace(/:$/, '');
      const v = txt(row.querySelector('.value'));
      if (/^(Wiek|Age)/i.test(k)) info.age = parseInt(v);
      else if (/^(Zmęczenie|Energia|Fatigue|Energy)/i.test(k)) info.energy = pct(v);
      else if (/^(Czas snu|Sleep)/i.test(k)) info.sleepSec = hms(v);
    }
    if (Number.isFinite(info.age)) {
      ST.empInfo = ST.empInfo || {};
      ST.empInfo[id] = { ...info, t: Date.now() };
    }
  }

  // ---------- stacja paliw ----------
  function fuelTabs(doc) {
    return [...doc.querySelectorAll('.nav-tabs a[href*="a=fuelstation"]')].map(a => {
      const f = (a.getAttribute('href').match(/[?&]f=(\d+)/) || [])[1];
      const b = a.querySelector('.badge');
      return { f, count: b ? parseInt(txt(b)) || 0 : 0, active: !!a.closest('li.active'), name: txt(a).replace(/\s*\d+$/, '') };
    }).filter(t => t.f != null);
  }
  // Pasek paliwa: new ProgressBar('fuel1', <min>, <bak>, <stan>) – np. (0, 520, 57) = 57 z 520 L
  function tankLevel(tb) {
    const code = [...tb.querySelectorAll('script')].map(s => s.textContent).join(' ');
    const m = code.match(/ProgressBar\(\s*['"][^'"]*['"]\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?/);
    if (!m || !(+m[2] > 0)) return null;
    const max = +m[2];
    return { cur: Math.min(m[3] != null ? +m[3] : +m[1], max), max };
  }

  function readFuel(doc) {
    const root = doc.getElementById('page-content') || doc.body;
    // Ceny w krajach (flaga = id kraju; ten sam numer jest na trasach i w garażu)
    const list = [], seen = new Set();
    for (const im of root.querySelectorAll('img[src*="flags/small/"]')) {
      if (im.closest('.nav-tabs, tbody, a')) continue;
      const box = im.closest('p, li, div');
      const m = txt(box).match(/^([\p{L} .'-]+?)\s*€\s*(\d+,\d{2,3})/u);
      if (!m) continue;
      const id = +im.getAttribute('src').match(/flags\/small\/(\d+)\./)[1];
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ id, c: m[1].trim(), p: num(m[2]) });
    }
    // Panel cen bieżącej zakładki: publiczna / korporacja (dostępne litry)
    const L = lines(doc);
    const priceBefore = i => {
      for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
        const m = L[k].match(/€\s*(\d+,\d+)\s*\/\s*L/i);
        if (m) return num(m[1]);
      }
      return null;
    };
    let pub = null, corp = null, corpAvail = null, route = null;
    L.forEach((l, i) => {
      // W cenniku: "Na trasie" + cena (tankowanie ciężarówki stojącej bez paliwa w trasie)
      if (/^(Na trasie|On route|On the road)$/i.test(l) && /^€\s*\d+,\d+$/.test(L[i + 1] || '')) route = num(L[i + 1].replace(/[^\d,]/g, ''));
      if (/^(Publiczna cena|Public price)$/i.test(l)) pub = priceBefore(i);
      if (/^(Korporacja|Corporation)$/i.test(l)) {
        const p = priceBefore(i);
        if (p == null) return;
        corp = p;
        const a = L.slice(i + 1, i + 4).join(' ').match(/(Dostępne|Available):\s*([\d.,]+)\s*L/i);
        if (a) corpAvail = parseMoney(a[2]);
      }
    });
    const tabs = fuelTabs(doc), active = tabs.find(t => t.active) || null;
    // Stan baków ciężarówek w bieżącej zakładce
    ST.fuelLevels = ST.fuelLevels || {};
    const rows = [];
    for (const tb of root.querySelectorAll('tbody[id^="truck-"]')) {
      const id = tb.id.replace('truck-', '');
      const lvl = tankLevel(tb);
      // W trakcie tankowania stacja pokazuje jeszcze stary stan – nie nadpisujemy przewidywanego pełnego baku
      if (lvl && !(AP.busyFuel && AP.busyFuel[id] > Date.now())) ST.fuelLevels[id] = { ...lvl, onRoute: !!(active && active.f === '0'), t: Date.now() };
      rows.push({ id, tb, lvl });
    }
    if (list.length || pub != null || corp != null) {
      const f = ST.fuel = { ...(ST.fuel || {}) };
      if (list.length) f.list = list.sort((a, b) => a.p - b.p);
      if (route != null) f.route = route;
      if (corp != null) f.corp = { price: corp, avail: corpAvail, t: Date.now() };
      if (pub != null && active) {
        f.tabPub = { ...(f.tabPub || {}), [active.f]: pub };
        if (active.f === '0') f.route = pub;
      }
      f.t = Date.now();
    }
    return rows;
  }

  // Trasy (rekomendowane, cele podróży, korporacyjne); kraj startu z flagi
  function readTrips(doc) {
    const rows = [...doc.querySelectorAll('tr.selectable-trip')].map(r => {
      const td = r.querySelectorAll('td');
      if (td.length < 5) return null;
      const price = parseMoney(txt(td[1])), km = parseMoney(txt(td[4]));
      if (!(price > 0) || !(km > 0)) return null;
      let type = 1;
      const cls = [...r.classList].find(c => /^type\d+$/.test(c));
      if (cls) type = +cls.slice(4);
      const ft = r.querySelector('img[src*="freighttypes/"]');
      if (ft) { const m = ft.getAttribute('src').match(/freighttypes\/(\d+)\./); if (m) type = +m[1]; }
      const radio = r.querySelector('input[type="radio"]');
      // Korki: kolor ikonki drogi (szara = brak, pomarańczowa = średnie, czerwona = duże)
      const road = r.querySelector('.fa-road');
      const rc = road ? String(road.getAttribute('class') || '') : '';
      const traffic = /font-red|text-danger/.test(rc) ? 2 : /orange|yellow|warning/.test(rc) ? 1 : 0;
      return {
        r, type, id: radio ? radio.value : null, price, km, traffic,
        from: txt(td[2]), to: txt(td[3]), fromC: flagOf(td[2]), toC: flagOf(td[3]),
        corp: !!r.closest('#corptrips'), disabled: !!(radio && radio.disabled)
      };
    }).filter(Boolean);
    const ref = [...doc.querySelectorAll('.caption-helper')].map(e => txt(e).match(/(\d+)\s*minut/i)).find(Boolean);
    if (ref) ST.tripsRefreshAt = Date.now() + (+ref[1]) * 60000;
    ST.trips = { rows: rows.map(({ r, ...x }) => x).slice(0, 80), count: rows.length, t: Date.now() };
    learnTypeRates(rows);
    return rows;
  }

  // Stawki za typ ładunku z listy tras: przychód ≈ a + b·km, osobno dla każdego typu naczepy (zapamiętywane w nauce)
  function learnTypeRates(rows) {
    const lr = learn();
    lr.typeRate = lr.typeRate || {};
    const by = {};
    for (const r of rows) if (r.km > 0 && r.price > 0 && !r.corp && r.type) (by[r.type] = by[r.type] || []).push(r);
    for (const [t, list] of Object.entries(by)) {
      if (list.length < 3) continue;
      const n = list.length, mx = list.reduce((s, r) => s + r.km, 0) / n, my = list.reduce((s, r) => s + r.price, 0) / n;
      const vx = list.reduce((s, r) => s + (r.km - mx) ** 2, 0) / n;
      const b = Math.max(0, vx > 1 ? list.reduce((s, r) => s + (r.km - mx) * (r.price - my), 0) / n / vx : my / mx);
      const a = my - b * mx, p = lr.typeRate[t];
      lr.typeRate[t] = p ? { a: ema(p.a, a, 0.3), b: ema(p.b, b, 0.3), n: Math.min(500, p.n + n), t: Date.now() } : { a, b, n, t: Date.now() };
    }
  }

  // Salon ciężarówek: katalog modeli (bak, km/L, km/h, KM, cena); id modelu = wartość przycisku = numer obrazka
  function readTruckStore(doc) {
    const list = {};
    for (const b of doc.querySelectorAll('button[name="buytruck"][value]')) {
      const card = b.closest('.mt-action');
      if (!card) continue;
      const d = jtxt(card.querySelector('.mt-action-desc') || card);
      const grab = re => { const m = d.match(re); return m ? parseMoney(m[1]) : null; };
      list[+b.value] = {
        id: +b.value,
        tank: grab(/([\d.]+)\s*L\b/),
        kmPerL: (() => { const m = d.match(/(\d+,\d+|\d+)\s*km\/L/i); return m ? num(m[1]) : null; })(),
        speed: grab(/(\d+)\s*km\/h/i),
        hp: grab(/(\d+)\s*\|?\s*KM\b/),
        price: parseMoney(txt(card.querySelector('.mt-action-date'))),
        canBuy: !b.disabled
      };
    }
    if (Object.keys(list).length) ST.models = { list, t: Date.now() };
  }

  // Salon naczep: wymagana moc, punkty, cena (widoczna tylko dla dostępnych typów)
  function readTrailerStore(doc) {
    const list = {};
    for (const im of doc.querySelectorAll('img[src*="trailers/"]')) {
      const type = parseInt((im.getAttribute('src').match(/trailers\/(\d+)\./) || [])[1]);
      const card = im.closest('.mt-action');
      if (!type || !card || list[type]) continue;
      const t = jtxt(card);
      const btn = card.querySelector('button[name="buytrailer"]');
      const price = parseMoney((t.match(/€\s*[\d.]+/) || [''])[0]);
      list[type] = {
        type, price: price > 0 ? price : null,
        hp: parseInt((t.match(/(\d+)\s*\|?\s*KM/) || [])[1]) || null,
        canBuy: !!(btn && btn.value && !btn.disabled)
      };
    }
    if (Object.keys(list).length) ST.trailerShop = { list, t: Date.now() };
  }

  // ---------- strona ładunku: etapy i prognoza kosztów ----------
  // Etapy: [załadunek, jazda, rozładunek, zakończenie] – ✓ albo czas trwania (hh:mm:ss)
  function phasesOf(doc) {
    const box = doc.getElementById('freight-details');
    if (!box) return [];
    const out = [];
    for (const sp of box.querySelectorAll('span[style*="inline-block"]')) {
      const lab = sp.querySelector('.label');
      if (!lab) continue;
      const t = txt(lab);
      out.push({ done: !!lab.querySelector('.fa-check-square'), sec: /\d{1,2}:\d{2}:\d{2}/.test(t) ? hms(t) : null });
    }
    return out;
  }
  // Karta "Trwa do" na stronie ładunku: koniec bieżącego etapu (np. "07 Oct 2026 00:15:27")
  function trwaDo(doc) {
    const card = [...doc.querySelectorAll('#freight-details .stat-card')].find(c => /trwa do|lasts until|until/i.test(txt(c.querySelector('.stat-title'))));
    const v = txt(card && card.querySelector('.stat-value'));
    const t = /\d/.test(v) ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  }

  // Zakładka "Przegląd finansów": wiersz → { unit, qty, total }
  function financeOf(doc) {
    const tab = doc.getElementById('tab_3');
    if (!tab) return null;
    const rows = {};
    for (const tr of tab.querySelectorAll('tbody tr')) {
      const c = [...tr.querySelectorAll('td')].map(txt);
      if (c.length < 2 || !c[0]) continue;
      rows[norm(c[0])] = { unit: c[1] || '', qty: c[2] || '', total: c[3] || '' };
    }
    return rows;
  }
  function readFreight(doc, n) {
    if (!n) return null;
    const root = doc.getElementById('page-content') || doc.body;
    const idIn = (cardId, kind) => {
      const b = doc.querySelector(`#${cardId} [onclick*="garage_${kind}&t="]`);
      const m = b && b.getAttribute('onclick').match(/t=(\d+)/);
      return m ? m[1] : null;
    };
    const info = {
      n,
      state: txt(root.querySelector('.portlet-title .caption-subject')),
      km: parseMoney((txt(doc.getElementById('freight-details')).match(/([\d.]+)\s*km\b/) || [])[1]),
      gross: parseMoney((txt(doc.getElementById('freight-details')).match(/Zysk brutto[^€]*€\s*([\d.]+)/i) || [])[1]),
      truckId: idIn('freight-truck', 'truck'),
      trailerId: idIn('freight-trailer', 'trailer'),
      phases: phasesOf(doc),
      fin: financeOf(doc)
    };
    learnFromFreight(info);
    readFreightTruck(doc, info.truckId);
    info.cond = { truck: cardCond(doc, 'freight-truck', 'truck', info.truckId), trailer: cardCond(doc, 'freight-trailer', 'trailer', info.trailerId) };
    if (info.truckId) {
      ST.fmap = ST.fmap || {};
      ST.fmap[n] = { truckId: info.truckId, trailerId: info.trailerId, t: Date.now() };
      const keys = Object.keys(ST.fmap);
      if (keys.length > 60) keys.sort((a, b) => ST.fmap[a].t - ST.fmap[b].t).slice(0, keys.length - 60).forEach(k => delete ST.fmap[k]);
    }
    const tt = truckTires(doc);
    if (tt && info.truckId) {
      ST.tireCond = ST.tireCond || {};
      const prev = ST.tireCond[info.truckId];
      // Blokada z gry ("opony nie są już wystarczająco dobre") znika dopiero, gdy stan opon wyraźnie wzrośnie (nowy komplet)
      const stillBad = prev && prev.bad && !(tt.cond > (Number.isFinite(prev.cond) ? prev.cond : 0) + 10);
      ST.tireCond[info.truckId] = { ...tt, t: Date.now(), bad: stillBad || undefined, pending: prev && prev.pending };
    }
    return info;
  }

  // Karta ciężarówki na stronie ładunku: paliwo w baku ("576 /600 L") i stan ("Jedzie (00:01:43)") – świeży odczyt bez stacji
  function readFreightTruck(doc, truckId) {
    const card = truckId && doc.getElementById('freight-truck');
    if (!card) return;
    const row = re => [...card.querySelectorAll('.row-static')].find(r => re.test(txt(r.querySelector('.name'))));
    const fuel = row(/^(paliwo|fuel)/i), st = row(/^status/i);
    const fm = fuel && txt(fuel.querySelector('.value')).match(/([\d.]+)\s*\/\s*([\d.]+)\s*L/i);
    // W trakcie tankowania karta pokazuje jeszcze stary stan – zostaje przewidywany pełny bak
    if (fm && !(AP.busyFuel && AP.busyFuel[truckId] > Date.now())) {
      ST.fuelLevels = ST.fuelLevels || {};
      ST.fuelLevels[truckId] = { cur: parseMoney(fm[1]), max: parseMoney(fm[2]), t: Date.now(), src: 'ładunek' };
    }
    const stText = st ? txt(st.querySelector('.value')) : '';
    const left = hms(stText);
    if (/jedzie|jazda|driv/i.test(stText) && Number.isFinite(left)) {
      ST.driveEnd = ST.driveEnd || {};
      ST.driveEnd[truckId] = Math.max(ST.driveEnd[truckId] || 0, Date.now() + left * 1000);
    }
  }

  // Kondycja przydzielonego pojazdu z karty ładunku ("Kondycja: 65 %") – świeższa niż garaż, od razu do garażu
  function cardCond(doc, cardId, kind, id) {
    const card = id && doc.getElementById(cardId);
    if (!card) return null;
    const row = [...card.querySelectorAll('.row-static')].find(r => /^(kondycja|stan|condition)/i.test(txt(r.querySelector('.name'))));
    const c = row ? pct(txt(row.querySelector('.value'))) : NaN;
    if (!Number.isFinite(c)) return null;
    const u = unitById(kind, id);
    if (u) u.cond = c;
    return c;
  }

  // Strona "Informacja" ciężarówki/naczepy (garage_truck / garage_trailer): "Maksymalny dystans" = najdłuższa trasa
  // przy 100% kondycji. Zależy od wieku, nie od kondycji (dwa pojazdy po 15,3 roku: 963 km przy 15% i przy 66%; nowa
  // naczepa: 4.058 km). Do tego kondycja oraz cena i czas konserwacji przy obecnej kondycji.
  function readUnitDetail(doc, kind, id) {
    if (!id || !kind) return;
    const root = doc.getElementById('page-content') || doc.body;
    const val = re => {
      const row = [...root.querySelectorAll('.row-static')].find(r => re.test(txt(r.querySelector('.name'))));
      return row ? txt(row.querySelector('.value')) : '';
    };
    const maxKm = parseMoney((val(/maksymalny dystans|max(imum)? distance/i).match(/([\d.]+)\s*km/i) || [])[1]);
    if (!(maxKm > 0)) return;
    const code = [...root.querySelectorAll('script')].map(s => s.textContent).join(' ');
    const cm = code.match(new RegExp(`ProgressBar\\(\\s*['"]${kind}condition['"]\\s*,\\s*[\\d.]+\\s*,\\s*[\\d.]+\\s*,\\s*([\\d.]+)`));
    const cond = cm ? +cm[1] : NaN;
    const age = num((val(/^wiek|^age/i).match(/\d+(?:,\d+)?/) || [])[0]);
    const repPrice = parseMoney(val(/cena konserwacji|maintenance (price|cost)/i));
    const repSec = hms(val(/czas konserwacji|maintenance time/i));
    ST.unitInfo = ST.unitInfo || {};
    const k = kind + id, p = ST.unitInfo[k], now = Date.now();
    // Spadek limitu z wiekiem (km na dobę realną) – z kolejnych odczytów tego pojazdu
    let slope = p && p.slope;
    if (p && p.maxKm > maxKm && now - p.t > 30 * 60000) slope = ema(slope, (p.maxKm - maxKm) / ((now - p.t) / 86400000), 0.5);
    ST.unitInfo[k] = { maxKm, cond, age, repPrice, repSec: Number.isFinite(repSec) ? repSec : null, slope: slope || null, t: now };
    const u = unitById(kind, id);
    if (u && Number.isFinite(cond)) u.cond = cond;
  }
  // Maksymalny dystans teraz: ostatni odczyt minus starzenie od tamtej chwili (~210 km na dobę, albo zmierzone)
  const AGE_KM_DAY = 210;
  function maxKmOf(u, kind) {
    const i = u && ST.unitInfo && ST.unitInfo[kind + u.id];
    if (!i || !(i.maxKm > 0)) return null;
    return Math.max(0, Math.floor(i.maxKm - (i.slope || AGE_KM_DAY) * (Date.now() - i.t) / 86400000));
  }
  // Czas naprawy przy obecnej kondycji: z odczytu strony pojazdu przeskalowany do ubytku kondycji, inaczej z nauki
  function repairSecOf(u, kind) {
    const i = u && ST.unitInfo && ST.unitInfo[kind + u.id];
    if (i && i.repSec > 0 && i.cond < 100 && Number.isFinite(u.cond)) return i.repSec * Math.max(0, 100 - u.cond) / (100 - i.cond);
    return learn().repairSec || 180;
  }

  // Spadek kondycji na km – osobno dla każdej ciężarówki i naczepy: kondycja przy "Jedź!" (karta ładunku) i pierwszy
  // odczyt garażu po kursie, gdy pojazd już stoi (wzrost = była naprawa → bez próbki)
  function condTripStart(info, sec) {
    if (!info || !(info.km > 0)) return;
    ST.condTrip = ST.condTrip || {};
    for (const kind of ['truck', 'trailer']) {
      const id = info[kind + 'Id'], u = unitById(kind, id);
      const c0 = info.cond && Number.isFinite(info.cond[kind]) ? info.cond[kind] : u && u.cond;
      if (id && Number.isFinite(c0)) ST.condTrip[kind + id] = { c0, km: info.km, t: Date.now(), until: Date.now() + (sec || 120) * 1000 };
    }
  }
  function condTripLearn(units) {
    const ct = ST.condTrip, now = Date.now();
    if (!ct) return;
    const lr = learn();
    lr.cond = lr.cond || {};
    for (const u of units) {
      const k = u.kind + u.id, s = ct[k];
      if (!s) continue;
      if (now - s.t > 3 * 3600000) { delete ct[k]; continue; }
      // po "Zakończ": stoi albo już tankuje przed kolejną trasą (naprawa podnosi kondycję – taka próbka odpada niżej)
      const after = isIdleStatus(u.status) || /tankow|refuel/i.test(u.status || '');
      if (now < s.until + 5000 || !after || !Number.isFinite(u.cond) || !u.loc || /na trasie|on route/i.test(u.loc)) continue;
      delete ct[k];
      if (u.cond > s.c0 + 0.5) continue;
      const r = Math.max(0, s.c0 - u.cond) / s.km;
      if (!(r < 1)) continue;
      const p = lr.cond[k];
      lr.cond[k] = { r: p ? ema(p.r, r, 0.4) : r, n: Math.min(50, ((p && p.n) || 0) + 1), last: +r.toFixed(5), t: now };
      // Sprawdzenie modelu "spadek = 100% / Maksymalny dystans": współczynnik zmierzone / model dla całej floty
      // (≈1 = model trafny). Krótkie trasy pomijamy – kondycja jest w pełnych %, więc przy nich błąd odczytu jest duży.
      const mx = maxKmOf(u, u.kind);
      if (mx > 0 && s.km >= 200) {
        const kS = r / (100 / mx);
        if (kS > 0.2 && kS < 5) {
          lr.condK = ema(lr.condK, kS, 0.3);
          lr.condKn = Math.min(999, (lr.condKn || 0) + 1);
        }
      }
    }
  }

  // Opony założone na ciężarówkę (karta ciężarówki na stronie ładunku): "Opony: 26 %" + dymek rodzaju
  function truckTires(doc) {
    const row = [...doc.querySelectorAll('#freight-truck .row-static')].find(r => /^(opony|tires)/i.test(txt(r.querySelector('.name'))));
    const val = row && row.querySelector('.value');
    const cond = pct(txt(val));
    if (!Number.isFinite(cond)) return null;
    const tipEl = val.querySelector('[data-tooltip]');
    const tip = tipEl ? tipEl.getAttribute('data-tooltip') : '';
    const type = /zimow|winter/i.test(tip) || val.querySelector('.fa-snowflake') ? 'winter' : /letni|summer/i.test(tip) || val.querySelector('.fa-sun') ? 'summer' : null;
    return { cond, type };
  }

  const learn = () => (ST.learn = ST.learn || JSON.parse(JSON.stringify(LEARN0)));
  function addSample(store, id, km, cost) {
    const u = store[id] = store[id] || {};
    u.samples = (u.samples || []).filter(s => !(s.km === km && s.cost === cost)).concat({ km, cost }).slice(-8);
    u.t = Date.now();
  }
  // Koszt zużycia pojazdu na kurs: a + b·km, dopasowany do prognoz gry z ostatnich ładunków
  function wearModel(u) {
    const s = u && u.samples;
    if (!s || !s.length) return null;
    const n = s.length, mx = s.reduce((a, x) => a + x.km, 0) / n, my = s.reduce((a, x) => a + x.cost, 0) / n;
    const vx = s.reduce((a, x) => a + (x.km - mx) ** 2, 0) / n;
    if (n < 3 || vx < (mx * 0.25) ** 2) return { a: 0, b: my / mx };
    const b = Math.max(0, s.reduce((a, x) => a + (x.km - mx) * (x.cost - my), 0) / n / vx);
    return { a: Math.max(0, my - b * mx), b };
  }

  // Korki przyjętego ładunku: zapamiętane przy przyjęciu trasy (km + zysk brutto), przypisane do numeru ładunku
  function freightTraffic(n, km, gross) {
    ST.ftraffic = ST.ftraffic || {};
    if (n in ST.ftraffic) return ST.ftraffic[n];
    const acc = AP.accTrips || [];
    const i = acc.findIndex(a => a.km === km && (!gross || !a.price || Math.abs(a.price - gross) < 2));
    if (i < 0) return null;
    ST.ftraffic[n] = acc[i].traffic || 0;
    acc.splice(i, 1);
    const keys = Object.keys(ST.ftraffic);
    if (keys.length > 60) keys.slice(0, keys.length - 60).forEach(k => delete ST.ftraffic[k]);
    return ST.ftraffic[n];
  }
  // Ile razy dłużej jedzie się w korkach (poziom 1 = średnie, 2 = duże): z pomiarów, a bez nich ostrożnie ×1,25 / ×1,5
  const TRAFFIC0 = { 1: 1.25, 2: 1.5 };
  function trafficMult(level) {
    if (!level) return 1;
    const t = (learn().traffic || {})[level];
    return t && t.n >= 1 ? t.m : TRAFFIC0[level] || 1.5;
  }
  function learnFromFreight({ n, state, km, gross, truckId, trailerId, phases, fin }) {
    const lr = learn();
    const key = n + ':' + norm(state);
    if (phases.length >= 4 && !lr.seen.includes(key)) {
      lr.seen.push(key);
      if (lr.seen.length > 80) lr.seen = lr.seen.slice(-80);
      const [ld, dr, ul, fi] = phases;
      if (ld.sec) lr.phase.load = ema(lr.phase.load, ld.sec);
      if (ul.sec) lr.phase.unload = ema(lr.phase.unload, ul.sec);
      if (fi.sec) lr.phase.finish = ema(lr.phase.finish, fi.sec);
      const t = unitById('truck', truckId);
      const spd = t && truckSpec(t).speed;
      if (dr.sec && km > 0 && spd) {
        // Jazda w korkach trwa dłużej: takie kursy uczą mnożnika korków, a nie tempa gry
        const tf = freightTraffic(n, km, gross), sph = dr.sec / (km / spd);
        if (!tf) lr.secPerGameHour = ema(lr.secPerGameHour, sph);
        else {
          const mult = sph / lr.secPerGameHour, p = (lr.traffic = lr.traffic || {})[tf];
          if (mult > 0.8 && mult < 4) lr.traffic[tf] = { m: p ? ema(p.m, mult, 0.35) : mult, n: Math.min(99, ((p && p.n) || 0) + 1), t: Date.now() };
        }
      }
    }
    if (!fin || !(km > 0)) return;
    const row = (...keys) => { for (const k of keys) { const f = Object.keys(fin).find(x => x.startsWith(k)); if (f) return fin[f]; } return null; };
    const liters = parseMoney((row('paliwo', 'fuel') || {}).qty);
    if (truckId && liters > 0) {
      const u = lr.trucks[truckId] = lr.trucks[truckId] || {};
      u.lPerKm = liters / km;
      u.t = Date.now();
    }
    const cost = r => (r ? Math.abs(parseMoney(r.total)) : NaN);
    const tr = row('ciezarowka', 'truck'), tl = row('naczepa', 'trailer');
    if (truckId && cost(tr) > 0) addSample(lr.trucks, truckId, km, cost(tr));
    if (trailerId && cost(tl) > 0) addSample(lr.trailers, trailerId, km, cost(tl));
    const dpk = parseMoney((row('kierowca', 'driver') || {}).unit);
    if (dpk > 0 && dpk < 1) lr.driverPerKm = dpk;
    const wu = parseMoney((row('pracownik', 'worker', 'warehouse') || {}).unit);
    if (wu > 0 && wu < 500) lr.workerUnit = wu;
    const mg = row('menedzer', 'manager');
    const mu = mg ? Math.abs(parseMoney(mg.total || mg.unit)) : NaN;
    if (mu > 0 && mu < 5000) lr.managerFee = mu;
    const sum = row('laczna', 'total');
    const net = sum ? parseMoney(sum.unit || sum.total) : NaN;
    if (Number.isFinite(net)) {
      lr.net[n] = { net: mu > 0 ? net : net - lr.managerFee, km, truckId, t: Date.now() };
      const keys = Object.keys(lr.net);
      if (keys.length > 60) keys.sort((a, b) => lr.net[a].t - lr.net[b].t).slice(0, keys.length - 60).forEach(k => delete lr.net[k]);
    }
  }

  // Opony: magazyn kompletów (typ, stan) + sezon
  function readTires(doc) {
    const root = doc.getElementById('page-content') || doc.body;
    const stock = [];
    // Wiersz: [ikona ☀/❄] [Zima|Lato] [11 %] [€ 220] [Sprzedaj]
    for (const f of root.querySelectorAll('form[id^="tires"]')) {
      const tr = f.closest('tr');
      if (!tr) continue;
      const c = [...tr.querySelectorAll('td')].map(txt);
      const all = c.join(' ');
      const type = tr.querySelector('.fa-snowflake') || /\bzim|winter/i.test(all) ? 'winter' : tr.querySelector('.fa-sun') || /\blat|summer/i.test(all) ? 'summer' : null;
      if (type) stock.push({ type, cond: pct(all), value: parseMoney(c.find(x => /€/.test(x)) || '') });
    }
    ST.tires = { stock, t: Date.now() };
  }

  // Media: zużycie/pojemność, aktywne umowy (ile godzin zostało), oferty
  function readUtilities(doc) {
    const root = doc.getElementById('page-content') || doc.body;
    const card = cls => {
      const m = txt(root.querySelector(`.utility-card.${cls} .utility-cost`)).match(/([\d,.]+)\s*\/\s*([\d,.]+)/);
      return m ? { used: num(m[1]), cap: num(m[2]) } : null;
    };
    const kind = s => /prąd|prad|electric|power/i.test(s) ? 'elec' : /woda|water/i.test(s) ? 'water' : null;
    const amountOf = c => num(((c.find(x => /kwh|m3/i.test(x)) || '').match(/[\d,.]+/) || [])[0]);
    const active = [];
    for (const sp of root.querySelectorAll('.contractresttime.timeleft')) {
      const tr = sp.closest('tr');
      if (!tr) continue;
      const c = [...tr.querySelectorAll('td')].map(txt);
      const k = kind(c.join(' '));
      if (k) active.push({ type: k, amount: amountOf(c), perHour: parseMoney(c.find(x => /€/.test(x)) || ''), hoursLeft: hoursOf(txt(sp)) });
    }
    const offers = [];
    for (const r of root.querySelectorAll('#contracts input[type="radio"][name="id"]')) {
      const tr = r.closest('tr');
      if (!tr) continue;
      const c = [...tr.querySelectorAll('td')].map(txt);
      const k = kind(c.join(' '));
      if (k) offers.push({ id: r.value, type: k, perHour: parseMoney(c.find(x => /€/.test(x)) || ''), amount: amountOf(c), hours: parseInt(c.find(x => /godzin|hour/i.test(x) && !/€/.test(x)) || '') });
    }
    const elec = card('electricity'), water = card('water');
    if (elec || water || offers.length) ST.util = { elec, water, active, offers, t: Date.now() };
  }

  // Mechanicy (Pracownicy → Mechanika → Kontrakty, a=contracts): to nie pracownicy, tylko kontrakty – ilu jest teraz
  // (suma przyjętych kontraktów), ile kosztują i kiedy wygasają, oraz dostępne oferty (Kontrakt N: €/h, ilu, na ile godzin)
  function readContracts(doc) {
    const root = doc.getElementById('page-content') || doc.body;
    const form = root.querySelector('form#contracts');
    if (!form && !root.querySelector('.contractresttime')) return;
    const amountOf = c => { const s = c.find(x => /mechani/i.test(x) && /\d/.test(x)); return s ? parseInt(s) : NaN; };
    const active = [];
    for (const sp of root.querySelectorAll('.contractresttime.timeleft')) {
      const tr = sp.closest('tr');
      if (!tr) continue;
      const c = [...tr.querySelectorAll('td')].map(txt);
      if (!/mechani/i.test(c.join(' '))) continue;
      active.push({ amount: amountOf(c), perHour: parseMoney(c.find(x => /€/.test(x)) || ''), hoursLeft: hoursOf(txt(sp)) });
    }
    const offers = [];
    for (const r of form ? form.querySelectorAll('input[type="radio"][name="id"]') : []) {
      const tr = r.closest('tr');
      if (!tr) continue;
      const c = [...tr.querySelectorAll('td')].map(txt);
      offers.push({ id: r.value, perHour: parseMoney(c.find(x => /€/.test(x)) || ''), amount: amountOf(c), hours: hoursOf(c[c.length - 1]), disabled: r.disabled });
    }
    ST.mech = { count: active.reduce((s, a) => s + (a.amount || 0), 0), active, offers, t: Date.now() };
  }

  // Finanse: koszty stałe na dzień (ubezpieczenie, amortyzacja, inne)
  function readFinance(doc) {
    const st = dashStats(doc);
    const get = re => { const k = Object.keys(st).find(x => re.test(x)); return k ? Math.abs(parseMoney(st[k])) : null; };
    const fixed = { insurance: get(/ubezpiecz|insur/i), depreciation: get(/amortyz|deprec/i), other: get(/^inny|^other/i), t: Date.now() };
    if (fixed.insurance != null || fixed.depreciation != null) ST.fixed = fixed;
  }

  // Zatrudnianie: formularz, oferty (cena, płaca, limit, wymagany poziom) i lista miast
  // (kierowca: płaca / 1.000 km, magazynier: / akcję, menedżer: / ładunek; menedżer zawsze w siedzibie)
  const HIRE_FORMS = {
    driver: { form: '#truckers', radio: 'idt', city: 'city-trucker', type: 1 },
    worker: { form: '#whemployees', radio: 'idwhe', city: 'city-whe', type: 2 },
    manager: { form: '#managers', radio: 'idmgr', city: null, type: 4 }
  };
  const ROLE_PL = { driver: 'kierowca', worker: 'pracownik magazynu', manager: 'menedżer' };
  function readHire(doc) {
    for (const [role, cfg] of Object.entries(HIRE_FORMS)) {
      const form = doc.querySelector(cfg.form);
      if (!form) continue;
      const offers = [...form.querySelectorAll(`input[type="radio"][name="${cfg.radio}"]`)].map(r => {
        const c = [...r.closest('tr').querySelectorAll('td')].map(txt);
        const money = c.filter(x => /€/.test(x)).map(parseMoney);
        const qty = (c[c.length - 1] || '').match(/(\d+)\s*\/\s*(\d+|∞)/);
        return {
          value: r.value, disabled: r.disabled, price: money[0], wage: money[1],
          used: qty ? +qty[1] : null, limit: qty ? (qty[2] === '∞' ? null : +qty[2]) : null,
          level: role === 'manager' ? parseInt(c[c.length - 2]) : null
        };
      });
      const sel = cfg.city && form.querySelector(`select[name="${cfg.city}"]`);
      const cities = sel ? [...sel.options].map(o => ({ value: o.value, name: o.text.replace(/\(.*?\)/, '').trim(), hq: /\(HQ\)/i.test(o.text) })) : [];
      ST.hire = { ...(ST.hire || {}), [role]: { offers, cities, t: Date.now() } };
      const hq = cities.find(c => c.hq);
      if (hq) ST.hq = hq.name;
    }
  }

  // Budynki: magazyn (ładunki, pracownicy magazynowi) i garaż (pojazdy, kierowcy) – poziom, pojemności, koszt ulepszenia.
  // Tabela: [ikona][opis][niższy poziom][obecny "2 / 4"][wyższy poziom "+ 2" / "− € 20.000"]
  function readProperties(doc) {
    const out = {};
    for (const p of doc.querySelectorAll('.portlet')) {
      const name = norm(txt(p.querySelector('.caption-subject')));
      const key = /magazyn|warehouse/.test(name) ? 'warehouse' : /garaz|garage/.test(name) ? 'garage' : null;
      if (!key || out[key]) continue;
      const b = { level: parseInt((txt(p.querySelector('.caption-helper')).match(/\d+/) || [])[0]) || null, upCost: null };
      const cells = [...p.querySelectorAll('.upgrade-table > div')];
      cells.forEach((cell, i) => {
        if (!cell.classList.contains('cell-desc')) return;
        const desc = norm(txt(cell)), cur = txt(cells[i + 2]), next = txt(cells[i + 3]);
        const m = cur.match(/(\d+)\s*\/\s*(\d+)/);
        if (/pieniadz|money/.test(desc)) { const v = Math.abs(parseMoney(next)); b.upCost = v > 0 ? v : null; return; }
        // Media: ile prądu / wody budynek bierze teraz i o ile więcej po ulepszeniu ("20 kWh", "+ 10 kWh", "0,6 m3")
        const amt = s => num((String(s).match(/[\d]+(?:[.,]\d+)?/) || [])[0]);
        if (/^prad|electric|power/.test(desc)) { b.elec = amt(cur) || 0; b.elecPlus = amt(next) || 0; return; }
        if (/^woda|water/.test(desc)) { b.water = amt(cur) || 0; b.waterPlus = amt(next) || 0; return; }
        if (!m) return;
        const slot = { used: +m[1], cap: +m[2], plus: parseInt((next.match(/\+\s*(\d+)/) || [])[1]) || 0 };
        if (/ladunk|freight/.test(desc)) b.freights = slot;
        else if (/pracownic|worker/.test(desc)) b.workers = slot;
        else if (/ciezarow|naczep|truck|trailer|vehicle/.test(desc)) b.vehicles = slot;
        else if (/kierowc|driver/.test(desc)) b.drivers = slot;
      });
      const up = p.querySelector(`button[onclick^="${key}upgrade"]`);
      b.canUpgrade = !!(up && !up.disabled) && b.upCost > 0;
      b.rented = !!p.querySelector('#cancelrent');
      out[key] = b;
    }
    if (!Object.keys(out).length) return;
    const before = utilDemand();
    ST.props = { ...out, t: Date.now() };
    const after = utilDemand();
    // Budynek ulepszony (przez bota albo ręcznie) – większe zużycie prądu/wody: od razu świeży odczyt mediów
    if (ST.util && after && (!before || after.elec !== before.elec || after.water !== before.water)) ST.util.t = 0;
  }

  // Zapotrzebowanie na media z budynków (magazyn + garaż) – karta mediów bywa odświeżana rzadziej,
  // a po ulepszeniu budynku zużycie rośnie od razu
  function utilDemand() {
    const P = ST.props;
    if (!P) return null;
    const bs = [P.warehouse, P.garage].filter(Boolean);
    if (!bs.some(b => b.elec != null || b.water != null)) return null;
    return { elec: bs.reduce((s, b) => s + (b.elec || 0), 0), water: bs.reduce((s, b) => s + (b.water || 0), 0) };
  }

  function parsePage(doc, page, id) {
    readTop(doc);
    readSeason(doc);
    switch (page) {
      case 'warehouse': return readWarehouse(doc);
      case 'garage': return readGarage(doc);
      case 'employees': return readEmployees(doc);
      case 'employees_select': readEmployeeDetail(doc, id); return [];
      case 'fuelstation': return readFuel(doc);
      case 'trips': return readTrips(doc);
      case 'truckstore': readTruckStore(doc); return [];
      case 'trailerstore': readTrailerStore(doc); return [];
      case 'freight': readFreight(doc, id); return [];
      case 'company_tires': readTires(doc); return [];
      case 'utilities': readUtilities(doc); return [];
      case 'finance': readFinance(doc); return [];
      case 'home': readHome(doc); return [];
      case 'transportlicense': readLicenses(doc); return [];
      case 'employees_hire': readHire(doc); return [];
      case 'properties': readProperties(doc); return [];
      case 'contracts': readContracts(doc); return [];
      case 'garage_truck': readUnitDetail(doc, 'truck', id); return [];
      case 'garage_trailer': readUnitDetail(doc, 'trailer', id); return [];
      default: return [];
    }
  }

  // ---------- synchronizacja w tle ----------
  async function fetchDoc(url, ms = 15000) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { credentials: 'same-origin', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new DOMParser().parseFromString(await r.text(), 'text/html');
    } finally {
      clearTimeout(to);
    }
  }

  async function refreshPage(page, extra = {}, id = null) {
    try {
      parsePage(await fetchDoc(gameUrl(page, extra)), page, id);
      saveState();
      return true;
    } catch (e) {
      console.warn(`[LTD] Nie udało się odświeżyć ${page}:`, e);
      return false;
    }
  }
  const refreshGarage = () => refreshPage('garage');
  const refreshEmployees = () => refreshPage('employees');
  // Świeże dane floty i ludzi – planowanie na starych danych dawało pętle
  async function refreshData(maxAge = 30000) {
    const old = d => !d || !d.t || Date.now() - d.t > maxAge;
    if (old(ST.garage)) await refreshGarage();
    if (old(ST.employees)) await refreshEmployees();
  }
  // Wolniej zmienne dane: najwyżej jedno pobranie na przebieg planera (lekko dla serwera)
  const hiring = () => AP.autoHire || AP.autoNewSets;
  const SLOW = [
    ['utilities', {}, () => ST.util, 15], ['contracts', {}, () => ST.mech, 30], ['company_tires', {}, () => ST.tires, 30], ['home', {}, () => ST.company, 60],
    ['properties', {}, () => ST.props, 30],
    ['finance', {}, () => ST.fixed, 180], ['truckstore', {}, () => ST.models, 360], ['trailerstore', {}, () => ST.trailerShop, 360],
    ['transportlicense', {}, () => ST.licenses, 360],
    ['employees_hire', { type: 1 }, () => ST.hire && ST.hire.driver, 360, hiring],
    ['employees_hire', { type: 2 }, () => ST.hire && ST.hire.worker, 360, hiring],
    ['employees_hire', { type: 4 }, () => ST.hire && ST.hire.manager, 360, () => AP.autoHire]
  ];
  async function refreshSlow() {
    for (const [page, extra, get, maxMin, cond] of SLOW) {
      if (cond && !cond()) continue;
      const d = get();
      if (!d || !d.t || Date.now() - d.t > maxMin * 60000) { await refreshPage(page, extra); return page; }
    }
    const list = (ST.employees && ST.employees.list) || [];
    const stale = list.find(e => e.id && e.role !== 'accountant' && !(ST.empInfo && ST.empInfo[e.id] && Date.now() - ST.empInfo[e.id].t < 12 * 3600000));
    if (stale) { await refreshPage('employees_select', { e: stale.id }, stale.id); return 'employees_select'; }
    // Maksymalny dystans i kondycja każdego pojazdu (strona "Informacja"): nowe od razu, pozostałe co 4 h
    const g = ST.garage, ui = ST.unitInfo || {};
    const units = g ? [...g.trucks.map(u => ['truck', u]), ...g.trailers.map(u => ['trailer', u])] : [];
    const age = ([kind, u]) => { const i = ui[kind + u.id]; return i ? Date.now() - i.t : Infinity; };
    const due = units.filter(x => age(x) > 4 * 3600000 && !isCool('unitinfo:' + x[0] + x[1].id)).sort((a, b) => age(b) - age(a))[0];
    if (due) {
      const [kind, u] = due;
      setCool('unitinfo:' + kind + u.id, 15 * 60);   // strona bez limitu (np. inny układ) – nie pobieraj w kółko
      await refreshPage('garage_' + kind, { t: u.id }, u.id);
      return 'garage_' + kind;
    }
    return null;
  }

  // Pełne odświeżenie wszystkich stron. Gdy bot przejdzie w tym czasie na inną stronę, pobieranie wznawia się od miejsca
  // przerwania (wcześniej zaczynało od nowa na każdej stronie i komunikat "Pobieram…" wisiał bez końca)
  const HIRE_PL = { 1: 'kierowcy', 2: 'magazynierzy', 4: 'menedżerowie' };
  async function syncAll(from = 0) {
    if (syncing) return;
    syncing = true;
    const errs = [];
    const pages = ['home', 'garage', 'employees', 'warehouse', 'fuelstation', 'trips', 'company_tires', 'utilities', 'contracts', 'truckstore', 'trailerstore', 'finance', 'transportlicense', 'properties']
      .map(p => [p, {}]);
    if (hiring()) pages.push(['employees_hire', { type: 1 }], ['employees_hire', { type: 2 }], ['employees_hire', { type: 4 }]);
    for (let i = Math.min(from, pages.length); i < pages.length; i++) {
      const [p, extra] = pages[i];
      ST.syncProg = { i, t: Date.now() };
      syncMsg = `Pobieram dane ${i + 1}/${pages.length}: ${p}${extra.type ? ` (${HIRE_PL[extra.type]})` : ''}…`;
      renderStatus();
      if (!(await refreshPage(p, extra))) errs.push(p + (extra.type ? ` (${HIRE_PL[extra.type]})` : ''));
      await sleep(rand(500, 900));
    }
    ST.synced = Date.now();
    ST.syncProg = null;
    syncMsg = errs.length ? `Nie udało się pobrać: ${errs.join(', ')}` : '';
    // komunikat o błędzie znika po 30 s (dane i tak odświeżają się dalej w tle)
    if (errs.length) setTimeout(() => { if (!syncing) { syncMsg = ''; renderStatus(); } }, 30000);
    syncing = false;
    saveState();
    renderStatus();
    schedule();
  }

  // =========================================================================
  // ---------- EKONOMIA Z DANYCH GRY ----------
  // =========================================================================
  const isIdleStatus = s => /^(akcja:\s*)?(nic|nothing|idle|none)$/i.test(String(s || '').trim());
  const sameCity = (a, b) => !!a && !!b && norm(a) === norm(b);
  const unitById = (kind, id) => {
    const g = ST.garage;
    return id && g ? (kind === 'truck' ? g.trucks : g.trailers).find(u => String(u.id) === String(id)) || null : null;
  };
  const modelOf = t => (t && t.model != null && ST.models && ST.models.list && ST.models.list[t.model]) || null;

  // Spalanie: prognoza z ładunku (najdokładniej) → katalog salonu → zapas 0,8 L/km
  function truckSpec(t) {
    const m = modelOf(t), lr = t && learn().trucks[t.id];
    const lPerKm = (lr && lr.lPerKm) || (m && m.kmPerL ? 1 / m.kmPerL : 0.8);
    return {
      lPerKm, speed: (m && m.speed) || 80, tank: (m && m.tank) || 500, hp: (m && m.hp) || null,
      src: lr && lr.lPerKm ? 'gra' : m ? 'salon' : 'szac.'
    };
  }
  // Zużycie pojazdu na kurs: z prognoz gry albo szacunek z wieku (15-dniowy pojazd ≈ 1 €/km)
  function wearCost(unit, kind, km) {
    const st = unit && learn()[kind === 'truck' ? 'trucks' : 'trailers'][unit.id];
    const wm = wearModel(st);
    if (wm) return { v: wm.a + wm.b * km, src: 'gra' };
    const age = unit && Number.isFinite(unit.age) ? unit.age : 5;
    return { v: (0.02 + 0.066 * age) * km, src: 'szac.' };
  }
  function medianFuel() {
    const l = ST.fuel && ST.fuel.list;
    if (!l || !l.length) return 1.6;
    const p = l.map(x => x.p).sort((a, b) => a - b);
    return p[Math.floor(p.length / 2)];
  }
  // Cena litra w kraju (flaga); paliwo korporacyjne, jeśli tańsze i jest go dość
  function fuelPrice(country) {
    if (S.fuelManual > 0) return S.fuelManual;
    const f = ST.fuel || {};
    const loc = (f.list || []).find(x => x.id === country);
    const base = loc ? loc.p : medianFuel();
    const c = f.corp;
    return c && c.price > 0 && c.price < base && (c.avail == null || c.avail > 400) ? c.price : base;
  }

  // Zysk i czas kursu dla konkretnego zestawu (ciężarówka + naczepa)
  function tripEcon(trip, truck, trailer) {
    const lr = learn(), sp = truckSpec(truck);
    const pL = fuelPrice(trip.fromC != null ? trip.fromC : truck && truck.country);
    const fuelL = trip.km * sp.lPerKm;
    const wear = wearCost(truck, 'truck', trip.km).v + wearCost(trailer, 'trailer', trip.km).v;
    const staff = trip.km * lr.driverPerKm + lr.workerUnit * (AP.sendWorker ? 3 : 2) + lr.managerFee;
    const lvl = truck && ST.fuelLevels && ST.fuelLevels[truck.id];
    const fuelNow = lvl && Date.now() - lvl.t < 30 * 60000 ? Math.max(lvl.cur, AP.autoFuel ? lvl.max : 0) : sp.tank;
    const over = Math.max(0, trip.km - fuelNow / sp.lPerKm);
    const route = (ST.fuel && ST.fuel.route) || pL * 1.4;
    const extra = over * sp.lPerKm * Math.max(0, route - pL);
    const profit = trip.price - fuelL * pL - wear - staff - extra;
    const sec = lr.phase.load + trip.km / sp.speed * lr.secPerGameHour * trafficMult(trip.traffic) + lr.phase.unload + lr.phase.finish + 40 + (over > 0 ? 150 : 0);
    return { profit, sec, perH: profit / sec * 3600, over: over > 0, fuelL, pL };
  }

  // =========================================================================
  // ---------- DŁUGOŚĆ TRASY: wydajność bota, zasięg baku, kondycja pojazdów ----------
  // =========================================================================
  // Bot obsługuje zestawy po kolei: każdy kurs to kilkanaście wejść na strony (zlecenie, przydział, załadunek, "Jedź!",
  // rozładunek, "Zakończ", stacja…). Gdy kursy są krótkie, a zestawów dużo, zestawy stoją i czekają na bota.
  // Mierzymy, ile sekund pracy bota zjada jeden kurs (W), i liczymy najkrótszy cykl, jaki bot jest w stanie utrzymać:
  //   cykl_min = zestawy × W / dostępność      (dostępność = 85% czasu, minus przerwy AFK)
  // Trasa jest oceniana efektywnie: zysk / max(własny czas kursu, cykl_min). Krótka trasa, na którą zestaw i tak czeka
  // na bota, nie daje więcej niż dłuższa – więc przy wielu zestawach bot sam wybiera dłuższe trasy, a przy kilku krótsze
  // (krótsze dają więcej € na godzinę, jeśli ktoś je dogląda – tak mówi też FAQ gry).
  let workFrom = null;
  function workAdd(until = Date.now()) {
    if (workFrom == null) return;
    const ms = Math.min(until - workFrom, 120000);
    workFrom = until;
    if (!(ms > 0)) return;
    const w = AP.work = AP.work && Array.isArray(AP.work.b) ? AP.work : { b: [] };
    const m = Math.floor(until / 60000), last = w.b[w.b.length - 1];
    if (last && last[0] === m) last[1] += ms; else w.b.push([m, ms]);
    while (w.b.length && w.b[0][0] < m - 120) w.b.shift();
  }
  const BOT_AVAIL = 0.85, BOT_W0 = 50;
  function activeSets() {
    const g = ST.garage;
    if (!g) return 0;
    const trucks = g.trucks.filter(t => !heldTruck(t)).length, trailers = g.trailers.length;
    const drv = ((ST.employees && ST.employees.list) || []).filter(e => e.role === 'driver').length;
    return Math.min(trucks, trailers, drv || Infinity);
  }
  function botLoad() {
    const now = Date.now(), nowM = Math.floor(now / 60000), WIN = 60;
    const b = ((AP.work && AP.work.b) || []).filter(x => x[0] > nowM - WIN);
    const busy = b.reduce((s, x) => s + x[1], 0) / 1000;
    const startM = b.length ? b[0][0] : nowM, covered = Math.max(1, nowM - startM + 1);
    const seen = new Set();
    const trips = (ST.hist || []).filter(x => x.t >= startM * 60000).filter(x => !x.n || (seen.has(x.n) ? false : seen.add(x.n))).length;
    const lr = learn();
    let W, src;
    if (covered >= 15 && trips >= 4) {
      W = busy / trips;
      src = `pomiar: ${trips} ${plural(trips, 'kurs', 'kursy', 'kursów')} w ${covered} min`;
      lr.botW = +W.toFixed(1);
    } else if (lr.botW) { W = lr.botW; src = 'ostatni pomiar'; } else { W = BOT_W0; src = 'szacunek (pomiar trwa)'; }
    const brk = AP.stealthMode ? (AP.breakDuration || 180) / ((AP.breakMinInterval || 28) * 60 + (AP.breakDuration || 180)) : 0;
    const avail = BOT_AVAIL * (1 - brk);
    const K = activeSets();
    return { W, K, avail, cycle: K * W / avail, busyPct: Math.min(1, busy / (covered * 60)), src, trips, covered, measured: covered >= 15 && trips >= 4 };
  }
  // Ile kursów kolejnego zestawu bot faktycznie obsłuży: wolny czas bota / czas, którego potrzebuje jeden zestaw
  // (praca na kurs / własny cykl kursu). Bot zajęty do granicy → nowy zestaw daje głównie dłuższe trasy pozostałych,
  // liczone ostrożnie jako 25% zarobku zestawu. Bez pomiaru – bez zmian.
  function botRoomFactor(c) {
    const bl = botLoad();
    if (!bl.measured) return { f: 1, bl };
    const lr = learn();
    const ownSec = lr.phase.load + lr.phase.unload + lr.phase.finish + 40 + (lr.refuelSec || 60)
      + ((c && c.avgKm) || 450) / ((c && c.fleetSpeed) || 80) * lr.secPerGameHour;
    const need = bl.W / ownSec, spare = Math.max(0, bl.avail - bl.busyPct);
    return { f: Math.max(0.25, Math.min(1, spare / need)), bl, need, spare };
  }
  // Ile km trwa trasa o danej długości w sekundach (do pokazania docelowej długości)
  function kmForSec(sec, truck) {
    const lr = learn(), sp = truckSpec(truck);
    const fixed = lr.phase.load + lr.phase.unload + lr.phase.finish + 40 + (lr.refuelSec || 60);
    return Math.max(0, Math.round((sec - fixed) / lr.secPerGameHour * sp.speed));
  }
  // Ocena trasy: efektywne €/h przy obciążeniu bota (cykl = kurs + tankowanie, ale nie krócej niż bot nadąży)
  function tripScore(e, load) {
    const own = e.sec + (learn().refuelSec || 60);
    const cyc = Math.max(own, load ? load.cycle : 0);
    return { cyc, eff: e.profit / cyc * 3600, botBound: !!load && load.cycle > own };
  }

  // Zasięg na pełnym baku (km): pojemność z odczytu stacji/ładunku albo z salonu, spalanie z prognoz gry; 3% zapasu.
  // Dłuższa trasa = tankowanie w trasie po ~€2/L i postój – bot takich nie bierze (sztywny limit).
  function tankRange(t) {
    const sp = truckSpec(t), lv = t && ST.fuelLevels && ST.fuelLevels[t.id];
    const tank = lv && lv.max > 0 && lv.max < 990 ? lv.max : sp.tank;
    // spalanie z prognoz gry jest dokładne (3% zapasu); z katalogu salonu – 8% zapasu
    return Math.floor(tank / sp.lPerKm * (sp.src === 'gra' ? 0.97 : 0.92));
  }
  // Kondycja: kurs zużywa km / Maksymalny dystans × 100% kondycji (pojazd z limitem 963 km traci ~0,1% na km – zgadza się
  // z ceną konserwacji €10 za 1% i prognozą zużycia gry ~€1/km dla 15-letniego pojazdu). Współczynnik k (zmierzone /
  // model, start 1) kalibrują pomiary z kursów. Bez odczytu limitu: własny pomiar pojazdu, potem najgorszy zmierzony
  // tego rodzaju, a bez danych 1% na 100 km. Odmowa gry podnosi dolną granicę (kondycja C nie wystarczyła na K km).
  const COND_RATE0 = 0.01;
  function recentCondFails(kind) {
    const lr = learn(), now = Date.now();
    lr.condFail = (lr.condFail || []).filter(x => now - x.t < 24 * 3600000);
    return lr.condFail.filter(x => x.kind === kind);
  }
  const condK = () => { const k = learn().condK; return Number.isFinite(k) ? Math.min(2, Math.max(0.5, k)) : 1; };
  function condRate(u, kind) {
    const c = learn().cond || {};
    const mx = maxKmOf(u, kind);
    const own = u && c[kind + u.id];
    const known = Object.entries(c).filter(([k, v]) => k.startsWith(kind) && v.n >= 1).map(([, v]) => v.r);
    const base = mx > 0 ? condK() * 100 / mx : own && own.n >= 1 ? own.r : known.length ? Math.max(...known) : COND_RATE0;
    const floor = Math.max(0, ...recentCondFails(kind).map(x => x.km > 0 ? x.cond / x.km : 0));
    return Math.max(base, floor);
  }
  // Ile km pojazd przejedzie: nie więcej niż Maksymalny dystans (wiek) i tyle, żeby zostało S.condReserve % kondycji;
  // dodatkowo poniżej trasy, której gra odmówiła pojazdowi w nie gorszym stanie
  function condRange(u, kind, cond = u && u.cond) {
    if (!u) return Infinity;
    const mx = maxKmOf(u, kind);
    let km = mx > 0 ? mx : Infinity;
    if (Number.isFinite(cond)) {
      const r = condRate(u, kind);
      if (r > 0) km = Math.min(km, Math.floor(Math.max(0, cond - S.condReserve) / r));
      for (const f of recentCondFails(kind)) if (f.cond >= cond - 0.5) km = Math.min(km, f.km - 1);
    }
    return Math.max(0, km);
  }
  // Naprawa przed dłuższą trasą / po odmowie gry (poza zwykłym progiem repairAt)
  function needsRepair(u) {
    if (!u || !Number.isFinite(u.cond)) return false;
    if (u.cond < S.repairAt) return true;
    const rf = AP.repairFor && AP.repairFor[u.kind + u.id];
    return !!rf && Date.now() - rf.t < 30 * 60000 && u.cond < 97;
  }

  function pruneRepairFor() {
    const now = Date.now();
    for (const o of [AP.repairFor, AP.repLast, AP.repClick]) for (const [k, v] of Object.entries(o || {})) if (now - (v.t || v) > 3 * 3600000) delete o[k];
    for (const [k, v] of Object.entries(AP.repairFor || {})) if (now - v.t > 30 * 60000) delete AP.repairFor[k];
  }
  // Limity tras z miasta dla danego typu naczepy: "Losowy" bierze dowolną wolną ciężarówkę i naczepę z miasta, więc
  // liczy się najsłabsza z nich – i bak (ciężarówka), i kondycja (ciężarówka ORAZ naczepa)
  function tripLimits(city, type, truck, trailer) {
    const g = ST.garage;
    const hpNeed = (TIERS[type] || {}).hp || 200;
    const free = (u, kind) => sameCity(u.loc, city) && !/konserwac|maintenance/i.test(u.status || '')
      && (isIdleStatus(u.status) || (kind === 'truck' && inService(u) === 'tankuje'));
    let trucks = g ? g.trucks.filter(t => free(t, 'truck') && !heldTruck(t) && (truckSpec(t).hp == null || truckSpec(t).hp >= hpNeed)) : [];
    let trailers = g ? g.trailers.filter(t => free(t, 'trailer') && (t.type || 1) === type) : [];
    if (!trucks.length && truck) trucks = [truck];
    if (!trailers.length && trailer) trailers = [trailer];
    const fuelKm = trucks.length ? Math.min(...trucks.map(tankRange)) : Infinity;
    let condKm = Infinity, fixedKm = Infinity, ageKm = Infinity, weak = null;
    for (const [kind, list] of [['truck', trucks], ['trailer', trailers]]) {
      for (const u of list) {
        const km = condRange(u, kind);
        if (km < condKm) { condKm = km; weak = { kind, u, km }; }
        fixedKm = Math.min(fixedKm, condRange(u, kind, 100));
        const mx = maxKmOf(u, kind);
        if (mx > 0) ageKm = Math.min(ageKm, mx);
      }
    }
    const units = [...trucks.map(u => ({ kind: 'truck', u })), ...trailers.map(u => ({ kind: 'trailer', u }))];
    return { fuelKm, condKm, fixedKm, ageKm, weak, units };
  }
  // Trasy dla zestawu: opłacalne, w zasięgu baku (sztywno), z oceną efektywną i informacją o kondycji
  function rankTrips(rows, need, truck, trailer, load = botLoad()) {
    const lim = tripLimits(need.city, need.type, truck, trailer);
    const all = rows.filter(x => !x.disabled && x.type === need.type && sameCity(x.from, need.city))
      .map(x => { const e = tripEcon(x, truck, trailer); return { x, e, ...tripScore(e, load), condOk: x.km <= lim.condKm, fixable: x.km <= lim.fixedKm }; })
      .filter(o => o.e.profit > 0);
    const inTank = AP.avoidRouteRefuel ? all.filter(o => o.x.km <= lim.fuelKm) : all;
    inTank.sort((a, b) => b.eff - a.eff);
    return { lim, load, list: inTank, ok: inTank.filter(o => o.condOk), tooLong: all.length - inTank.length };
  }

  // Rzeczywisty zarobek netto z zakończonych ładunków (prognoza gry w chwili "Zakończ")
  function earnings(hours = 3) {
    const seen = new Set();
    const h = (ST.hist || []).filter(x => Date.now() - x.t < hours * 3600000)
      .filter(x => !x.n || (seen.has(x.n) ? false : seen.add(x.n)));
    if (h.length < 3) return null;
    // co najmniej godzina okna – inaczej 2–3 szybkie kursy dawały absurdalne prognozy dzienne
    const span = Math.max((Date.now() - Math.min(...h.map(x => x.t))) / 3600000, 1);
    return { perH: h.reduce((s, x) => s + x.net, 0) / span, kmPerH: h.reduce((s, x) => s + (x.km || 0), 0) / span, fph: h.length / span, n: h.length };
  }
  const fixedPerDay = () => (ST.fixed ? (ST.fixed.insurance || 0) + (ST.fixed.depreciation || 0) + (ST.fixed.other || 0) : null);
  // Bieżące tempo do panelu: zakończone kursy z ostatnich `min` minut podzielone przez długość okna (krótsze tylko,
  // gdy historia kursów jest młodsza niż okno). Plany inwestycji liczą dalej z dłuższego okresu (earnings), żeby jeden
  // słabszy kwadrans nie zmieniał decyzji o zakupach.
  function recentEarnings(min) {
    const now = Date.now(), all = ST.hist || [], win = min * 60000;
    const seen = new Set();
    const h = all.filter(x => now - x.t < win).filter(x => !x.n || (seen.has(x.n) ? false : seen.add(x.n)));
    if (h.length < 2) return null;
    const oldest = Math.min(...all.map(x => x.t));
    const span = Math.min(win, Math.max(now - oldest, win / 3)) / 3600000;
    return { perH: h.reduce((s, x) => s + x.net, 0) / span, kmPerH: h.reduce((s, x) => s + (x.km || 0), 0) / span, fph: h.length / span, n: h.length };
  }
  // Panel: tempo z ostatnich S.earnWinMin minut (domyślnie 30); gdy w tym czasie były mniej niż 2 kursy (np. postój floty) –
  // z ostatnich 3 h, a potem z doby (zamiast "zbieram dane" mimo wielu kursów)
  const shownEarnings = () => {
    const m = Math.max(10, S.earnWinMin || 30);
    const r = recentEarnings(m);
    if (r) return { ...r, label: m % 60 ? `${m} min` : `${m / 60} h` };
    const e = earnings(3);
    if (e) return { ...e, label: '3 h' };
    const d = earnings(24);
    return d ? { ...d, label: '24 h' } : null;
  };

  // =========================================================================
  // ---------- PLAN INWESTYCJI (czas zwrotu z danych gry) ----------
  // =========================================================================
  // Opis wybranego zestawu (co dokładnie bot kupi) i podstawa prognozy (skąd ten zysk na godzinę)
  function setTitle(xp) {
    const staff = [xp.licType && `licencja ${TIERS[xp.licType].name}`, xp.garageUp && `ulepszenie garażu ${fmt(xp.upCost)}`,
      xp.whUp && `ulepszenie magazynu ${fmt(xp.whCost)}`, xp.truckTo && `przewóz do ${xp.truckTo} (są tam wolni ludzie)`, xp.hireDriver && 'kierowca',
      xp.exams && `egzaminy ${fmt(xp.exams)}`, xp.hireWorker && 'pracownik'].filter(Boolean).join(' + ');
    const spec = xp.m ? `model ${xp.model} (${String(xp.m.kmPerL).replace('.', ',')} km/L, ${xp.m.speed} km/h, ${xp.m.hp} KM)` : '';
    const kind = (TYPES[xp.type] || '').toLowerCase();
    return xp.lone
      ? `Ciężarówka do nieużywanej naczepy ${xp.lone.name} (${kind}, ${xp.lone.loc}${xp.transfer ? ' → przewóz do siedziby' : ''}): ${spec}${staff ? ' + ' + staff : ''}`
      : xp.loneTruck
        ? `Naczepa (${kind}) do ${xp.loneTruck.name}, która stoi bez naczepy w ${xp.loneTruck.loc}${staff ? ' + ' + staff : ''}`
        : `Nowy zestaw w siedzibie: ${spec} + ${kind}${staff ? ' + ' + staff : ''}`;
  }
  function setBasis(xp) {
    const c = xp.ctx;
    return `prognoza ~${fmt(xp.rate)}/h: €${c.basePerKm.toFixed(2).replace('.', ',')}/km netto z ${c.n} ${plural(c.n, 'kursu', 'kursów', 'kursów')} × ~${Math.round(c.kmh)} km/h na zestaw`
      + `${xp.m ? `, ${String(xp.m.kmPerL).replace('.', ',')} km/L` : ''}${Math.abs(xp.gainT || 0) > 1 ? `, stawki typu ${xp.gainT > 0 ? '+' : '−'}${fmt(Math.abs(xp.gainT))}/h (${xp.typeSrc})` : ''}`
      + `${xp.wageH > 1 ? `, wyższe stawki nowych ludzi −${fmt(xp.wageH)}/h` : ''}${xp.marginal ? `, nowy zestaw liczony ostrożnie (${Math.round(MARGINAL_SET * 100)}% średniej)` : ''}`
      + `${xp.botF != null && xp.botF < 0.99 ? `, bot zajęty ${Math.round((xp.botBusy || 0) * 100)}% czasu – obsłuży ~${Math.round(xp.botF * 100)}% kursów nowego zestawu` : ''}`
      + `, ubezpieczenie −€17/h · porównano ${xp.alternatives} ${plural(xp.alternatives, 'wariant', 'warianty', 'wariantów')}`;
  }

  const renewTitle = r => `Wymiana: ${r.t.name} (model ${r.t.model ?? '?'}, ${(1 / truckSpec(r.t).lPerKm).toFixed(2).replace('.', ',')} km/L, zużycie ~€${(wearCost(r.t, 'truck', 100).v / 100).toFixed(2).replace('.', ',')}/km, sprzedaż ~${fmt(r.t.value)}) → model ${r.m.id} (${String(r.m.kmPerL).replace('.', ',')} km/L, ${r.m.speed} km/h, ${r.m.hp} KM)`;
  function investPlan() {
    const out = [];
    const g = ST.garage;
    const sets = g ? Math.max(1, g.trucks.length) : 1;
    const er = earnings(6);
    // km na godzinę na zestaw: z historii, a bez niej ostrożnie 600 km/h (czas w grze płynie ~133× szybciej)
    const kmh = er && er.kmPerH > 0 ? er.kmPerH / sets : 600;
    if (g) {
      // Wymiana ciężarówki – ta sama wycena, według której bot ją wykona (sprzedaż starej + nowa + przewóz + postój)
      const rp = renewPlan();
      if (rp && rp.week > 0) out.push({ kind: 'renew', title: renewTitle(rp), cost: rp.cost, h: rp.payH, note: `~${fmt(rp.gain)}/h więcej, po tygodniu +${fmt(rp.week)}` });
      // Wymiana naczepy – ta sama wycena, według której bot ją wykona
      const rt = renewTrailerPlan();
      if (rt && rt.week > 0) out.push({ kind: 'renew', title: renewTrailerTitle(rt), cost: rt.money, h: rt.payH, note: `~${fmt(rt.gain)}/h więcej, po tygodniu +${fmt(rt.week)}` });
    }
    // Kolejny zestaw: ciężarówka do nieużywanej naczepy (ta i tak płaci ubezpieczenie €400/dzień) albo komplet
    const xp = expansionPlan();
    if (xp.total > 0) out.push({ kind: 'set', title: setTitle(xp), cost: xp.total, h: xp.payH, note: setBasis(xp) });
    else if (xp.lone || xp.loneTruck) {
      const u = xp.lone || xp.loneTruck;
      out.push({ kind: 'set', title: `${u.name} (${u.loc}) stoi bez ${xp.lone ? 'ciągnika' : 'naczepy'} – płaci ubezpieczenie`, cost: null, h: null, note: xp.why || '' });
    }
    // Kolejny typ ładunków dla istniejącego zestawu (licencja + egzamin + naczepa)
    const tpl = tierPlan();
    if (tpl && tpl.truck && tpl.total > 0) out.push({
      kind: 'tier', title: `Licencja ${tpl.tier.name} + ${tpl.tier.trailerName.toLowerCase()} dla ${tpl.truck.name}${tpl.exams ? ` + egzamin (${tpl.drv.name})` : ''}`,
      cost: tpl.total, h: Number.isFinite(tpl.payH) ? tpl.payH : null,
      note: (tpl.gainH > 0 ? `stawki ${tpl.src === 'z tras' ? 'z tras' : '(szacunek)'} +${fmt(tpl.gainH)}/h` : 'brak widocznej przewagi w stawkach – nie opłaca się')
        + '; dotychczasowa naczepa zostanie wolna pod kolejny zestaw'
    });
    // Magazyn wynajmowany za €250/dzień – kupno €5.000 (wymaga zakończenia wynajmu, zrób to przy pustym magazynie)
    const wh = ST.props && ST.props.warehouse;
    if (ST.warehouse && (!wh || wh.rented)) out.push({ kind: 'advice', title: 'Kup magazyn zamiast wynajmu (€250/dzień) – dopiero kupiony można ulepszyć (więcej ładunków i pracowników = więcej zestawów)', cost: 5000, h: 20 * 24, note: 'ręcznie, przy pustym magazynie: Budynki → Zakończ wynajem, Sklep → Kup' });
    const lvl = ST.company && ST.company.level;
    if (lvl != null && lvl >= 7 && !(ST.company.savings > 0)) out.push({ kind: 'advice', title: 'Otwórz konto oszczędnościowe (0,5% dziennie) i trzymaj tam nadwyżki', cost: 0, h: null, note: 'Sklep → Konto oszczędnościowe' });
    return out.sort((a, b) => (a.h ?? 1e9) - (b.h ?? 1e9));
  }

  // =========================================================================
  // ---------- REINWESTYCJE (panel): na co bot zbiera, ile brakuje, zysk, zwrot, blokady, dane ----------
  // =========================================================================
  function reinvestState() {
    const floor = investFloor(), money = ST.balance == null ? null : ST.balance - floor;
    const xp = expansionPlan(), lim = maxPayH();
    const c = xp.ctx || setRateCtx();
    const income = c && c.income ? c.income : null;
    const tp = tierPlan(), ls = licenseScoutPlan();
    const goals = [];
    if (xp.total > 0) goals.push({ kind: 'set', title: setTitle(xp), total: xp.total, rate: xp.rate, payH: xp.payH, auto: AP.autoNewSets, basis: setBasis(xp) });
    if (tp && tp.truck && tp.total > 0 && tp.gainH > 0) {
      goals.push({ kind: 'tier', title: `Licencja ${tp.tier.name} + ${tp.tier.trailerName.toLowerCase()} dla ${tp.truck.name}`, total: tp.total, rate: tp.gainH, payH: tp.payH, auto: AP.autoExpandFleet,
        basis: `wyższe stawki ${tp.src === 'z tras' ? 'z tras' : '(szacunek)'}; ciężarówka zaczeka na naczepę; stara naczepa – pod kolejny zestaw` });
    }
    if (ls) goals.push({ kind: 'scout', title: `Licencja firmy: ${ls.tier.name} – rozpoznanie (prawdziwe stawki i ceny nowego typu)`, total: ls.cost, need: ls.need, rate: null, payH: null, auto: AP.autoExpandFleet,
      basis: `tylko przy dużej nadwyżce: zostaje ${fmt(Math.max(25000, ls.reserved))} na rozwój floty` });
    const rp = renewPlan();
    if (rp && rp.week > 0) goals.push({ kind: 'renew', title: renewTitle(rp), total: rp.cost, rate: rp.gain, payH: rp.payH, auto: AP.autoRenew && AP.autoNewSets,
      basis: `oszczędność na paliwie i zużyciu + prędkość; koszt: nowa ${fmt(rp.m.price)} − sprzedaż starej ${fmt(rp.t.value)} + Transferio €600 + ~15 min postoju` });
    const rt = renewTrailerPlan();
    if (rt && rt.week > 0) goals.push({ kind: 'renew', title: renewTrailerTitle(rt), total: rt.money, rate: rt.gain, payH: rt.payH, auto: AP.autoRenew && AP.autoNewSets,
      basis: `zużycie €${rt.wearOld.toFixed(2).replace('.', ',')} → ~€${rt.wearNew.toFixed(2).replace('.', ',')}/km` +
        `${rt.reachOld < 1 ? `, Maksymalny dystans ${rt.mx} km skraca trasy (zestaw wykorzystany w ~${Math.round(rt.reachOld * 100)}%)` : ''}` +
        `${rt.T !== rt.T0 ? `, stawki typu ${(TYPES[rt.T] || '').toLowerCase()}` : ''}; koszt: nowa ${fmt(rt.price)} − sprzedaż starej ${fmt(rt.t.value)}` +
        `${rt.transfer ? ' + Transferio €600' : ''}${rt.licCost ? ` + licencja ${fmt(rt.licCost)}` : ''}${rt.exams ? ` + egzamin ${fmt(rt.exams)}` : ''} + postój` });
    // Cel: pierwsza inwestycja, którą bot zrobi (zwrot w limicie, a z kilku – najszybszy zwrot zestawu przed wymianą,
    // jak w planerze); inaczej rozpoznanie licencji albo najlepsza z pozostałych
    const inLim = goals.filter(g => g.kind !== 'scout' && g.payH <= lim).sort((a, b) => (a.kind === 'renew') - (b.kind === 'renew') || a.payH - b.payH);
    const setG = inLim.find(g => g.kind === 'set'), renG = inLim.find(g => g.kind === 'renew');
    const goal = (setG && renG && renG.payH < setG.payH && !xp.block ? renG : inLim[0]) || goals.find(g => g.kind === 'scout') || goals[0] || null;
    if (goal) {
      goal.missing = money == null ? null : Math.max(0, (goal.need || goal.total) - money);
      goal.etaH = goal.missing > 0 && income ? goal.missing / income : null;
    }
    const blockers = [];
    // Blokada rozbudowy floty – osobna linia tylko wtedy, gdy celem jest coś innego (np. licencja); bez celu powód stoi w treści
    if (!(xp.total > 0) && xp.why && goal) blockers.push(xp.why);
    const age = d => !!(d && d.t);
    const missingData = [['garaż', ST.garage], ['ludzie', ST.employees], ['magazyn', ST.warehouse], ['budynki', ST.props], ['salon ciężarówek', ST.models],
      ['salon naczep', ST.trailerShop], ['oferty pracy', ST.hire && ST.hire.driver], ['licencje', ST.licenses], ['poziom firmy', ST.company]]
      .filter(([, d]) => !age(d)).map(([n]) => n).concat(ST.hq ? [] : ['siedziba firmy (z ofert pracy)']);
    const P = ST.props || {}, gar = P.garage, wh = P.warehouse, g = ST.garage, w = ST.warehouse;
    const bld = [
      gar && gar.vehicles && g ? `garaż ${g.trucks.length + g.trailers.length}/${gar.vehicles.cap} pojazdów${gar.canUpgrade ? ` (ulepszenie ${fmt(gar.upCost)})` : ''}` : null,
      w ? `magazyn ${w.used}/${w.cap} ładunków` : null,
      wh && wh.workers ? `pracownicy magazynu ${wh.workers.used}/${wh.workers.cap}${wh.rented ? ' (wynajem)' : ''}` : null
    ].filter(Boolean).join(' · ');
    const data = (c ? `${c.n} ${plural(c.n, 'kurs', 'kursy', 'kursów')} (48 h) · €${c.basePerKm.toFixed(2).replace('.', ',')}/km netto · ~${Math.round(c.kmh)} km/h na zestaw` : 'brak danych o zarobkach (min. 3 kursy)')
      + (income ? ` · firma zarabia ~${fmt(income)}/h` : '') + (AP.fleetBusy ? ` · flota w ruchu ~${Math.round(AP.fleetBusy.v * 100)}%` : '')
      + ` · zapas ${fmt(floor)} · limit zwrotu ${fmtDur(lim * 3600)}`;
    return { goal, goals, money, floor, income, xp, blockers, missingData, data, bld };
  }

  function reinvestHtml() {
    const r = reinvestState(), g = r.goal, lim = maxPayH();
    let h = `<div class="ltd-sec">Reinwestycje</div>`;
    if (AP.newSet) {
      const s = AP.newSet;
      h += s.replace
        ? `<div class="ltd-item lvl2">🔄 W toku: wymiana ${esc(s.replace.name)} na model ${esc(s.model)} (${esc(s.city || '')}) – <b>${esc(NS_PL[s.step] || s.step)}</b></div>`
        : s.replaceTr
        ? `<div class="ltd-item lvl2">🔄 W toku: wymiana ${esc(s.replaceTr.name)} na nową naczepę (${esc((TYPES[s.type] || '').toLowerCase())}, ${esc(s.city || '')}) – <b>${esc(NS_PL[s.step] || s.step)}</b></div>`
        : `<div class="ltd-item lvl2">🏗 W toku: ${s.model ? 'ciężarówka model ' + esc(s.model) : esc(TYPES[s.type] || 'naczepa')}${s.trailerName ? ' do ' + esc(s.trailerName) : ''} – <b>${esc(NS_PL[s.step] || s.step)}</b></div>`;
    }
    if (AP.investState) h += `<div class="ltd-item lvl2">🎓 W toku: ${esc(AP.investState.targetTierName || '')}${AP.investState.licenseOnly ? ' (rozpoznanie)' : ''} – <b>${esc(AP.investState.step)}</b></div>`;
    if (g) {
      const state = !g.auto ? 'włącz w ⚙, żeby bot zrobił to sam'
        : g.kind !== 'scout' && !(g.payH <= lim) ? `zwrot dłuższy niż limit ${fmtDur(lim * 3600)} – nie kupuję`
        : g.missing > 0 ? `brakuje ${fmt(g.missing)}${g.etaH ? ` – przy obecnym zarobku za ~${fmtDur(g.etaH * 3600)}` : ''}`
        : 'pieniądze są – kupię przy najbliższym przeglądzie floty';
      h += `<div class="ltd-goal"><div class="ltd-goal-t">🎯 ${g.missing > 0 ? 'Zbieram na' : 'Następny zakup'}: <b>${esc(g.title)}</b></div>` +
        `<div>💶 Potrzeba <b>${fmt(g.need || g.total)}</b>${g.need ? ` (koszt ${fmt(g.total)})` : ''} · masz <b>${fmt(r.money)}</b> ponad zapas ${fmt(r.floor)}</div>` +
        `<div class="${g.missing > 0 ? 'ltd-goal-wait' : 'ltd-goal-go'}">${esc(state)}</div>` +
        (g.rate ? `<div>📈 Zysk ~<b>${fmt(g.rate)}/h</b> · zwrot ~<b>${fmtDur(g.payH * 3600)}</b> · po 7 dniach ${g.rate * 168 - g.total >= 0 ? '+' : ''}${fmt(g.rate * 168 - g.total)}</div>` : '') +
        (g.basis ? `<div class="ltd-muted">${esc(g.basis)}</div>` : '') + '</div>';
    } else h += `<div class="ltd-item">${esc(r.xp.why || 'brak inwestycji do zrobienia')}</div>`;
    h += r.blockers.map(b => `<div class="ltd-item lvl3">⛔ ${esc(b)}</div>`).join('');
    h += `<div class="ltd-muted">📊 ${esc(r.data)}</div>`;
    if (r.bld) h += `<div class="ltd-muted">🏢 ${esc(r.bld)}</div>`;
    if (r.missingData.length) h += `<div class="ltd-muted" style="color:#fbbf24;">Brakuje danych: ${esc(r.missingData.join(', '))} – pobiorę w tle (albo ⟳ Dane)</div>`;
    const more = investPlan().filter(x => !g || x.kind !== g.kind).slice(0, 4);
    if (more.length) {
      h += `<div class="ltd-muted" style="margin-top:4px;">Inne możliwości:</div>` + more.map(x =>
        `<div class="ltd-item lvl${x.h != null && x.h <= lim ? 1 : 0}">${esc(x.title)}<br><small>${x.cost != null ? `koszt ${fmt(x.cost)}` : ''}` +
        `${x.h != null ? ` · zwrot ~${fmtDur(x.h * 3600)}` : ''}${x.note ? ` · ${esc(x.note)}` : ''}</small></div>`).join('');
    }
    return h;
  }

  // Strażnik 24/7: co może zatrzymać firmę
  function guardian() {
    const out = [];
    const s = ST.season && ST.season.key;
    if (s) {
      const need = s === 'summer' ? 'summer' : s === 'winter' ? 'winter' : null;
      const g = ST.garage;
      const wrong = need && g ? g.trucks.filter(t => t.tires !== need).length : 0;
      const stock = ST.tires ? ST.tires.stock.filter(x => x.cond >= S.tireMinCond) : null;
      out.push({ lvl: wrong ? 2 : 0, t: `🗓 ${SEASON_PL[s]}${need ? ` – potrzebne opony ${TIRE_PL[need]}` : ' – dowolne opony'}${wrong ? `: ${wrong} ciężarówek ma inne` : ''}${stock ? ` · magazyn: ☀${stock.filter(x => x.type === 'summer').length} ❄${stock.filter(x => x.type === 'winter').length}` : ''}` });
    }
    // Zużyte opony na ciężarówkach (stan z karty ciężarówki na stronie ładunku albo blokada z gry)
    for (const t of (ST.garage && ST.garage.trucks) || []) {
      const tc = ST.tireCond && ST.tireCond[t.id];
      if (!tc || !(tc.bad || tc.cond < S.tireWornAt)) continue;
      const tried = AP.tireTry && AP.tireTry[t.id] > Date.now() - 6 * 3600000;
      out.push({ lvl: tc.bad ? 3 : 2, t: `🛞 ${t.name}: opony ${Number.isFinite(tc.cond) ? tc.cond + '%' : 'zużyte'}${tc.bad ? ' – gra blokuje start' : ''} · ${tried ? 'automat już próbował – załóż nowy komplet ręcznie' : 'bot kupi i założy nowy komplet'}` });
    }
    const u = ST.util;
    if (u) {
      for (const [k, name] of [['elec', 'Prąd'], ['water', 'Woda']]) {
        const c = u[k];
        if (!c) continue;
        const left = Math.min(...u.active.filter(a => a.type === k).map(a => a.hoursLeft).filter(Number.isFinite));
        // zapotrzebowanie: większe z karty mediów i z sumy budynków (po ulepszeniu budynku rośnie od razu)
        const used = Math.max(c.used || 0, (utilDemand() || {})[k] || 0), short = used > c.cap + 1e-9;
        out.push({ lvl: short || left < S.utilHoursAhead ? 3 : 0, t: `${k === 'elec' ? '⚡' : '💧'} ${name}: ${String(+used.toFixed(2)).replace('.', ',')}/${String(c.cap).replace('.', ',')}${short ? ' – NIEDOBÓR, biorę nową umowę' : ''}${Number.isFinite(left) ? ` · umowa jeszcze ${fmtDur(left * 3600)}` : ''}` });
      }
    }
    // Mechanicy (kontrakty): ilu jest, ilu trzeba, koszt i do kiedy; najtańsza oferta na kolejny kontrakt
    const mc = ST.mech;
    if (mc) {
      const need = mechNeed();
      const left = Math.min(...mc.active.map(a => a.hoursLeft).filter(Number.isFinite));
      const cost = mc.active.reduce((s, a) => s + (a.perHour || 0), 0);
      const best = mc.offers.filter(o => o.amount >= need && o.perHour > 0).sort((a, b) => a.perHour - b.perHour)[0];
      out.push({ lvl: mc.count < need ? 3 : left < S.utilHoursAhead ? 2 : 0,
        t: `🔧 Mechanicy: ${mc.count} (potrzeba ${need})` + (mc.active.length ? ` · ${fmt(cost)}/h · kontrakt jeszcze ${fmtDur(left * 3600)}` : ' · brak kontraktu') +
          (AP.autoMechanics && best ? ` · odnowię ${S.utilHoursAhead} h przed końcem (teraz najtaniej: ${best.amount} za ${fmt(best.perHour)}/h)` : '') });
    }
    const list = (ST.employees && ST.employees.list) || [];
    for (const e of list) {
      const inf = ST.empInfo && ST.empInfo[e.id];
      if (!inf) continue;
      const age = inf.age + (Date.now() - inf.t) / 86400000;
      if (age >= 60) out.push({ lvl: age >= 63 ? 3 : 2, t: `👴 ${e.name}: ${Math.floor(age)} lat – emerytura (65) za ~${Math.max(0, Math.ceil(65 - age))} dni, zatrudnij następcę` });
    }
    // Maksymalny dystans maleje z wiekiem – stare pojazdy coraz bardziej skracają trasy
    const ui = ST.unitInfo || {};
    for (const [kind, list] of [['truck', (ST.garage && ST.garage.trucks) || []], ['trailer', (ST.garage && ST.garage.trailers) || []]]) {
      for (const u of list) {
        const mx = maxKmOf(u, kind), i = ui[kind + u.id];
        if (!(mx > 0) || mx >= 1500) continue;
        const sl = (i && i.slope) || AGE_KM_DAY;
        const days = Math.max(0, (mx - 500) / sl);
        out.push({ lvl: mx < 700 ? 3 : 2, t: `⏳ ${u.name}: Maksymalny dystans ${mx} km (wiek ${Number.isFinite(i && i.age) ? String(i.age).replace('.', ',') + ' lat' : '?'}), maleje ~${Math.round(sl)} km/dobę${i && i.slope ? '' : ' (szac.)'}` +
          (mx > 500 ? ` – za ~${fmtDur(days * 86400)} zostanie < 500 km` : ' – nadaje się tylko na krótkie trasy') + `; nowy pojazd ma ~4.000 km` });
      }
    }
    const fx = fixedPerDay();
    if (fx) out.push({ lvl: 0, t: `💸 Koszty stałe: ${fmt(fx)}/dzień (ubezpieczenie ${fmt(ST.fixed.insurance || 0)}, amortyzacja ${fmt(ST.fixed.depreciation || 0)}, inne ${fmt(ST.fixed.other || 0)})` });
    return out;
  }

  // =========================================================================
  // ---------- ZAPIS, ANALIZA STRONY ----------
  // =========================================================================
  function store(obj) {
    try { return chrome.storage.local.set(obj).catch(() => {}); } catch (e) { return Promise.resolve(); }
  }
  let saveT = null;
  const saveState = () => { if (!saveT) saveT = setTimeout(() => { saveT = null; store({ ltd3_state: ST }); }, 800); };
  const saveStateNow = () => { clearTimeout(saveT); saveT = null; return store({ ltd3_state: ST }); };
  // Przy przejściu na inną stronę (także ręcznym) odczytane dane nie mogą przepaść
  window.addEventListener('pagehide', () => { if (saveT) saveStateNow(); });
  const saveSettings = () => store({ ltd3_s: S });
  const saveAP = () => { pruneCool(); return store({ ltd3_ap: AP }); };

  const schedule = () => { clearTimeout(timer); timer = setTimeout(analyze, 700); };
  const pause = () => obs && obs.disconnect();
  const resume = () => obs && obs.observe(document.body, { childList: true, subtree: true, characterData: true });

  function clearBadges() {
    document.querySelectorAll('.ltd-badge').forEach(b => b.remove());
    document.querySelectorAll('.ltd-top, .ltd-ok, .ltd-bad').forEach(e => e.classList.remove('ltd-top', 'ltd-ok', 'ltd-bad'));
  }
  function badge(host, text, cls) {
    if (!host) return;
    const b = document.createElement('span');
    b.className = 'ltd-badge ' + cls;
    b.textContent = text;
    host.appendChild(b);
  }

  // Najlepszy zestaw (stojąca ciężarówka + naczepa danego typu) w mieście startu trasy
  function setFor(city, type) {
    const g = ST.garage;
    if (!g) return null;
    const hp = (TIERS[type] || {}).hp || 200;
    const trailer = g.trailers.find(x => (x.type || 1) === type && sameCity(x.loc, city));
    const truck = g.trucks.filter(t => sameCity(t.loc, city) && (truckSpec(t).hp == null || truckSpec(t).hp >= hp))
      .sort((a, b) => isIdleStatus(b.status) - isIdleStatus(a.status))[0];
    return trailer && truck ? { truck, trailer } : null;
  }

  function analyze() {
    pause();
    clearBadges();
    const page = pageName();
    const items = parsePage(document, page, urlParam('n') || urlParam('e') || urlParam('t')) || [];

    if (page === 'garage') items.forEach(u => {
      if (!u.el) return;
      if (u.cond < S.repairAt) { u.el.classList.add('ltd-bad'); badge(u.el.parentElement, 'napraw!', 'b-bad'); }
      if (u.kind === 'truck') {
        const sp = truckSpec(u);
        badge(u.el.parentElement, `${(1 / sp.lPerKm).toFixed(2).replace('.', ',')} km/L · ${sp.speed} km/h${sp.hp ? ' · ' + sp.hp + ' KM' : ''}`, 'b-ok');
      }
    });
    if (page === 'employees') items.filter(x => x.energy < S.sleepAt).forEach(x => {
      x.row.classList.add('ltd-bad');
      badge(x.row.lastElementChild, 'spać!', 'b-bad');
    });
    if (page === 'trips') {
      // Ta sama ocena co przy wyborze trasy: efektywne €/h przy obciążeniu bota, sztywny limit baku, Maksymalny dystans
      // × kondycja ciężarówki i naczepy, korki
      const bl = botLoad();
      const scored = items.map(f => {
        const set = setFor(f.from, f.type);
        if (!set) return { f, e: null };
        const e = tripEcon(f, set.truck, set.trailer);
        const tank = tankRange(set.truck), veh = Math.min(condRange(set.truck, 'truck'), condRange(set.trailer, 'trailer'));
        return { f, e, eff: tripScore(e, bl).eff, tooFar: AP.avoidRouteRefuel && f.km > tank, tank, weak: f.km > veh, veh };
      });
      const best = Math.max(...scored.filter(x => x.e && x.e.profit > 0 && !x.tooFar && !x.weak).map(x => x.eff), 0);
      scored.forEach(({ f, e, eff, tooFar, tank, weak, veh }) => {
        const host = f.r.lastElementChild;
        if (!e) { badge(host, 'brak zestawu w mieście', 'b-bad'); return; }
        const ok = e.profit > 0 && !tooFar && !weak;
        const cls = !ok ? 'ltd-bad' : eff >= best * 0.9 ? 'ltd-top' : 'ltd-ok';
        f.r.classList.add(cls);
        badge(host, `${cls === 'ltd-top' ? '★ ' : ''}${fmt(e.profit)} · ${fmt(eff)}/h`, 'b-' + cls.slice(4));
        if (f.traffic) badge(host, `🚦 ${f.traffic > 1 ? 'duże' : 'średnie'} korki ×${String(+trafficMult(f.traffic).toFixed(2)).replace('.', ',')}`, 'b-ok');
        if (tooFar) badge(host, `⛽ dłuższa niż bak (~${tank} km)`, 'b-bad');
        else if (weak) badge(host, `🔧 za daleko dla pojazdów (~${veh} km)`, 'b-bad');
      });
    }

    saveState();
    render();
    resume();
  }

  // =========================================================================
  // ---------- SILNIK AUTOPILOTA ----------
  // =========================================================================

  // Cooldown: czego teraz nie da się zrobić, bot pomija przez chwilę i robi resztę (zamiast kręcić się w kółko)
  const isCool = k => !!(AP.cool && AP.cool[k] > Date.now());
  const setCool = (k, sec) => { AP.cool = AP.cool || {}; AP.cool[k] = Date.now() + sec * 1000; };
  function pruneCool() {
    const now = Date.now();
    for (const [k, v] of Object.entries(AP.cool || {})) if (!(v > now)) delete AP.cool[k];
    for (const [k, v] of Object.entries(AP.blocked || {})) if (!v || now - v.t > 30 * 60000) delete AP.blocked[k];
    for (const [k, v] of Object.entries(AP.due || {})) if (!(v > now - 10 * 60000)) delete AP.due[k];
    for (const m of [AP.busyFuel, AP.busyRepair]) for (const [k, v] of Object.entries(m || {})) if (!(v > now)) delete m[k];
  }
  const block = (n, label, why) => { AP.blocked = AP.blocked || {}; AP.blocked[n] = { label, why, t: Date.now() }; };
  const unblock = n => { if (AP.blocked) delete AP.blocked[n]; };

  const btnLabel = b => [b.textContent, b.value, b.title, b.getAttribute('data-original-title')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  // Przyciski premium (💎 / id="Premium") – bez konta premium kończą się tylko komunikatem błędu
  const isPremium = b => b.id === 'Premium' || !!b.querySelector('.fa-gem') || /sleepall|refuelall|autoall/i.test(b.getAttribute('onclick') || '');
  const DANGER = /zwolni|\bfire\b|emerytur|retire|sprzeda|\bsell\b|przenie|transfer|urlop|vacation|obud[źz]|wake|usu[ńn]|delete|anuluj|cancel|zmie[ńn] nazw|rename/i;
  const isDanger = b => DANGER.test(btnLabel(b) + ' ' + (b.getAttribute('onclick') || '') + ' ' + (b.getAttribute('href') || ''));

  // "1 Dostępne" na karcie ładunku = zasób jeszcze nieprzydzielony (liczba = ile wolnych w tym mieście)
  const availIn = el => el ? [...el.textContent.matchAll(/(\d+)\s*(?:dost\S{0,2}pn|available)/gi)].map(m => +m[1]) : [];

  // Ile wolno wydać: paliwo/naprawy/media – do zera (bez nich firma staje); opony – ponad rezerwę; inwestycje – ponad zapas inwestycyjny
  // Opony i inwestycje omijają też pieniądze przeznaczone na ludzi i egzaminy kupionego już zestawu
  function canSpend(amount, kind = 'ops') {
    const bal = ST.balance;
    if (bal == null) return kind === 'ops';
    const floor = kind === 'invest' ? investFloor() : kind === 'tires' ? S.reserve : 0;
    return bal - amount - (kind === 'ops' ? 0 : committed()) >= floor;
  }

  function attempt(n, action) {
    const a = AP.att;
    if (!a || a.n !== n || a.action !== action || Date.now() - a.t > 5 * 60000) AP.att = { n, action, count: 0, t: 0 };
    AP.att.count++;
    AP.att.t = Date.now();
    return AP.att.count;
  }

  function setStatus(status, detail) {
    AP.status = status;
    AP.statusDetail = detail;
    lastProgress = Date.now();
    renderStatus();
  }

  async function go(action, extra = {}) {
    lastProgress = Date.now();
    if (AP.enabled) { workAdd(); AP.lastGoT = Date.now(); }
    await Promise.all([saveAP(), saveStateNow()]);
    location.href = gameUrl(action, extra);
  }

  // Komunikaty gry (toastr) – żeby wiedzieć, czy akcja się udała, zamiast klikać w ciemno
  function watchToasts() {
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const nd of m.addedNodes) {
          if (nd.nodeType !== 1 || (panel && panel.contains(nd))) continue;
          const box = nd.matches('.toast') ? nd : (nd.querySelector('.toast') || (nd.matches('[class*="toast"]') ? nd : nd.querySelector('[class*="toast"]')));
          if (!box) continue;
          const msg = txt(box);
          if (!msg || msg.length > 400) continue;
          const c = String(box.className || '');
          lastToast = { type: /error|danger|warning/i.test(c) ? 'error' : /success/i.test(c) ? 'success' : 'info', msg, t: Date.now() };
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Kliknij i poczekaj, aż gra przetworzy akcję (AJAX), zamiast od razu uciekać na inną stronę
  async function act(el, { timeout = 7000, until = null, reenable = false } = {}) {
    const t0 = Date.now();
    lastProgress = t0;
    const st = document.getElementById('status');
    const before = st ? st.innerHTML : null;
    await humanClick(el);
    if (reenable) {
      await waitFor(() => el.disabled || !el.isConnected, 1500, 100);
      await waitFor(() => !el.disabled || !el.isConnected, timeout);
    } else {
      await waitFor(() => !el.isConnected || (until && until()) || (st && st.isConnected && st.innerHTML !== before)
        || (lastToast && lastToast.t >= t0), timeout);
    }
    await sleep(rand(300, 600));
    lastProgress = Date.now();
    let toast = lastToast && lastToast.t >= t0 ? lastToast : null;
    // Odpowiedź AJAX trafia do #status jako skrypt localStorage.setItem("Error", "…") + toastr – gdyby dymek nie
    // został złapany, czerwony komunikat bierzemy wprost z tej odpowiedzi
    if (!toast && st && st.isConnected && st.innerHTML !== before) {
      const m = st.innerHTML.match(/setItem\(\s*["']Error["']\s*,\s*["']([^"']{3,300})["']/);
      if (m) toast = { type: 'error', msg: m[1], t: Date.now() };
    }
    if (toast) AP.lastGameMsg = toast;
    const bad = toast && toast.type !== 'success'
      && (toast.type === 'error' || /premium|nie mo[żz]|brak|b[łl][ąa]d|error|niewystarcz|za ma[łl]o|0 dost/i.test(toast.msg));
    return { toast, error: bad ? toast.msg : null };
  }

  function dumpButtons(where) {
    const root = document.getElementById('page-content') || document.body;
    console.warn(`[LTD] ${where}: nie znalazłem właściwego przycisku. Przyciski na stronie:`,
      [...root.querySelectorAll('button, a.btn, input[type=button], input[type=submit]')]
        .map(b => `${btnLabel(b)} :: ${b.getAttribute('onclick') || b.getAttribute('href') || ''}`));
  }

  function startAutopilot() {
    if (!checkSafety()) return;
    Object.assign(AP, {
      enabled: true, breakUntil: 0, nextPatrolTime: 0, cool: {}, blocked: {}, att: null, due: {},
      fuelRound: null, tripPlan: null, sleepTarget: null, manualSel: null, losowyPremium: false, tireTask: null, utilTask: null, hireTask: null,
      // zadania porządku floty sprzed zatrzymania nie wykonują się same po starcie (wymianę wznowi jej plan)
      moveTask: null, fireTask: null, upgradeTask: null, sellTask: null, mechTask: null, driverPick: null,
      lastBreakTime: Date.now()   // bez tego start po dłuższej przerwie od razu wpadał w przerwę AFK
    });
    AP.status = 'Uruchamianie';
    AP.statusDetail = 'Inicjalizacja pętli bota...';
    workFrom = Date.now();
    if (!AP.stats.startTime) AP.stats.startTime = Date.now();
    logEvent('▶ Autopilot uruchomiony');
    saveAP();
    render();
    lastProgress = Date.now();
    later(rand(300, 600));
  }

  function stopAutopilot(reason = 'Zatrzymany przez użytkownika') {
    workAdd();
    workFrom = null;
    AP.enabled = false;
    lastAlive = 0;   // od razu powiedz strażnikowi karty, że ma przestać pilnować
    AP.breakUntil = 0;
    AP.nextPatrolTime = 0;
    AP.status = 'Zatrzymany';
    AP.statusDetail = reason;
    apRunning = false;
    logEvent('⏹ ' + reason);
    saveAP();
    render();
  }

  let navMeasured = false;
  async function autopilotLoop() {
    if (!AP.enabled || apRunning || !extAlive()) return;
    apRunning = true;
    lastProgress = Date.now();
    // Ile trwa przejście na stronę: od kliknięcia/przejścia do startu pracy bota na nowej stronie
    if (!navMeasured) {
      navMeasured = true;
      if (AP.lastGoT && PAGE_T0 - AP.lastGoT < 30000) {
        navStat('navMs', Date.now() - AP.lastGoT);
        if (pageName() === 'warehouse') AP.navStat.full = (AP.navStat.full || 0) + 1;
      }
    }

    try {
      if (!checkSafety()) return;

      // 1. Aktywna przerwa AFK (odliczanie pokazuje heartbeat)
      if (AP.breakUntil && Date.now() < AP.breakUntil) {
        AP.status = '☕ Przerwa AFK (Anty-Ban)';
        renderStatus();
        later(4000);
        return;
      } else if (AP.breakUntil) {
        AP.breakUntil = 0;
        AP.lastBreakTime = Date.now();
        workFrom = Date.now();
        setStatus('Wznowienie pracy', 'Koniec przerwy. Wracam do wykonywania zadań...');
        saveAP();
        await humanDelay(1.2);
      }

      // 2. Nowa przerwa AFK w trybie Stealth
      if (AP.stealthMode) {
        const lastRef = AP.lastBreakTime || AP.stats.startTime || Date.now();
        if ((Date.now() - lastRef) / 60000 >= (AP.breakMinInterval || 28)) {
          const breakSec = rand((AP.breakDuration || 180) * 0.8, (AP.breakDuration || 180) * 1.2);
          AP.breakUntil = Date.now() + breakSec * 1000;
          AP.lastBreakTime = Date.now();
          workAdd();
          workFrom = null;
          setStatus('☕ Rozpoczynam przerwę AFK', `Odpoczynek na ${Math.round(breakSec)}s...`);
          saveAP();
          later(5000);
          return;
        }
      }

      // 3. Maszyna stanów w zależności od bieżącej strony
      const p = pageName();
      if (p === 'warehouse') await apHandleWarehouse();
      else if (p === 'freight') await apHandleFreight();
      else if (p === 'trips') await apHandleTrips();
      else if (p === 'fuelstation') await apHandleFuelstation();
      else if (p === 'garage') await apHandleGarage();
      else if (p === 'employees') await apHandleEmployees();
      else if (p === 'employees_select') await apHandleEmployeeSelect();
      else if (p === 'shopcompany') await apHandleShop();
      else if (p === 'utilities') await apHandleUtilities();
      else if (p === 'contracts') await apHandleContracts();
      else if (p === 'employees_hire') await apHandleHire();
      else if (p === 'truckstore') await apHandleTruckStore();
      else if (p === 'employees_upgrade') await apHandleDriverUpgrade();
      else if (p === 'transportlicense') await apHandleTransportLicense();
      else if (p === 'trailerstore') await apHandleTrailerStore();
      else if (p === 'garage_trailer') await apHandleGarageTrailer();
      else if (p === 'garage_truck_wtires') await apHandleTruckTires();
      else if (p === 'properties') await apHandleProperties();
      else if (p === 'garage_truck') await apHandleGarageTruck();
      else if (p === 'employees_transfer') await apHandleEmployeeTransfer();
      else if (p === 'truck_transfer') await apHandleTruckTransfer();
      else if (document.querySelector('select[name="city"]') && document.querySelector('button[name="transfer"]')) await apHandleTrailerTransfer();
      else if (p === 'freight_trucker') await apHandleTruckerSelect();
      else if (p === 'freight_truck' || p === 'freight_trailer' || p === 'freight_whemployee') await apHandleFreightSelect(p);
      else {
        setStatus('Nawigacja', 'Przechodzę do Magazynu...');
        await humanDelay(1.2);
        await go('warehouse');
      }
    } catch (err) {
      console.error('[Autopilot Error]', err);
      setStatus('Błąd wykonania', 'Nastąpił błąd: ' + ((err && err.message) || err) + ' – wznawiam od Magazynu za 5 s...');
      later(5000, () => go('warehouse'));
    } finally {
      apRunning = false;
    }
  }

  // --- Planowanie: kto ma iść spać, co naprawić, kiedy tankować, ile zleceń potrzeba ---
  // Przypisanego do ładunku (np. pracownik, który ma go rozładować) usypiamy tylko w ostateczności – inaczej ładunek stoi
  function pickTired() {
    const list = (ST.employees && ST.employees.list) || [];
    const now = Date.now();
    // Sen "przy okazji": ciężarówka w tym mieście i tak stoi (tankowanie, serwis) – zmęczony człowiek (< 70%) śpi teraz,
    // jeśli zdąży się wyspać w tym czasie (czas snu z gry ≈ 2,5 s na każdy brakujący %), zamiast blokować zestaw później
    const sleepSec = e => { const inf = ST.empInfo && ST.empInfo[e.id]; return inf && inf.sleepSec > 0 && inf.energy < 100 ? inf.sleepSec / (100 - inf.energy) * (100 - e.energy) : (100 - e.energy) * 2.5; };
    const trucks = (ST.garage && ST.garage.trucks) || [];
    const standsFor = city => Math.max(0, ...trucks.filter(t => sameCity(t.loc, city))
      .map(t => truckState(t)).filter(x => x.state === 'refuel' || x.state === 'service').map(x => (x.until || 0) - now));
    // Nie usypiamy nikogo, kogo w tym mieście potrzebuje zestaw gotowy do drogi albo przyjęty ładunek
    const neededIn = city => trucks.some(t => sameCity(t.loc, city) && truckState(t).state === 'idle' && fuelOk(t))
      || ((ST.warehouse && ST.warehouse.rows) || []).some(r => r.state === 'load' && sameCity(r.from, city));
    const byTheWay = e => !e.freight && e.role !== 'manager' && e.loc && !neededIn(e.loc)
      && ((e.energy < 55 && standsFor(e.loc) > 30000) || (e.energy < 70 && sleepSec(e) * 1000 <= standsFor(e.loc) + 30000));
    return list
      .filter(e => ['driver', 'worker', 'manager'].includes(e.role) && e.id && Number.isFinite(e.energy)
        && isIdleStatus(e.action) && !isCool('sleep:' + e.id)
        && (e.energy < (e.freight ? Math.min(S.sleepAt, 10) : S.sleepAt) || byTheWay(e)))
      .sort((a, b) => a.energy - b.energy)[0] || null;
  }

  // Tylko pojazdy, które stoją – naprawa w trasie się nie uda, a bot kręcił się Magazyn ↔ Garaż
  function pickDamaged() {
    const g = ST.garage;
    if (!g) return null;
    return [...g.trucks, ...g.trailers].find(u => needsRepair(u)
      && isIdleStatus(u.status) && !inService(u, u.kind) && !isCool('rep:' + u.kind + u.id)) || null;
  }

  // Pojazd w obsłudze (tankuje albo jest w serwisie) – nie dostaje zlecenia ani drugiej obsługi naraz.
  // Dane z garażu odświeżają się co ~30 s, więc pamiętamy własne kliknięcia, żeby nie było nakładania.
  function inService(u, kind = 'truck') {
    if (!u) return false;
    const now = Date.now();
    if (kind === 'truck' && AP.busyFuel && AP.busyFuel[u.id] > now) return 'tankuje';
    if (AP.busyRepair && AP.busyRepair[kind + u.id] > now) return 'w serwisie';
    if (/konserwac|maintenance/i.test(u.status || '')) return 'w serwisie';
    if (/tankow|refuel/i.test(u.status || '')) return 'tankuje';
    return false;
  }

  // Zasada pełnego baku: ciężarówka, która stanęła po kursie, musi przejść przez stację (zatankowana albo pełna),
  // zanim dostanie kolejne zlecenie – inaczej staje w trasie i tankuje po €2/L zamiast po cenie lokalnej / korpo
  // Koniec ostatniego kursu: prawdziwy koniec jazdy z licznika gry (albo z naszego "Jedź!"), a gdy go nie znamy –
  // chwila, w której garaż pokazał postój. Odczyt baku po tym momencie = stan po kursie.
  function lastTripEnd(t) {
    const de = ST.driveEnd && ST.driveEnd[t.id], idle = (ST.idleSince && ST.idleSince[t.id]) || 0;
    return de && de <= Date.now() && idle - de < 10 * 60000 ? de : idle;
  }
  function fuelOk(t) {
    if (!AP.autoFuel || !t) return true;
    const busy = AP.busyFuel && AP.busyFuel[t.id];
    if (busy && busy > Date.now()) return false;             // jeszcze tankuje
    const lv = ST.fuelLevels && ST.fuelLevels[t.id];
    if (!lv || lv.t < lastTripEnd(t)) return false;           // bak nie sprawdzony po ostatnim kursie
    if (lv.failed && Date.now() - lv.t < 15 * 60000) return true;   // tankowanie się nie udało (np. brak pieniędzy) – nie blokuj floty
    return lv.cur >= lv.max * 0.9;
  }

  // Opony na ciężarówce: gra zablokowała start (bad) albo odczyt ze strony ładunku jest poniżej progu.
  // Po próbie wymiany (pending) czekamy na świeży odczyt, zamiast powtarzać wymianę w kółko.
  function tireInfo(t) {
    const tc = t && ST.tireCond && ST.tireCond[t.id];
    return tc && !(tc.pending && tc.t < tc.pending) ? tc : null;
  }
  const tiresBad = t => !!(tireInfo(t) && tireInfo(t).bad);
  const tiresWorn = t => { const tc = tireInfo(t); return !!tc && (!!tc.bad || tc.cond < S.tireWornAt); };
  function markTiresWorn(id) {
    if (!id) return;
    ST.tireCond = ST.tireCond || {};
    ST.tireCond[id] = { cond: NaN, type: null, ...(ST.tireCond[id] || {}), bad: true, t: Date.now() };
    saveState();
  }

  // Tankowanie i serwis z licznikiem gry kończą się same – po czasie pojazd jest wolny, choć garaż (odświeżany co ~30 s)
  // jeszcze tego nie pokazał. Jazda NIE: po niej ciężarówka czeka przy ładunku na rozładunek.
  function expireStatuses() {
    const g = ST.garage, now = Date.now();
    for (const u of g ? [...g.trucks, ...g.trailers] : []) {
      if (u.statusUntil && u.statusUntil <= now && /tankow|refuel|konserwac|maintenance/i.test(u.status || '')) {
        u.status = 'Nic';
        u.statusUntil = null;
      }
    }
    // Sen też kończy się sam: po liczniku gry człowiek jest wolny i wypoczęty
    for (const e of (ST.employees && ST.employees.list) || []) {
      if (e.actionUntil && e.actionUntil <= now && /śpi|spi|sleep/i.test(e.action || '')) {
        e.action = 'Nic';
        e.actionUntil = null;
        e.energy = 100;
      }
    }
  }

  // Tankowanie skończy się w ciągu 3 min (a ciężarówka nie jest w serwisie) – można już dla niej przyjąć zlecenie
  function refuelEndsSoon(t) {
    const now = Date.now();
    const u = Math.max((AP.busyFuel && AP.busyFuel[t.id]) || 0, /tankow|refuel/i.test(t.status || '') ? t.statusUntil || 0 : 0);
    return u > now && u - now < 3 * 60000 && !(AP.busyRepair && AP.busyRepair['truck' + t.id] > now) && !/konserwac|maintenance/i.test(t.status || '');
  }

  // Ciężarówka czeka na naczepę nowego typu (Auto-rozwój): bez nowych zleceń, dopóki naczepa nie dojedzie
  function heldTruck(t) {
    const inv = AP.investState;
    if (inv && inv.truckId && String(inv.truckId) === String(t.id) && !inv.licenseOnly) return true;
    // Ciężarówka do sprzedaży (wymiana na lepszy model) nie bierze już nowych tras
    const ns = AP.newSet;
    if (ns && ns.replace && !ns.soldOld && String(ns.replace.id) === String(t.id)) return true;
    const h = AP.holdTruck;
    return !!(h && String(h.id) === String(t.id) && h.until > Date.now());
  }

  // Kiedy jechać na stację. Przerwa po objeździe dotyczy tylko ciężarówek właśnie obsłużonych – kolejna ciężarówka,
  // która skończyła kurs chwilę później, jedzie tankować od razu (wcześniej czekała do końca 90-sekundowej przerwy całej floty)
  function fuelDue() {
    const g = ST.garage, now = Date.now();
    if (!g) return !!AP.fuelSoon && !isCool('fuelround');
    const handled = t => AP.fuelSeen && AP.fuelSeen[t.id] > now - 90000;
    if (g.trucks.some(t => /bez paliwa|out of fuel|no fuel/i.test(t.status) && !handled(t))) return true;
    if (g.trucks.some(t => isIdleStatus(t.status) && !inService(t) && !fuelOk(t) && !handled(t))) return true;
    return !!AP.fuelSoon && !isCool('fuelround');
  }

  // Wolny zestaw = stojąca ciężarówka z wystarczającą mocą + stojąca naczepa (+ wypoczęty kierowca z uprawnieniami
  // i pracownik magazynu) w tym samym mieście. Odejmujemy ładunki "Przyjęty", które już na nie czekają.
  // Zlecenia dla wolnych zestawów. Najpierw ciężarówki gotowe od razu (pełny bak – po kursie najpierw stacja); gdy
  // w magazynie zostaje miejsce, także te, którym tankowanie skończy się w ciągu 3 min – zlecenie czeka wtedy przyjęte,
  // a załadunek rusza zaraz po tankowaniu (bez osobnej wizyty na Trasach). Gotowe zestawy mają pierwszeństwo do miejsc.
  function tripNeeds() {
    expireStatuses();
    const ready = t => isIdleStatus(t.status) && !inService(t) && fuelOk(t);
    const base = needsFor(ready);
    const w = ST.warehouse;
    const room = w ? w.cap - w.used - base.reduce((s, x) => s + x.n, 0) : 0;
    if (room <= 0) return base;
    const extra = [];
    for (const m of needsFor(t => ready(t) || refuelEndsSoon(t))) {
      const b = base.find(x => sameCity(x.city, m.city) && x.type === m.type);
      const add = Math.min(m.n - (b ? b.n : 0), room - extra.reduce((s, x) => s + x.n, 0));
      if (add > 0) extra.push({ ...m, n: add, soon: true });
    }
    return base.concat(extra);
  }

  function needsFor(truckOk) {
    const g = ST.garage;
    if (!g) return [];
    const byCity = {};
    const at = city => (byCity[norm(city)] = byCity[norm(city)] || { city, trucks: [], trailers: {}, drivers: [], workers: 0 });
    g.trucks.filter(t => t.loc && !/na trasie|on route/i.test(t.loc) && !tiresBad(t) && !heldTruck(t) && truckOk(t)).forEach(t => at(t.loc).trucks.push(t));
    g.trailers.filter(t => isIdleStatus(t.status) && t.loc && !inService(t, 'trailer') && !heldTrailer(t)).forEach(t => {
      const c = at(t.loc), ty = t.type || 1;
      (c.trailers[ty] = c.trailers[ty] || []).push(t);
    });
    // Bez danych o pracownikach (np. nieudane pobranie) nie blokujemy tras – wtedy liczą się tylko pojazdy
    const emps = ST.employees && ST.employees.list && ST.employees.list.length ? ST.employees.list : null;
    if (emps) emps.filter(e => isIdleStatus(e.action) && e.loc && !e.freight && !(e.energy < S.sleepAt)).forEach(e => {
      const c = byCity[norm(e.loc)];
      if (!c) return;
      if (e.role === 'driver') c.drivers.push(e.lic || 9);
      if (e.role === 'worker') c.workers++;
    });
    const waiting = {};
    ((ST.warehouse && ST.warehouse.rows) || []).filter(r => r.state === 'load').forEach(r => {
      const k = norm(r.from) + '|' + r.type;
      waiting[k] = (waiting[k] || 0) + 1;
    });
    const out = [];
    for (const c of Object.values(byCity)) {
      const used = new Set();
      let workers = emps ? c.workers : Infinity;
      const drivers = c.drivers.sort((a, b) => a - b);
      for (const ty of Object.keys(c.trailers).map(Number).sort((a, b) => b - a)) {
        const hpNeed = (TIERS[ty] || {}).hp || 200;
        const able = c.trucks.filter(t => !used.has(t.id) && (truckSpec(t).hp == null || truckSpec(t).hp >= hpNeed));
        let sets = Math.min(c.trailers[ty].length, able.length, workers);
        if (emps) {
          const ok = drivers.filter(l => l >= ty);
          sets = Math.min(sets, ok.length);
          ok.slice(0, sets).forEach(l => drivers.splice(drivers.indexOf(l), 1));
        }
        able.slice(0, sets).forEach(t => used.add(t.id));
        workers -= sets;
        const need = sets - (waiting[norm(c.city) + '|' + ty] || 0);
        if (need > 0 && !isCool(`trips:${norm(c.city)}:${ty}`)) {
          out.push({ city: c.city, type: ty, n: need, truckId: able[0].id, trailerId: c.trailers[ty][0].id });
        }
      }
    }
    return out;
  }

  // Opony: zużyte na ciężarówce → wymiana; w lecie letnie, w zimie zimowe; wiosną/jesienią przygotuj komplety na kolejny sezon.
  // Zakładanie na konkretną ciężarówkę: Garaż → ciężarówka → "Zmień" (lista kompletów z magazynu, przycisk "Wybierz").
  function tirePlan() {
    if (!AP.autoTires || isCool('tires')) return null;
    const s = ST.season && ST.season.key, g = ST.garage;
    if (!s || !g || !g.trucks.length || !ST.tires) return null;
    const good = Math.max(S.tireMinCond, S.tireWornAt + 20);
    const usable = t => ST.tires.stock.filter(x => x.type === t && x.cond >= S.tireMinCond).length;
    const fresh = t => ST.tires.stock.filter(x => x.type === t && x.cond >= good).length;
    const need = s === 'summer' ? 'summer' : s === 'winter' ? 'winter' : null;
    const next = s === 'spring' ? 'summer' : s === 'autumn' ? 'winter' : null;
    const typeOf = t => (tireInfo(t) || {}).type || t.tires || null;
    // Zmiana opon tylko dla ciężarówki stojącej w mieście (nie w trasie)
    const reachable = t => t.loc && !/na trasie|on route/i.test(t.loc) && !isCool('tiremount:' + t.id);
    // 1. Zużyte opony (gra nie pozwala ruszyć): najlepszy komplet z magazynu, a gdy go brak – zakup nowego
    const worn = g.trucks.filter(t => tiresWorn(t) && reachable(t) && !(AP.tireTry && AP.tireTry[t.id] > Date.now() - 6 * 3600000));
    if (worn.length) {
      const t = worn[0];
      const first = need || next || 'summer';
      const types = need ? [need] : [first, first === 'summer' ? 'winter' : 'summer'];
      const ok = types.filter(ty => fresh(ty) > 0);
      if (ok.length) return { action: 'mount', truckId: t.id, types: ok, minCond: good, worn: true };
      if (!isCool('tirebuy')) return { action: 'buy', type: first, n: 1, worn: [t.id] };
      // Kupić się teraz nie da – byle dobry komplet z magazynu (np. letnie zimą), żeby ciężarówka w ogóle ruszyła
      const any = ['summer', 'winter'].filter(ty => fresh(ty) > 0);
      if (any.length) return { action: 'mount', truckId: t.id, types: any, minCond: good, worn: true };
    }
    // Bez odczytu opon (garaż albo karta ciężarówki na ładunku) nic nie kupujemy w ciemno
    if (!g.trucks.some(t => typeOf(t))) return null;
    if (need) {
      const wrong = g.trucks.filter(t => typeOf(t) && typeOf(t) !== need);
      if (!wrong.length) return null;
      const missing = wrong.length - usable(need);
      if (missing > 0) return isCool('tirebuy') ? null : { action: 'buy', type: need, n: missing };
      const t = wrong.find(reachable);
      return t ? { action: 'mount', truckId: t.id, types: [need], minCond: S.tireMinCond } : null;
    }
    if (next && !isCool('tirebuy')) {
      const missing = g.trucks.length - g.trucks.filter(t => typeOf(t) === next).length - usable(next);
      if (missing > 0) return { action: 'buy', type: next, n: missing, prep: true };
    }
    return null;
  }

  // Media: nowa umowa, gdy zapotrzebowanie (większe z: karta mediów, suma budynków z Budynków) już teraz przekracza
  // umowy (niedobór – np. po ulepszeniu magazynu/garażu) albo przekroczy je po wygaśnięciu bieżących umów
  function utilPlan() {
    if (!AP.autoUtilities || !ST.util) return null;
    const u = ST.util, dem = utilDemand() || {};
    for (const key of ['elec', 'water']) {
      const c = u[key];
      if (!c || isCool('util:' + key)) continue;
      const used = Math.max(c.used || 0, dem[key] || 0);
      const expiring = u.active.filter(a => a.type === key && a.hoursLeft <= S.utilHoursAhead).reduce((s, a) => s + (a.amount || 0), 0);
      const capAfter = c.cap - expiring;
      if (!(used > 0) || capAfter >= used - 1e-9) continue;
      const need = used - capAfter;
      const offers = u.offers.filter(o => o.type === key && o.amount > 0);
      const fit = offers.filter(o => o.amount >= need - 1e-9).sort((a, b) => a.perHour - b.perHour || b.hours - a.hours || b.amount - a.amount);
      const pick = fit[0] || offers.sort((a, b) => b.amount - a.amount)[0];
      if (pick) return { key, need, used, cap: c.cap, short: used > c.cap + 1e-9, offer: pick };
    }
    return null;
  }

  // Mechanicy: ilu utrzymywać – z ⚙, a bez ustawienia ok. 40% pojazdów (min. 2), a jeśli gra odmówiła naprawy z braku
  // mechaników – tyle, ile wtedy brakowało. Kontrakt kosztuje grosze w porównaniu z postojem zestawu, więc z zapasem.
  function mechNeed() {
    if (S.mechanics > 0) return S.mechanics;
    const g = ST.garage, veh = g ? g.trucks.length + g.trailers.length : 0;
    return Math.max(2, Math.ceil(veh * 0.4), AP.mechLearned || 0);
  }
  // Kontrakt z mechanikami, gdy po wygaśnięciu bieżących zostanie ich mniej niż trzeba (bez premium "Autoodnawianie"):
  // najtańsza oferta (€/h), która pokrywa brak; przy remisie dłuższa i z większą liczbą mechaników
  function mechPlan() {
    if (!AP.autoMechanics || !ST.mech || isCool('mech')) return null;
    const m = ST.mech, need = mechNeed();
    const expiring = m.active.filter(a => !(a.hoursLeft > S.utilHoursAhead)).reduce((s, a) => s + (a.amount || 0), 0);
    const after = m.count - expiring;
    if (after >= need) return null;
    const lack = need - after;
    const offers = m.offers.filter(o => o.amount > 0 && o.perHour > 0 && !o.disabled);
    const fit = offers.filter(o => o.amount >= lack).sort((a, b) => a.perHour - b.perHour || b.hours - a.hours || b.amount - a.amount);
    const pick = fit[0] || offers.slice().sort((a, b) => b.amount - a.amount || a.perHour - b.perHour)[0];
    return pick ? { need, have: m.count, after, lack, offer: pick } : null;
  }

  // Wykorzystanie floty (średnia krocząca ~30 min): czy zestawy faktycznie mają co robić
  function trackFleetBusy() {
    const g = ST.garage;
    if (!g || !g.trucks.length) return;
    const v = g.trucks.filter(t => !isIdleStatus(t.status)).length / g.trucks.length;
    const f = AP.fleetBusy;
    const a = f ? Math.min(1, (Date.now() - f.t) / (30 * 60000)) : 1;
    AP.fleetBusy = { v: f ? f.v + (v - f.v) * a : v, t: Date.now() };
  }

  // =========================================================================
  // ---------- KOMPLETNOŚĆ ZESTAWÓW: ludzie i uprawnienia vs pojazdy ----------
  // =========================================================================
  // Zestaw w tej grze to pula w mieście: ładunek bierze ciężarówkę, naczepę, kierowcę i pracownika, którzy stoją
  // w mieście startu, a ludzie nie przemieszczają się sami (jeżdżą z ciężarówką). Braki liczymy więc w mieście
  // (wszyscy, którzy tam są – śpiący też; bez tych w trasie) i sprawdzamy całą firmę: kierowca zwolniony przy
  // rozładunku, gdy jego ciężarówka jest jeszcze "Na trasie", wygląda na wolnego, ale wolnym nie jest.
  // (Wcześniej taki chwilowy "wolny kierowca" w siedzibie sprawiał, że nowy zestaw zostawał bez kierowcy.)
  const onRoute = loc => !loc || /na trasie|on route/i.test(loc);
  const needHp = ty => (TIERS[ty] || {}).hp || 200;
  const hpOf = t => truckSpec(t).hp || 999;
  const licOf = e => e.lic || 1;

  // arrivals: jednostki w trasie liczone w mieście docelowym ładunku (do oceny nadwyżek: kierowca zwolniony przy
  // rozładunku "należy" do ciężarówki, która tam właśnie jedzie). certain = wiadomo, dokąd jedzie każda jednostka.
  // Przewóz zlecony przez bota (taksówka / Transferio) zawsze liczy się już w mieście docelowym.
  function crewModel({ arrivals = false } = {}) {
    const g = ST.garage, emps = ST.employees && ST.employees.list;
    if (!g || !emps || !emps.length) return null;
    const by = {};
    let certain = true;
    const at = c => (by[norm(c)] = by[norm(c)] || { city: c, trucks: [], trailers: [], drivers: [], workers: [] });
    const place = (kind, u) => {
      const mv = moveOf(kind, u.id);
      if (mv) return mv.to;
      if (!onRoute(u.loc)) return u.loc;
      if (!arrivals) return null;
      const to = routeDest(kind, u);
      if (!to) certain = false;
      return to;
    };
    g.trucks.forEach(t => { const c = place('truck', t); if (c) at(c).trucks.push(t); });
    g.trailers.forEach(t => { const c = place('trailer', t); if (c) at(c).trailers.push(t); });
    const drivers = emps.filter(e => e.role === 'driver'), workers = emps.filter(e => e.role === 'worker');
    drivers.forEach(e => { const c = place('emp', e); if (c) at(c).drivers.push(e); });
    workers.forEach(e => { const c = place('emp', e); if (c) at(c).workers.push(e); });
    return {
      cities: Object.values(by).map(cityCrew), drivers, workers, certain,
      T: g.trucks.length, R: g.trailers.length, D: drivers.length, W: workers.length,
      // Prawo jazdy obejmuje typy niższe: kierowców z uprawnieniami ≥ t vs naczep typu ≥ t (w całej firmie)
      qual: t => drivers.filter(e => licOf(e) >= t).length,
      need: t => g.trailers.filter(x => (x.type || 1) >= t).length,
      licKnown: drivers.every(e => e.lic > 0)
    };
  }

  // Cel ładunku, z którym jednostka jest w trasie: ciężarówka/naczepa – z mapy ładunków (strona ładunku),
  // ludzie – z numeru ładunku w kolumnie pracowników ("#171")
  function routeDest(kind, u) {
    const w = ST.warehouse || {}, prog = w.prog || [], rows = w.rows || [];
    const byN = n => prog.find(p => p.n === n) || rows.find(r => r.n === n);
    if (kind === 'truck' || kind === 'trailer') {
      const key = kind + 'Id', fm = ST.fmap || {};
      const n = Object.keys(fm).filter(k => String(fm[k][key]) === String(u.id)).sort((a, b) => fm[b].t - fm[a].t).find(byN);
      return n ? byN(n).to || null : null;
    }
    if (!u.freight) return null;
    const r = prog.find(p => p.label === u.freight) || rows.find(x => x.label === u.freight);
    return r ? r.to || null : null;
  }

  // =========================================================================
  // ---------- PORZĄDEK FLOTY: przewozy, sprzedaż, zwolnienia ----------
  // =========================================================================
  // Narzędzia gry bez premium (sprawdzone na zapisanych stronach):
  //  • pracownik → "Przenieś" (taksówka, €3/100 km): employees_transfer&e=ID, formularz #transferemployee,
  //  • ciężarówka / naczepa → "Przenieś" (Transferio €600): truck_transfer&t=ID / trailer_transfer&t=ID,
  //  • "Sprzedaj dealerowi" (wartość z karty pojazdu): formularz #selltruck / #selltrailer z potwierdzeniem,
  //  • "Zwolnij": przycisk z potwierdzeniem → employee_fire (pieniądze za licencję przepadają).
  // Pensje gra płaci tylko za pracę (kierowca za km, pracownik za akcję, menedżer za ładunek), więc wolny człowiek nic
  // nie kosztuje – zwolnienie ma sens tylko wtedy, gdy brakuje miejsca w budynku. Pojazd płaci ubezpieczenie (€400/dzień)
  // i traci wartość, więc stojący bez sensu pojazd to strata. Minuta postoju zestawu kosztuje więcej niż egzamin,
  // dlatego braki ludzi bot łata od razu (zatrudnienie/szkolenie), a przewozy stosuje tam, gdzie są tańsze.
  const MOVE_TTL = 3 * 3600000;
  function moveOf(kind, id) {
    const m = AP.moves && AP.moves[kind + ':' + id];
    return m && Date.now() - m.t < MOVE_TTL ? m : null;
  }
  function addMove(kind, u, to, why, sec) {
    AP.moves = AP.moves || {};
    AP.moves[kind + ':' + u.id] = { kind, id: String(u.id), name: u.name, from: u.loc, to, t: Date.now(), until: sec ? Date.now() + sec * 1000 : null, why };
  }
  // Przewozy w toku: dotarł → koniec; po 4 min wciąż stoi w mieście startu → przewóz nie ruszył (spróbuję inaczej)
  function trackMoves() {
    const now = Date.now();
    for (const [k, m] of Object.entries(AP.moves || {})) {
      const u = m.kind === 'emp' ? ((ST.employees && ST.employees.list) || []).find(e => String(e.id) === m.id) : unitById(m.kind, m.id);
      if (!u || now - m.t > MOVE_TTL) { delete AP.moves[k]; continue; }
      if (sameCity(u.loc, m.to)) { delete AP.moves[k]; logEvent(`🚚 ${m.name} jest już w ${m.to}`); continue; }
      if (now - m.t > 4 * 60000 && sameCity(u.loc, m.from) && isIdleStatus(m.kind === 'emp' ? u.action : u.status)) {
        delete AP.moves[k];
        setCool('move:' + k, 30 * 60);
        logEvent(`⚠️ Przewóz ${m.name} do ${m.to} nie ruszył – spróbuję inaczej`);
      }
    }
  }

  // Ludzie naprawdę wolni: w ich mieście (razem z tym, co tam właśnie jedzie) nie ma dla nich zestawu, nie są przy
  // ładunku i stan trwa ≥ 3 min. Tylko gdy wiadomo, dokąd jedzie każda jednostka w trasie.
  function crewSpares() {
    const m = crewModel({ arrivals: true }), out = { drivers: [], workers: [] };
    AP.spare = AP.spare || {};
    if (!m || !m.certain) return out;
    const now = Date.now(), seen = new Set(), ns = AP.newSet;
    for (const c of m.cities) {
      // ludzie w mieście, w którym powstaje nowy zestaw, są dla niego zarezerwowani
      if (ns && ns.city && sameCity(ns.city, c.city)) continue;
      // kierowcy przy otwartych parach to kandydaci do szkolenia w tym mieście – nie nadwyżka
      const drv = c.spareDrivers.slice().sort((a, b) => licOf(a) - licOf(b)).slice(0, Math.max(0, c.spareDrivers.length - c.open.length));
      const wrk = c.workers.slice(c.pairs);
      for (const [list, role] of [[drv, 'drivers'], [wrk, 'workers']]) {
        for (const e of list) {
          if (onRoute(e.loc) || e.freight || !isIdleStatus(e.action) || moveOf('emp', e.id)) continue;
          seen.add(e.id);
          AP.spare[e.id] = AP.spare[e.id] || now;
          if (now - AP.spare[e.id] >= 3 * 60000) out[role].push(e);
        }
      }
    }
    for (const k of Object.keys(AP.spare)) if (!seen.has(k)) delete AP.spare[k];
    return out;
  }

  // Miejsca w budynkach na kolejnego człowieka: kierowcy – garaż, pracownicy magazynu – magazyn
  function roomFor(role) {
    const P = ST.props || {};
    const slot = role === 'driver' ? P.garage && P.garage.drivers : role === 'worker' ? P.warehouse && P.warehouse.workers : null;
    if (!slot || !slot.cap) return Infinity;
    const have = ((ST.employees && ST.employees.list) || []).filter(e => e.role === role).length;
    return slot.cap - Math.max(slot.used, have);
  }
  const ageOf = e => { const inf = ST.empInfo && ST.empInfo[e.id]; return inf ? inf.age + (Date.now() - inf.t) / 86400000 : null; };

  // Wolny człowiek do przewiezienia na brak w innym mieście: kierowca z uprawnieniami do typu naczepy (bez egzaminu),
  // a z kilku – najtańszy w płacy (starzy pracownicy mają często dużo niższe stawki niż nowe oferty)
  function spareFor(role, type = 1) {
    if (AP.autoReorg === false) return null;
    const sp = crewSpares()[role === 'driver' ? 'drivers' : 'workers'].filter(e => !isCool('move:emp:' + e.id));
    return sp.sort((a, b) => (licOf(b) >= type) - (licOf(a) >= type) || (a.wage || 1e9) - (b.wage || 1e9) || licOf(b) - licOf(a))[0] || null;
  }

  // Brak miejsca na nowego człowieka: najpierw wolny człowiek z innego miasta (taksówka), potem ulepszenie budynku,
  // a na końcu zwolnienie kogoś tuż przed emeryturą (≥ 64 lat – i tak zaraz odejdzie), żeby zrobić miejsce
  function roomFix(role, city, why, type = 1) {
    const pick = spareFor(role, type);
    if (pick) return { role: 'move', kind: 'emp', unit: pick, to: city, why: `${why} (brak miejsca na nowego – przenoszę wolnego)` };
    const bld = role === 'driver' ? 'garage' : 'warehouse', P = (ST.props || {})[bld] || {};
    if (P.canUpgrade && !P.rented && P.upCost > 0 && canSpend(P.upCost, 'tires') && !isCool('upgrade:' + bld)) {
      return { role: 'upgrade', building: bld, cost: P.upCost, why: `${why} – ${bld === 'garage' ? 'garaż' : 'magazyn'} pełny` };
    }
    const old = ((ST.employees && ST.employees.list) || []).filter(e => e.role === role && !e.freight && ageOf(e) >= 64 && !isCool('fire:' + e.id))
      .sort((a, b) => ageOf(b) - ageOf(a))[0];
    if (old) return { role: 'fire', unit: old, why: `${why} – brak miejsca, ${old.name} (${Math.floor(ageOf(old))} lat) i tak zaraz przejdzie na emeryturę` };
    return null;
  }

  // Ciężarówka i naczepa bez pary w różnych miastach: przewóz Transferio (€600) zamiast kupowania. Wieziemy tę
  // jednostkę, przy której nie ma ludzi (zwykle naczepę do ciężarówki – kierowca jest przy ciężarówce)
  function reunitePlan() {
    // W trakcie budowy/wymiany zestawu jego naczepa i ludzie czekają na nową ciężarówkę – nie ruszamy ich
    if (AP.autoReorg === false || isCool('reunite') || AP.newSet) return null;
    const m = crewModel({ arrivals: true });
    if (!m || !m.certain) return null;
    const busy = id => [AP.newSet && AP.newSet.truckId, AP.newSet && AP.newSet.trailerId, AP.investState && AP.investState.truckId].some(x => x && String(x) === String(id));
    const free = u => isIdleStatus(u.status) && !onRoute(u.loc) && !inService(u, u.kind) && !busy(u.id) && !moveOf(u.kind, u.id);
    const loneT = [], loneR = [];
    for (const c of m.cities) {
      const used = new Set(c.sets.concat(c.open).flatMap(p => [p.truck.id, p.trailer.id]));
      c.trucks.filter(t => !used.has(t.id) && free(t)).forEach(t => loneT.push({ u: t, c }));
      c.trailers.filter(x => !used.has(x.id) && free(x)).forEach(x => loneR.push({ u: x, c }));
    }
    const now = Date.now();
    AP.gap = AP.gap || {};
    const pairs = loneT.map(t => ({ t, fit: loneR.filter(r => !sameCity(r.c.city, t.c.city) && hpOf(t.u) >= needHp(r.u.type || 1))
      .sort((a, b) => (b.u.type || 1) - (a.u.type || 1))[0] })).filter(x => x.fit);
    const live = new Set(pairs.map(x => `lone|${x.t.u.id}|${x.fit.u.id}`));
    for (const k of Object.keys(AP.gap)) if (/^lone\|/.test(k) && !live.has(k)) delete AP.gap[k];
    for (const { t, fit } of pairs) {
      const key = `lone|${t.u.id}|${fit.u.id}`;
      AP.gap[key] = AP.gap[key] || now;
      if (now - AP.gap[key] < 3 * 60000) continue;
      // ludzie przy ciężarówce (zwykle) → naczepa do niej; ludzie tylko przy naczepie → ciężarówka do naczepy
      const crewAt = c => c.spareDrivers.length + Math.max(0, c.workers.length - c.pairs);
      const toTruck = crewAt(t.c) >= crewAt(fit.c);
      const unit = toTruck ? fit.u : t.u, kind = toTruck ? 'trailer' : 'truck', to = toTruck ? t.c.city : fit.c.city;
      if (isCool(`move:${kind}:${unit.id}`)) continue;
      return { kind, unit, to, key, why: `${t.u.name} (${t.c.city}) i ${fit.u.name} (${fit.c.city}) stoją bez pary – łączę je przewozem` };
    }
    return null;
  }

  // Zestawy w mieście: naczepy od najwyższego typu, każda z najsłabszą ciężarówką, która ją uciągnie, i kierowcą
  // z najniższymi wystarczającymi uprawnieniami (wyższe zostają dla lepszych naczep). Reszta to "otwarte" zestawy
  // (ciężarówka + naczepa bez kierowcy, który może je prowadzić) i wolni ludzie.
  function cityCrew(c) {
    const trucks = c.trucks.slice().sort((a, b) => hpOf(a) - hpOf(b));
    const drivers = c.drivers.slice().sort((a, b) => licOf(a) - licOf(b));
    const sets = [], rest = [];
    for (const x of c.trailers.slice().sort((a, b) => (b.type || 1) - (a.type || 1))) {
      const ty = x.type || 1;
      const ti = trucks.findIndex(t => hpOf(t) >= needHp(ty)), di = drivers.findIndex(e => licOf(e) >= ty);
      if (ti < 0 || di < 0) { rest.push(x); continue; }
      sets.push({ truck: trucks.splice(ti, 1)[0], trailer: x, driver: drivers.splice(di, 1)[0], type: ty });
    }
    const open = [];
    for (const x of rest) {
      const ti = trucks.findIndex(t => hpOf(t) >= needHp(x.type || 1));
      if (ti >= 0) open.push({ truck: trucks.splice(ti, 1)[0], trailer: x, type: x.type || 1 });
    }
    return { ...c, sets, open, spareDrivers: drivers, pairs: sets.length + open.length };
  }

  // Braki do uzupełnienia (z czasem potwierdzenia): zestaw bez kierowcy → zatrudnienie (z egzaminami do typu naczepy),
  // ciężarówka + naczepa stoją, bo żaden kierowca w mieście nie ma uprawnień → szkolenie jednego z nich; brak pracownika
  // magazynu → zatrudnienie. Szkolenie tylko przy takiej stojącej parze (sama naczepa wyższego typu w mieście, gdy
  // ciężarówka jeździ z inną naczepą, to nie powód). Gdy uprawnionych w firmie jest dość, ale są w innych miastach,
  // bot czeka dłużej – może dojadą; minuta postoju zestawu kosztuje jednak więcej niż egzamin, więc nie w nieskończoność.
  const CREW_CONFIRM = 90 * 1000, CREW_STRANDED = 10 * 60000, LIC_STUCK = 10 * 60000;
  function crewGaps(m = crewModel()) {
    if (!m) return [];
    const out = [], ns = AP.newSet;
    for (const c of m.cities) {
      // Miasto, w którym właśnie powstaje nowy zestaw – ludzi zatrudnia jego plan (bez dublowania)
      if (ns && ns.city && sameCity(ns.city, c.city)) continue;
      let spare = c.spareDrivers.slice().sort((a, b) => licOf(b) - licOf(a));
      for (const p of c.open.slice().sort((a, b) => b.type - a.type)) {
        const d = spare.shift();
        if (d) {
          if (!m.licKnown) continue;
          const ok = m.qual(p.type) < m.need(p.type);
          out.push({ kind: 'license', city: c.city, type: p.type, driver: d, pair: p, ok, qual: m.qual(p.type), need: m.need(p.type), key: `lic|${norm(c.city)}|${p.type}` });
        } else {
          out.push({ kind: 'driver', city: c.city, type: p.type, pair: p, short: m.D < m.T, key: `drv|${norm(c.city)}|${p.type}` });
        }
      }
      const wGap = c.pairs - c.workers.length;
      for (let i = 0; i < wGap; i++) {
        out.push({ kind: 'worker', city: c.city, short: m.W < Math.min(m.T, m.R), key: `wrk|${norm(c.city)}|${i}` });
      }
    }
    // Potwierdzenie w czasie: brak musi się utrzymać (dane garażu i ludzi pobierane są osobno, mogą się minąć o chwilę)
    const now = Date.now();
    AP.gap = AP.gap || {};
    const keys = new Set(out.map(x => x.key));
    // sprzątamy tylko własne liczniki (łączenie ciężarówki z naczepą "lone|…" ma swoje)
    for (const k of Object.keys(AP.gap)) if (!/^lone\|/.test(k) && !keys.has(k)) delete AP.gap[k];
    for (const x of out) {
      AP.gap[x.key] = AP.gap[x.key] || now;
      x.since = AP.gap[x.key];
      const wait = x.kind === 'license' ? (x.ok ? CREW_CONFIRM * 2 : LIC_STUCK) : x.short ? CREW_CONFIRM : CREW_STRANDED;
      x.at = x.since + wait;
      x.due = now >= x.at;
    }
    return out;
  }

  // Kadry: następca przed emeryturą, braki w zestawach (kierowca, uprawnienia, pracownik), brak menedżerów
  function hirePlan() {
    if (!AP.autoHire) return null;
    const g = ST.garage, emps = ST.employees && ST.employees.list;
    if (!g || !emps || !emps.length) return null;
    const now = Date.now();
    // Zatrudnienie, a gdy w budynku nie ma miejsca – przeniesienie wolnego człowieka, ulepszenie budynku albo zwolnienie
    // kogoś tuż przed emeryturą
    const hireOr = task => (task.role === 'manager' || roomFor(task.role) >= 1 ? task : roomFix(task.role, task.city, task.why, task.lic || 1));
    for (const e of emps) {
      const inf = ST.empInfo && ST.empInfo[e.id];
      if (!inf || !HIRE_FORMS[e.role] || (AP.replaced || {})[e.id] || isCool('hire:' + e.role)) continue;
      const age = inf.age + (now - inf.t) / 86400000;
      if (age >= 63) {
        const city = e.role !== 'manager' && e.loc && !/na trasie|on route/i.test(e.loc) ? e.loc : null;
        const t = hireOr({ role: e.role, city, why: `następca za ${e.name} (${Math.floor(age)} lat, emerytura w wieku 65)`, replaces: e.id, lic: e.role === 'driver' ? Math.max(1, e.lic || 1) : 0 });
        if (t) return t;
      }
    }
    // Szkolenie, zatrudnienie albo przewóz już w toku – najpierw jego wynik (inaczej dublowanie ludzi i egzaminów)
    const busy = AP.hireTask || AP.pendingLicense || AP.licenseTask || AP.moveTask;
    for (const x of busy ? [] : crewGaps()) {
      const tn = (TIERS[x.type] || {}).trailerName || '';
      // Brak człowieka, a w innym mieście stoi naprawdę wolny (stan sprawdzony, wiadomo, dokąd jedzie każdy zestaw) –
      // przewóz taksówką zamiast zatrudniania, już po krótkim potwierdzeniu braku
      if ((x.kind === 'driver' || x.kind === 'worker') && now - x.since >= CREW_CONFIRM) {
        const sp = spareFor(x.kind, x.type || 1);
        if (sp) return { role: 'move', kind: 'emp', unit: sp, to: x.city, gapKey: x.key,
          why: `w ${x.city} ${x.kind === 'driver' ? `${x.pair.truck.name} stoi bez kierowcy` : 'zestaw bez pracownika magazynu'} – przenoszę wolnego ${x.kind === 'driver' ? 'kierowcę' : 'pracownika'} z ${sp.loc}` };
      }
      if (!x.due) continue;
      if (x.kind === 'license') {
        if (isCool('lic:' + x.driver.id)) continue;
        return {
          role: 'license', driverId: x.driver.id, lic: x.type, gapKey: x.key,
          why: `${x.driver.name} w ${x.city}: ${x.pair.truck.name} + ${tn.toLowerCase()} stoi bez kierowcy z uprawnieniami` +
            (x.ok ? ` (w firmie ${x.qual} uprawnionych na ${x.need} takich naczep)` : ` od ${fmtDur((now - x.since) / 1000)} – uprawnieni są w innych miastach`)
        };
      }
      if (x.kind === 'driver' && !isCool('hire:driver')) {
        const t = hireOr({ role: 'driver', city: x.city, lic: x.type, gapKey: x.key, why: `w ${x.city} ${x.pair.truck.name} + ${tn.toLowerCase()} stoi bez kierowcy` });
        if (t) return t;
      }
      if (x.kind === 'worker' && !isCool('hire:worker')) {
        const t = hireOr({ role: 'worker', city: x.city, lic: 0, gapKey: x.key, why: `w ${x.city} zestaw bez pracownika magazynu` });
        if (t) return t;
      }
    }
    const ms = AP.mgrShort;
    if (ms && ms.n >= 3 && now - ms.t < 3600000 && !isCool('hire:manager')) {
      return { role: 'manager', city: null, why: 'zakończenia ładunków czekają na wolnego menedżera' };
    }
    return null;
  }

  // =========================================================================
  // ---------- ROZBUDOWA FLOTY: kolejny zestaw ----------
  // =========================================================================
  // Inwestycje tylko ponad zapas: kwota z ⚙ albo (0 = auto) rezerwa gotówki lub koszty stałe na dobę – co większe
  const investFloor = () => (AP.expandReserve > 0 ? Math.max(AP.expandReserve, S.reserve) : Math.max(S.reserve, fixedPerDay() || 0));
  const MARGINAL_SET = 0.85;   // zupełnie nowy zestaw: 85% średniego zarobku zestawu (ostrożnie)

  // Naczepy bez ciągnika: naczep jest więcej niż ciężarówek, więc nadwyżka stoi i płaci ubezpieczenie (€400/dzień).
  // Tylko naczepa naprawdę zbędna w swoim mieście (więcej wolnych naczep niż wolnych ciężarówek) – nigdy ta,
  // której potrzebuje stojąca tam ciężarówka. Najlepsza w siedzibie (tam przyjeżdżają nowe ciężarówki), potem najsłabszy typ.
  function loneTrailers() {
    const g = ST.garage;
    if (!g) return [];
    const surplus = g.trailers.length - g.trucks.length;
    if (surplus <= 0) return [];
    const idle = x => isIdleStatus(x.status) && !inService(x, 'trailer') && x.loc && !/na trasie|on route/i.test(x.loc);
    const spare = c => g.trailers.filter(x => idle(x) && sameCity(x.loc, c)).length
      - g.trucks.filter(t => sameCity(t.loc, c) && isIdleStatus(t.status)).length;
    const out = [], taken = {};
    for (const x of g.trailers.filter(idle).sort((a, b) => sameCity(b.loc, ST.hq) - sameCity(a.loc, ST.hq) || (a.type || 1) - (b.type || 1))) {
      const k = norm(x.loc);
      if (spare(x.loc) - (taken[k] || 0) <= 0) continue;
      taken[k] = (taken[k] || 0) + 1;
      out.push(x);
    }
    return out.slice(0, surplus);
  }

  // Podstawa wyceny zestawu: prawdziwy zysk netto/km floty (zakończone kursy, a bez nich prognozy gry z ładunków),
  // km na godzinę na zestaw oraz średnie spalanie, zużycie i prędkość obecnych ciężarówek
  function setRateCtx() {
    const g = ST.garage;
    if (!g || !g.trucks.length) return null;
    const fresh = x => x && x.km > 0 && Number.isFinite(x.net) && Date.now() - x.t < 48 * 3600000;
    const samples = (ST.hist || []).filter(fresh);
    const have = new Set(samples.map(x => String(x.n)));
    for (const [n, x] of Object.entries(learn().net || {})) if (!have.has(String(n)) && fresh(x)) samples.push(x);
    if (samples.length < 3) return null;
    const fp = fuelPrice(null);
    const avg = f => g.trucks.reduce((s, t) => s + f(t), 0) / g.trucks.length;
    // Ile zestawów jeździło w tym czasie: różne ciężarówki w prognozach ładunków (a bez nich – pary ciężarówka+naczepa)
    const drove = new Set(Object.values(learn().net || {}).filter(fresh).map(x => x.truckId).filter(Boolean)).size;
    const sets = Math.max(1, drove || Math.min(g.trucks.length, g.trailers.length));
    const er = earnings(6);
    const km = samples.reduce((s, x) => s + x.km, 0);
    return {
      basePerKm: samples.reduce((s, x) => s + x.net, 0) / km,
      avgKm: km / samples.length,
      fp, n: samples.length,
      fleetFuelKm: avg(t => truckSpec(t).lPerKm) * fp,
      fleetWearKm: avg(t => wearCost(t, 'truck', 100).v / 100),
      fleetSpeed: avg(t => truckSpec(t).speed),
      kmh: er && er.kmPerH > 0 ? er.kmPerH / sets : 300,
      income: er && er.perH > 0 ? er.perH : null
    };
  }

  // € na godzinę zestawu z ciężarówką modelu m: zysk/km floty poprawiony o spalanie, zużycie (nowa) i prędkość modelu;
  // mały bak (zasięg < 1000 km) odcina dłuższe trasy; minus ubezpieczenie nowego pojazdu (€400/dzień)
  // wearKm: zużycie €/km tej ciężarówki (nowa ~0,02; dla starej – stawka z prognoz gry przy wycenie wymiany)
  function modelRate(m, c, wearKm = 0.02) {
    const perKm = c.basePerKm + c.fleetFuelKm - c.fp / m.kmPerL + c.fleetWearKm - wearKm;
    const speed = 1 / (0.4 + 0.6 * c.fleetSpeed / (m.speed || c.fleetSpeed));
    const range = (m.tank || 500) * m.kmPerL;
    const reach = range >= 1000 ? 1 : 0.85 + 0.15 * range / 1000;
    return c.kmh * speed * reach * perKm - 400 / 24;
  }

  // Czy ludzie w mieście wystarczą na wszystkie stojące tam zestawy – i czy w całej firmie jest ich co najmniej tylu,
  // ilu trzeba (kierowca zwolniony przy rozładunku, gdy ciężarówka jest jeszcze "Na trasie", nie jest wolny)
  function crewCovered(role, city) {
    const m = crewModel(), c = m && m.cities.find(x => sameCity(x.city, city));
    if (!c) return false;
    if (role === 'driver') return c.open.length === 0 && m.D >= m.T;
    return c.workers.length >= c.pairs && m.W >= Math.min(m.T, m.R);
  }

  // Pieniądze już przeznaczone na rozpoczęte plany (ludzie i egzaminy kupionego zestawu, egzaminy w toku) –
  // zakup opon z rezerwy ani kolejna inwestycja ich nie ruszą (zestaw bez kierowcy tylko płaci ubezpieczenie)
  function committed() {
    let c = 0;
    const s = AP.newSet;
    if (s && ['transfer_trailer', 'hire_driver', 'hire_worker'].includes(s.step)) {
      if (s.hireDriver !== false && s.step !== 'hire_worker') c += ((bestOffer('driver') || {}).price || 0) + (s.exams || 0);
      if (s.hireWorker !== false) c += (bestOffer('worker') || {}).price || 0;
    }
    const lt = AP.licenseTask, pl = AP.pendingLicense;
    if (lt) {
      const d = ((ST.employees && ST.employees.list) || []).find(e => String(e.id) === String(lt.driverId));
      c += examCost(d ? licOf(d) : 1, lt.targetTier);
    } else if (pl) c += examCost(1, pl.lic);
    return c;
  }

  // Ciężarówka bez naczepy (np. kupiona, a na naczepę zabrakło): stoi w mieście, w którym nie ma dla niej pary –
  // liczymy pary w mieście (wcześniej wystarczyła dowolna naczepa obok, np. innego zestawu, i ciężarówka czekała)
  function loneTruck() {
    const g = ST.garage;
    if (!g || g.trucks.length <= g.trailers.length) return null;
    const idle = t => isIdleStatus(t.status) && !onRoute(t.loc) && !inService(t) && !heldTruck(t);
    const m = crewModel();
    if (m) {
      for (const c of m.cities) {
        const used = new Set(c.sets.concat(c.open).map(p => String(p.truck.id)));
        const t = c.trucks.find(x => !used.has(String(x.id)) && idle(x));
        if (t) return t;
      }
      return null;
    }
    return g.trucks.find(t => idle(t) && !g.trailers.some(x => sameCity(x.loc, t.loc))) || null;
  }

  // ---------- Typy ładunków i licencje ----------
  // Przychód na km za ładunek typu t przy kursie ~L km (z listy tras). Typ jeszcze niewidziany na trasach –
  // ostrożna ekstrapolacja z poznanych typów (najwyżej +10% na każdy kolejny typ, liczona tylko w połowie).
  function typeRevKm(t, L) {
    const tr = learn().typeRate || {};
    const at = k => (tr[k] ? (tr[k].a + tr[k].b * L) / L : null);
    if (at(t) > 0) return { v: at(t), src: 'z tras' };
    const known = Object.keys(tr).map(Number).filter(k => at(k) > 0).sort((x, y) => x - y);
    if (!known.length) return null;
    const lo = known[0], hi = known[known.length - 1];
    const step = hi > lo ? Math.min(1.1, Math.max(1, Math.pow(at(hi) / at(lo), 1 / (hi - lo)))) : 1;
    const ref = t > hi ? hi : lo;
    return { v: at(ref) * (1 + (Math.pow(step, t - ref) - 1) * 0.5), src: 'szacunek' };
  }
  // O ile € na godzinę zestaw z naczepą typu t zarobi więcej (albo mniej) niż średnio obecne naczepy floty
  function typeGainH(t, c) {
    const L = c.avgKm || 450, mine = typeRevKm(t, L);
    const base = [...new Set(((ST.garage && ST.garage.trailers) || []).map(x => x.type || 1))].map(u => typeRevKm(u, L)).filter(Boolean);
    if (!mine || !base.length) return 0;
    return (mine.v - base.reduce((s, x) => s + x.v, 0) / base.length) * c.kmh;
  }
  // Typy, które firma już może wozić (licencja "Gotowe" albo posiadana naczepa), i kolejny do zdobycia
  function licensedTypes() {
    const L = ST.licenses && ST.licenses.list;
    const own = ST.garage ? ST.garage.trailers.map(x => x.type || 1) : [];
    return [...new Set([1, ...own, ...(L ? Object.keys(L).filter(k => L[k] === 'done').map(Number) : [])])].sort((a, b) => a - b);
  }
  function nextLicense() {
    const L = ST.licenses && ST.licenses.list, lvl = ST.company && ST.company.level;
    if (!L) return null;
    const t = Object.keys(L).map(Number).sort((a, b) => a - b).find(k => L[k] === 'exam');
    return t && TIERS[t] && !(lvl != null && lvl < TIERS[t].level) ? t : null;
  }
  const trailerPriceOf = t => (ST.trailerShop && ST.trailerShop.list[t] && ST.trailerShop.list[t].price) || (TIERS[t] || {}).trailerPrice || 0;
  // Egzaminy kierowcy od posiadanych uprawnień do typu t (prawo jazdy zdaje się po kolei)
  const examCost = (from, t) => { let s = 0; for (let i = Math.max(2, (from || 1) + 1); i <= t; i++) s += TIERS[i].licDriver; return s; };

  // Plan kolejnego zestawu – z tego, co firma już ma (sprzęt, licencje, ludzie, pieniądze), od najtańszego:
  //  • ciężarówka do nieużywanej naczepy (naczepa już jest; nowe ciężarówki przyjeżdżają do siedziby),
  //  • naczepa do ciężarówki bez naczepy,
  //  • komplet (ciężarówka + naczepa) – tylko gdy obecne zestawy naprawdę mają co robić.
  // Typ naczepy (podstawowa, kontener… albo kolejny typ razem z licencją) i model ciężarówki wybierane razem –
  // wg zysku po 7 dniach: stawki typu z listy tras, spalanie/prędkość/zasięg modelu, egzaminy, płace nowych ludzi.
  // Kupujemy to, na co stać firmę ponad zapas; na lepszą opcję czekamy najwyżej ~8 h zarobku.
  function expansionPlan() {
    const g = ST.garage, w = ST.warehouse;
    const lone = loneTrailers()[0] || null, lt = lone ? null : loneTruck();
    const out = { lone, loneTruck: lt };
    if (!g || !g.trucks.length || !w || !ST.models || !ST.hq || !ST.employees) return { ...out, why: 'zbieram dane (garaż, magazyn, salon, siedziba firmy)' };
    const c = setRateCtx();
    if (!c) return { ...out, why: 'zbieram dane o zarobkach (min. 3 kursy)' };
    const diff = g.trailers.length - g.trucks.length;
    if (diff > 0 && !lone) return { ...out, why: 'naczepa bez ciągnika jest teraz w serwisie albo w drodze – poczekam' };
    if (diff < 0 && !lt) return { ...out, why: 'ciężarówka bez naczepy jest teraz zajęta – poczekam' };
    const sets = Math.min(g.trucks.length, g.trailers.length) + 1;
    // Budynki: miejsca na pojazdy i kierowców (garaż) oraz na ładunki i pracowników magazynu (magazyn).
    // Kupiony magazyn bot ulepsza sam (koszt doliczony do zestawu); wynajmowanego nie da się ulepszyć.
    const P = ST.props || {}, gar = P.garage || {}, wh = P.warehouse || {};
    const whCanUp = !!(wh.canUpgrade && !wh.rented && wh.upCost > 0);
    let whUp = false;
    if (sets > w.cap) {
      if (whCanUp && sets <= w.cap + ((wh.freights && wh.freights.plus) || 2)) whUp = true;
      else return { ...out, block: 'warehouse', why: wh.rented !== false && !whCanUp
        ? `magazyn mieści ${w.cap} ładunki – ${sets}. zestaw nie miałby miejsca; najpierw kup magazyn (Budynki → Zakończ wynajem, Sklep → Kup) i go ulepsz`
        : `magazyn mieści ${w.cap} ładunki – ${sets}. zestaw nie miałby miejsca, a magazynu nie da się teraz ulepszyć` };
    }
    const emps = ST.employees.list;
    const vehFree = gar.vehicles ? gar.vehicles.cap - (g.trucks.length + g.trailers.length) : Infinity;
    const drvFree = gar.drivers ? gar.drivers.cap - Math.max(gar.drivers.used, emps.filter(e => e.role === 'driver').length) : Infinity;
    const wrkFree = wh.workers ? wh.workers.cap - Math.max(wh.workers.used, emps.filter(e => e.role === 'worker').length) : Infinity;
    const vehNeed = lone || lt ? 1 : 2;
    // Gdzie składamy zestaw: przy ciężarówce bez naczepy; przy naczepie bez ciągnika, gdy są przy niej wolni kierowca
    // i pracownik (nowa ciężarówka pojedzie do nich – bez zatrudniania i bez przewozu naczepy); inaczej w siedzibie
    const cm = crewModel(), crewAt = c => cm && cm.cities.find(x => sameCity(x.city, c));
    let city = lt ? lt.loc : ST.hq, truckTo = null;
    if (lone && !sameCity(lone.loc, ST.hq)) {
      const lc = crewAt(lone.loc);
      if (lc && cm.D >= cm.T + 1 && lc.spareDrivers.length && cm.W >= Math.min(cm.T, cm.R) + 1 && lc.workers.length > lc.pairs) city = truckTo = lone.loc;
    }
    const L = ST.licenses && ST.licenses.list;
    // Typy do wyboru: istniejąca naczepa albo typy z licencją + kolejny typ z licencją do zdobycia (gdy włączony Auto-rozwój)
    let types = lone ? [lone.type || 1] : licensedTypes();
    const nl = !lone && AP.autoExpandFleet ? nextLicense() : null;
    if (nl && !types.includes(nl)) types.push(nl);
    if (lt) types = types.filter(ty => ((TIERS[ty] || {}).hp || 200) <= (truckSpec(lt).hp || 999));
    // Ludzie do zestawu: wolny kierowca/pracownik w mieście zestawu (poza zestawami, które już tam są), ale tylko gdy
    // w całej firmie jest ich więcej, niż potrzeba po zakupie. Inaczej to np. kierowca zwolniony przy rozładunku,
    // którego ciężarówka jest jeszcze "Na trasie" – nowy zestaw zostałby bez kierowcy.
    const cc = crewAt(city);
    const newTrucks = lt ? 0 : 1;
    const spareDrv = cm && cc && cm.D >= cm.T + newTrucks ? cc.spareDrivers.slice().sort((a, b) => licOf(b) - licOf(a))[0] || null : null;
    const hireWorker = !(cm && cc && cm.W >= Math.min(cm.T, cm.R) + 1 && cc.workers.length > cc.pairs);
    const wrk = hireWorker ? bestOffer('worker') : null, drvOffer = bestOffer('driver');
    if (hireWorker && !wrk) return { ...out, why: 'brak danych o ofertach pracy (pracownik magazynu)' };
    if (hireWorker && wrkFree < 1) {
      if (whCanUp) whUp = true;
      else return { ...out, block: 'warehouse', why: `magazyn: limit pracowników magazynowych (${wh.workers.cap}) – więcej po ${wh.rented !== false ? 'kupnie i ' : ''}ulepszeniu magazynu` };
    }
    const whCost = whUp ? wh.upCost : 0;
    // Nowi ludzie mają zwykle wyższe stawki niż obecni (np. €50/1000 km zamiast €20) – różnica obniża zysk zestawu
    const lr = learn(), fph = c.kmh / Math.max(50, c.avgKm || 400);
    const wageW = wrk ? Math.max(0, (wrk.wage || 0) - lr.workerUnit) * fph * (AP.sendWorker ? 3 : 2) : 0;
    // Przewóz Transferio: naczepa do siedziby (do nowej ciężarówki), nowa naczepa z siedziby do ciężarówki
    // albo nowa ciężarówka do naczepy i ludzi (truckTo)
    const transfer = truckTo ? 600 : (lone && !sameCity(lone.loc, ST.hq)) || (lt && !sameCity(lt.loc, ST.hq)) ? 600 : 0;
    const typeOpts = types.map(t => {
      // Wolny kierowca na miejscu – co najwyżej egzaminy; nowy kierowca ma tylko podstawowe prawo jazdy
      const hireDriver = !spareDrv;
      const exams = examCost(spareDrv ? licOf(spareDrv) : 1, t);
      if (hireDriver && !drvOffer) return null;
      // Za mało miejsca w garażu (pojazdy albo kierowcy) – najpierw ulepszenie garażu (koszt doliczony do zestawu)
      const garageUp = vehNeed > vehFree || (hireDriver && drvFree < 1);
      if (garageUp && !(gar.canUpgrade && vehNeed <= vehFree + (gar.vehicles ? gar.vehicles.plus : 0))) return { t, blocked: true };
      const licCost = L && L[t] && L[t] !== 'done' && !g.trailers.some(x => (x.type || 1) === t) ? TIERS[t].licCompany : 0;
      const trailerCost = lone ? 0 : trailerPriceOf(t);
      if (!lone && !trailerCost) return null;
      const wageH = wageW + (hireDriver ? Math.max(0, (drvOffer.wage || 0) / 1000 - lr.driverPerKm) * c.kmh : 0);
      const upCost = garageUp ? gar.upCost : 0;
      const extras = trailerCost + licCost + exams + (hireDriver ? drvOffer.price : 0) + (wrk ? wrk.price : 0) + transfer + upCost + whCost;
      return { t, hireDriver, exams, licCost, trailerCost, wageH, extras, garageUp, upCost, gainT: typeGainH(t, c), src: (typeRevKm(t, c.avgKm || 450) || {}).src };
    }).filter(Boolean);
    if (typeOpts.length && typeOpts.every(o => o.blocked)) return { ...out, block: 'garage', why: `garaż pełny (${gar.vehicles ? gar.vehicles.cap : '?'} pojazdów) i nie da się go teraz ulepszyć` };
    typeOpts.splice(0, typeOpts.length, ...typeOpts.filter(o => !o.blocked));
    if (!typeOpts.length) return { ...out, why: 'brak danych o ofertach pracy albo cenach naczep' };
    // Wszystkie warianty (model × typ) z oceną: € na godzinę, koszt, zysk po 7 dniach
    const bad = AP.badModels || {};
    const options = [];
    // Kolejny zestaw zarabia tylko tyle, ile kursów bot zdąży obsłużyć (ubezpieczenie płacimy w całości)
    const room = botRoomFactor(c), INS = 400 / 24;
    const served = x => (x + INS) * room.f - INS;
    for (const o of typeOpts) {
      if (lt) {
        const sp = truckSpec(lt);
        const rate = served(modelRate({ kmPerL: 1 / sp.lPerKm, speed: sp.speed, tank: sp.tank }, c) + o.gainT) - o.wageH;
        options.push({ o, m: null, rate, total: o.extras });
        continue;
      }
      const hpNeed = (TIERS[o.t] || {}).hp || 200;
      // Zupełnie nowy zestaw liczony ostrożniej (85% średniej na zestaw) – kolejny zestaw rzadko jest tak samo zajęty
      const k = lone ? 1 : MARGINAL_SET;
      for (const m of Object.values(ST.models.list)) {
        if (!(m.price > 0 && m.kmPerL > 0 && m.hp >= hpNeed) || bad[m.id] > Date.now()) continue;
        options.push({ o, m, rate: served((modelRate(m, c) + o.gainT) * k) - o.wageH, total: m.price + o.extras });
      }
    }
    const good = options.filter(x => x.rate > 0).map(x => ({ ...x, week: x.rate * 168 - x.total })).sort((a, b) => b.week - a.week);
    if (!good.length) return { ...out, why: 'przy obecnych zyskach nowy zestaw nie zarobi na siebie' };
    // Kupić teraz to, na co nas stać, czy poczekać na lepszą opcję? Zysk po 7 dniach minus zarobek utracony
    // w czasie oczekiwania (z bieżącego tempa zarabiania firmy); dłużej niż 8 h nie czekamy
    const floor = investFloor(), money = (ST.balance ?? 0) - floor - committed();
    const ranked = good.map(x => {
      if (x.total <= money) return { x, h: 0, v: x.week };
      const h = c.income ? (x.total - money) / c.income : Infinity;
      return h <= 8 ? { x, h, v: x.week - x.rate * h } : null;
    }).filter(Boolean).sort((a, b) => b.v - a.v);
    const top = ranked[0] || null;
    const show = top ? top.x : good[0], o = show.o;
    const wait = top && top.h > 0 ? { h: top.h } : null;
    Object.assign(out, {
      city, type: o.t, licType: o.licCost ? o.t : null, licCost: o.licCost, hireDriver: o.hireDriver, hireWorker, exams: o.exams,
      transfer, trailerCost: o.trailerCost, extras: o.extras, wageH: o.wageH, gainT: o.gainT, typeSrc: o.src, ctx: c,
      garageUp: o.garageUp, upCost: o.upCost, whUp, whCost, truckTo, marginal: !lone && !lt, botF: room.f, botBusy: room.bl.busyPct,
      model: show.m ? show.m.id : null, m: show.m, rate: show.rate, total: show.total, payH: show.total / show.rate,
      wait, affordable: !!top && top.h === 0, alternatives: good.length,
      money, missing: Math.max(0, show.total - money), etaH: c.income ? Math.max(0, show.total - money) / c.income : null,
      runnerUp: good.find(x => x !== show && (x.m || {}).id !== (show.m || {}).id) || null
    });
    const label = `${show.m ? `model ${show.m.id} + ` : ''}${(TYPES[o.t] || '').toLowerCase()}${o.licCost ? ' (z licencją)' : ''}`;
    if (wait) out.why = `${good.some(x => x.total <= money) ? 'czekam na lepszą opcję' : 'zbieram na'}: ${label} – stać nas za ~${fmtDur(wait.h * 3600)}`;
    else if (!out.affordable) {
      const cheap = good.slice().sort((a, b) => a.total - b.total)[0];
      out.why = `brakuje ${fmt(cheap.total + floor - (ST.balance ?? 0))} (najtańsza opłacalna opcja ${fmt(cheap.total)}; zapas ${fmt(floor)})`;
    }
    return out;
  }

  // Decyzja: kupujemy, gdy stać nas ponad zapas, a inwestycja zwróci się w limicie z ⚙ (domyślnie 7 dni –
  // gotówka na koncie nic nie zarabia, a pojazd zarabia od pierwszego kursu)
  const maxPayH = () => (AP.maxPaybackH > 0 ? AP.maxPaybackH : 168);
  function newSetPlan() {
    if (!AP.autoNewSets || AP.newSet || isCool('newset')) return null;
    const p = expansionPlan();
    if (!(p.total > 0)) return null;   // brak danych albo nic się nie opłaca – ocena przy kolejnym przebiegu
    // Czekając na lepszą opcję, wracamy do decyzji, gdy powinno już na nią starczyć (najpóźniej za 10 min)
    setCool('newset', p.wait ? Math.max(60, Math.min(600, p.wait.h * 3600 + 30)) : 600);
    if (!p.affordable || !(p.payH <= maxPayH()) || !canSpend(p.total, 'invest')) return null;
    return p;
  }

  async function startNewSet() {
    const p = newSetPlan();
    if (!p) return false;
    const lt = p.loneTruck;
    AP.newSet = {
      step: p.licType ? 'company_license' : p.garageUp ? 'garage_upgrade' : p.whUp ? 'warehouse_upgrade' : lt ? 'buy_trailer' : 'buy_truck',
      licType: p.licType || null, licCost: p.licCost || 0,
      garageUp: !!p.garageUp, upCost: p.upCost || 0, whUp: !!p.whUp, whCost: p.whCost || 0,
      model: lt ? null : p.model, type: p.type, total: p.total, extras: p.extras, startedAt: Date.now(),
      truckId: lt ? lt.id : null, trailerId: p.lone ? p.lone.id : null, trailerName: p.lone ? p.lone.name : null, city: p.city,
      truckTo: p.truckTo || null,
      transfer: !!(p.lone && p.transfer && !p.truckTo), hireDriver: p.hireDriver, hireWorker: p.hireWorker, exams: p.exams || 0
    };
    const kind = (TYPES[p.type] || '').toLowerCase();
    const what = p.lone ? `ciężarówka do ${p.lone.name} (${kind}, ${p.lone.loc})` : lt ? `${kind} do ${lt.name} (${lt.loc})` : `ciężarówka + ${kind}`;
    const staff = [p.licType && `licencja ${TIERS[p.licType].name}`, p.garageUp && 'ulepszenie garażu', p.whUp && 'ulepszenie magazynu',
      p.truckTo && `przewóz ciężarówki do ${p.truckTo} (są tam wolni ludzie)`, p.hireDriver && 'kierowca', p.hireWorker && 'pracownik'].filter(Boolean).join(' + ');
    logEvent(`🏗 Nowy zestaw: ${what}${p.model && !lt ? ', model ' + p.model : ''}${staff ? ' + ' + staff : ''} (${fmt(p.total)}, ~${fmt(p.rate)}/h, zwrot ~${fmtDur(p.payH * 3600)})`);
    setStatus('🏗 Rozbudowa floty', `Nowy zestaw: ${what} (${fmt(p.total)}, zwrot ~${fmtDur(p.payH * 3600)}). ${p.licType ? 'Najpierw licencja firmy' : p.garageUp ? 'Najpierw ulepszenie garażu' : p.whUp ? 'Najpierw ulepszenie magazynu' : lt ? 'Kupuję naczepę' : 'Kupuję ciężarówkę'}...`);
    await humanDelay(0.6);
    await go(p.licType ? 'transportlicense' : p.garageUp || p.whUp ? 'properties' : lt ? 'trailerstore' : 'truckstore');
    return true;
  }

  // Naczepa do przewozu dla nowej ciężarówki: zaplanowana, a gdy ta w międzyczasie ruszyła w trasę –
  // inna stojąca nadwyżka (miasto, w którym stoi więcej naczep niż wolnych ciężarówek)
  function transferCandidate(s) {
    const g = ST.garage;
    if (!g) return null;
    const truck = unitById('truck', s.truckId);
    const hp = (truck && truckSpec(truck).hp) || 999;
    const idle = x => isIdleStatus(x.status) && !inService(x, 'trailer') && x.loc && !/na trasie|on route/i.test(x.loc);
    const fits = x => ((TIERS[x.type] || {}).hp || 200) <= hp;
    const planned = unitById('trailer', s.trailerId);
    if (planned && idle(planned) && fits(planned)) return planned;
    if (s.replaceTr) return null;   // wymiana naczepy: tylko ta nowo kupiona (zaczekamy, aż stanie)
    const spare = x => g.trailers.filter(y => idle(y) && sameCity(y.loc, x.loc)).length
      - g.trucks.filter(t => sameCity(t.loc, x.loc) && isIdleStatus(t.status) && String(t.id) !== String(s.truckId)).length;
    return g.trailers.filter(x => idle(x) && fits(x) && !sameCity(x.loc, s.city) && spare(x) > 0)
      .sort((a, b) => spare(b) - spare(a) || (a.type || 1) - (b.type || 1))[0] || null;
  }

  // Kroki budowy zestawu; zbędne są pomijane (naczepa już jest, przewóz niepotrzebny, ludzie już są).
  // Wymiana ciężarówki (replace): sprzedaż starej → zakup nowej → przewóz do miasta, w którym czekają naczepa i ludzie.
  // Ciężarówka do naczepy, przy której są wolni ludzie (truckTo): nowa ciężarówka jedzie do nich – bez zatrudniania.
  // Wymiana naczepy (replaceTr): licencja firmy → egzamin kierowcy → sprzedaż starej → zakup → sprawdzenie → przewóz do zestawu.
  const NS_STEPS = ['company_license', 'garage_upgrade', 'warehouse_upgrade', 'driver_exam', 'sell_old', 'buy_truck', 'verify_truck', 'buy_trailer', 'verify_trailer',
    'transfer_trailer', 'transfer_truck', 'hire_driver', 'hire_worker', 'done'];
  const NS_PL = {
    company_license: 'licencja firmy', garage_upgrade: 'ulepszenie garażu', warehouse_upgrade: 'ulepszenie magazynu', driver_exam: 'egzamin kierowcy', sell_old: 'sprzedaż starego pojazdu',
    buy_truck: 'zakup ciężarówki', verify_truck: 'sprawdzam zakup w garażu', buy_trailer: 'zakup naczepy', verify_trailer: 'sprawdzam zakup naczepy',
    transfer_trailer: 'przewóz naczepy', transfer_truck: 'przewóz ciężarówki', hire_driver: 'zatrudnienie kierowcy', hire_worker: 'zatrudnienie pracownika', done: 'gotowe'
  };
  function newSetAdvance(s) {
    const R = !!s.replace, R2 = !!s.replaceTr;
    const need = {
      garage_upgrade: !!s.garageUp && !s.garageDone, warehouse_upgrade: !!s.whUp && !s.whDone, driver_exam: !!s.examDriver && !s.examDone,
      sell_old: (R || R2) && !s.soldOld,
      buy_truck: !R2 && !s.truckId, verify_truck: !R2 && !s.truckId, buy_trailer: !R && !s.trailerId, verify_trailer: !R && !s.trailerId, transfer_trailer: !!s.transfer,
      transfer_truck: !!s.truckTo && !s.truckMoved,
      hire_driver: !R && !R2 && s.hireDriver !== false, hire_worker: !R && !R2 && s.hireWorker !== false, done: true
    };
    let i = NS_STEPS.indexOf(s.step) + 1;
    while (i < NS_STEPS.length - 1 && !need[NS_STEPS[i]]) i++;
    s.step = NS_STEPS[i] || 'done';
  }
  function newSetDone() {
    const s = AP.newSet;
    AP.newSet = null;
    AP.stats.investments = (AP.stats.investments || 0) + 1;
    // Kontrola po budowie: zestaw musi mieć kierowcę z uprawnieniami i pracownika – brak uzupełnią Kadry
    const gaps = s && s.city ? crewGaps().filter(x => sameCity(x.city, s.city)) : [];
    const miss = [...new Set(gaps.map(x => x.kind === 'license' ? 'uprawnienia kierowcy' : ROLE_PL[x.kind]))];
    const tr = s && s.replaceTr && unitById('trailer', s.trailerId);
    logEvent((s && s.replace ? `🔄 Wymiana ${s.replace.name} zakończona – nowa ciężarówka (model ${s.model}) dojeżdża do ${s.city}`
      : s && s.replaceTr ? `🔄 Wymiana ${s.replaceTr.name} zakończona – ${tr ? tr.name : 'nowa naczepa'} (${(TYPES[s.type] || '').toLowerCase()}) ${s.transfer ? 'jedzie do' : 'stoi w'} ${s.city}`
      : `🏗 Nowy zestaw gotowy${s && s.city ? ' w ' + s.city : ''}`) +
      (miss.length ? ` – brakuje: ${miss.join(', ')} (uzupełnię)` : s && (s.replace || s.replaceTr) ? '' : ' – tankowanie i pierwsze zlecenie'));
  }

  // Zakup sprawdzamy w garażu (nowe id). Wcześniej nieudany zakup ciężarówki kończył się samą naczepą bez ciągnika.
  // true = potwierdzony, null = jeszcze nie widać (sprawdzę przy kolejnym przebiegu), false = przerwane
  async function newSetVerify(s) {
    const kind = s.step === 'verify_truck' ? 'truck' : 'trailer';
    const v = s.verify;
    if (!v) { newSetAdvance(s); return true; }
    await refreshGarage();
    const g = ST.garage;
    const fresh = g && g[kind + 's'].find(u => !v.before.includes(String(u.id)));
    if (fresh) {
      delete s.verify;
      if (kind === 'truck') {
        s.truckId = fresh.id;
        // Zestaw składamy tam, gdzie stoi nowa ciężarówka (zwykle siedziba) – chyba że ma pojechać do naczepy i ludzi
        if (s.truckTo) s.truckMoved = sameCity(fresh.loc, s.truckTo);
        else if (fresh.loc && !/na trasie|on route/i.test(fresh.loc)) s.city = fresh.loc;
      } else s.trailerId = fresh.id;
      const tr = unitById('trailer', s.trailerId);
      s.transfer = !!(tr && s.city && !sameCity(tr.loc, s.city));
      logEvent(`🏗 Kupiono: ${fresh.name}${fresh.loc ? ' (' + fresh.loc + ')' : ''}`);
      newSetAdvance(s);
      return true;
    }
    v.tries = (v.tries || 0) + 1;
    s.verify = v;
    if (v.tries < 3 && Date.now() - v.t < 3 * 60000) return null;
    AP.newSet = null;
    setCool('newset', 30 * 60);
    if (kind === 'truck') AP.badModels = { ...(AP.badModels || {}), [s.model]: Date.now() + 6 * 3600000 };
    logEvent(`⚠️ Zakup ${kind === 'truck' ? 'ciężarówki (model ' + s.model + ')' : 'naczepy'} nie pojawił się w garażu – przerywam budowę zestawu`);
    return false;
  }

  async function resumeNewSet() {
    const s = AP.newSet;
    if (!s) return false;
    if (s.lastStep !== s.step) { s.lastStep = s.step; s.visits = 0; }
    s.visits = (s.visits || 0) + 1;
    if (s.visits > 6 || Date.now() - (s.startedAt || 0) > 60 * 60000) {
      AP.newSet = null;
      logEvent('⚠️ Budowa nowego zestawu przerwana (limit prób)');
      return false;
    }
    if (s.step === 'verify_truck' || s.step === 'verify_trailer') {
      const ok = await newSetVerify(s);
      if (!ok) { await saveAP(); return false; }
      return resumeNewSet();
    }
    if (s.step === 'company_license') { await go('transportlicense'); return true; }
    if (s.step === 'garage_upgrade' || s.step === 'warehouse_upgrade') { await go('properties'); return true; }
    if (s.step === 'driver_exam') {
      // Uprawnienia na nowy typ naczepy dla kierowcy z miasta zestawu – zanim cokolwiek sprzedamy
      const d = ((ST.employees && ST.employees.list) || []).find(e => String(e.id) === String(s.examDriver));
      if (!d) {
        AP.newSet = null;
        setCool('renew', 60 * 60);
        logEvent('⚠️ Wymiana naczepy przerwana – kierowcy do egzaminu już nie ma (nic nie sprzedano)');
        return false;
      }
      if (licOf(d) >= s.type) { s.examDone = true; newSetAdvance(s); return resumeNewSet(); }
      AP.licenseTask = { driverId: String(d.id), targetTier: s.type, t: Date.now(), newSet: true };
      setCool('lic:' + d.id, 30 * 60);
      setStatus('🔄 Wymiana naczepy', `${d.name}: egzamin na ${TIERS[s.type].name} – zanim sprzedam ${s.replaceTr ? s.replaceTr.name : 'starą naczepę'}...`);
      await humanDelay(0.5);
      await go('employees_upgrade', { e: d.id });
      return true;
    }
    if (s.step === 'sell_old' && s.replaceTr) {
      // Stara naczepa musi stać w mieście (bez nowych tras od startu wymiany); w trasie albo w serwisie – czekamy
      const old = unitById('trailer', s.replaceTr.id);
      if (!old) { s.soldOld = true; newSetAdvance(s); return resumeNewSet(); }
      if (onRoute(old.loc) || !isIdleStatus(old.status) || inService(old, 'trailer')) { s.visits--; return false; }
      s.city = old.loc;
      AP.sellTask = { kind: 'trailer', id: String(old.id), name: old.name, plan: 'renew', why: `wymiana na nową naczepę (${(TYPES[s.type] || '').toLowerCase()})` };
      setStatus('🔄 Wymiana naczepy', `${old.name} (${old.loc}) – sprzedaję dealerowi i kupuję nową (${(TYPES[s.type] || '').toLowerCase()})...`);
      await humanDelay(0.5);
      await go('garage_trailer', { t: old.id });
      return true;
    }
    if (s.step === 'sell_old') {
      // Stara ciężarówka musi stać w mieście (jest wstrzymana dla nowych tras); w trasie – czekamy, aż wróci
      const old = unitById('truck', s.replace.id);
      if (!old) { s.soldOld = true; newSetAdvance(s); return resumeNewSet(); }
      if (onRoute(old.loc) || !isIdleStatus(old.status) || inService(old)) { s.visits--; return false; }
      s.city = s.truckTo = old.loc;
      AP.sellTask = { kind: 'truck', id: String(old.id), name: old.name, plan: 'renew', why: `wymiana na model ${s.model}` };
      setStatus('🔄 Wymiana ciężarówki', `${old.name} (${old.loc}) – sprzedaję dealerowi i kupuję model ${s.model}...`);
      await humanDelay(0.5);
      await go('garage_truck', { t: old.id });
      return true;
    }
    if (s.step === 'buy_truck') { await go('truckstore'); return true; }
    if (s.step === 'transfer_truck') {
      const tr = unitById('truck', s.truckId);
      if (tr && sameCity(tr.loc, s.truckTo)) { s.truckMoved = true; newSetAdvance(s); return resumeNewSet(); }
      if (!tr || onRoute(tr.loc) || !isIdleStatus(tr.status)) { s.visits--; return false; }
      AP.moveTask = { kind: 'truck', id: String(tr.id), name: tr.name, from: tr.loc, to: s.truckTo, why: s.replace ? `zamiast ${s.replace.name}` : 'do naczepy i ludzi', plan: 'newset', t: Date.now() };
      setStatus('🏗 Rozbudowa floty', `Przewożę ${tr.name} z ${tr.loc} do ${s.truckTo} (Transferio €600)...`);
      await humanDelay(0.5);
      await go('truck_transfer', { t: tr.id });
      return true;
    }
    if (s.step === 'buy_trailer') { await go('trailerstore'); return true; }
    if (s.step === 'transfer_trailer') {
      const planned = unitById('trailer', s.trailerId);
      if (planned && sameCity(planned.loc, s.city)) { newSetAdvance(s); return resumeNewSet(); }
      const tr = transferCandidate(s);
      // Naczepa w serwisie albo w drodze – przewóz, gdy stanie (nie liczymy tego jako nieudanej próby)
      if (!tr) { s.visits--; return false; }
      if (String(tr.id) !== String(s.trailerId)) {
        logEvent(`🏗 Zamiast ${s.trailerName || 'zaplanowanej naczepy'} (w użyciu) przewiozę ${tr.name} z ${tr.loc}`);
        Object.assign(s, { trailerId: tr.id, trailerName: tr.name, type: tr.type || 1 });
      }
      setStatus('🏗 Rozbudowa floty', `Przewożę ${tr.name} z ${tr.loc} do ${s.city} (Transferio €600)...`);
      await humanDelay(0.5);
      await go('garage_trailer', { t: tr.id });
      return true;
    }
    if (s.step === 'hire_driver' || s.step === 'hire_worker') {
      const role = s.step === 'hire_driver' ? 'driver' : 'worker';
      const city = s.city || ST.hq || null;
      // Ktoś już jest na miejscu (np. Kadry zdążyły zatrudnić) – nie dublujemy; liczymy świeże dane: zestawy w mieście
      // i całą firmę (wcześniej chwilowo wolny kierowca innego zestawu wystarczał, żeby pominąć zatrudnienie)
      await refreshData(15000);
      if (city && crewCovered(role, city)) {
        logEvent(`🏗 Nowy zestaw w ${city}: ${ROLE_PL[role]} już jest na miejscu – bez zatrudniania`);
        newSetAdvance(s);
        return resumeNewSet();
      }
      AP.hireTask = { role, city, why: 'nowy zestaw', lic: role === 'driver' ? s.type : 0, newSet: true };
      setStatus('🏗 Rozbudowa floty', `Nowy zestaw: zatrudniam ${ROLE_PL[role]} w ${city || 'siedzibie'}...`);
      await humanDelay(0.5);
      await go('employees_hire', { type: HIRE_FORMS[role].type });
      return true;
    }
    newSetDone();
    await saveAP();
    return false;
  }

  // Przewóz naczepy Transferio (€600): w ramach Auto-rozwoju (nowa naczepa do ciężarówki), nowego zestawu
  // albo porządku floty (naczepa bez pary do ciężarówki bez pary w innym mieście)
  function transferJob() {
    const inv = AP.investState;
    if (inv && inv.step === 'transfer_trailer') return { kind: 'invest', city: inv.truckCity, trailerId: null };
    const s = AP.newSet;
    if (s && s.step === 'transfer_trailer') return { kind: 'newset', city: s.city || ST.hq, trailerId: s.trailerId };
    const mt = AP.moveTask;
    if (mt && mt.kind === 'trailer') return { kind: 'move', city: mt.to, trailerId: mt.id };
    return null;
  }
  function transferCancel(job, why) {
    if (job.kind === 'invest') AP.investState = null;
    else if (job.kind === 'move') { setCool('move:trailer:' + AP.moveTask.id, 30 * 60); AP.moveTask = null; }
    else AP.newSet = null;
    logEvent(`⚠️ Transferio: ${why}`);
  }

  // Formularz (POST) przeładowuje stronę – czekamy na to; wcześniejsze przejście gdzie indziej potrafiło przerwać wysyłkę
  async function submitAndWait(btn, ms = 8000) {
    await humanClick(btn);
    await sleep(ms);
  }

  // ---------- Porządek floty: wykonanie (przewozy, budynki, zwolnienia, sprzedaż) ----------
  async function startMove(p) {
    const u = p.unit;
    AP.moveTask = { kind: p.kind, id: String(u.id), name: u.name, from: u.loc, to: p.to, why: p.why, gapKey: p.gapKey || null, t: Date.now() };
    setCool(`move:${p.kind}:${u.id}`, 10 * 60);
    const how = p.kind === 'emp' ? 'taksówka' : 'Transferio €600';
    setStatus('🚚 Porządek floty', `${u.name}: ${u.loc} → ${p.to} (${how}) – ${p.why}...`);
    await humanDelay(0.5);
    return go(p.kind === 'emp' ? 'employees_transfer' : p.kind === 'truck' ? 'truck_transfer' : 'trailer_transfer', p.kind === 'emp' ? { e: u.id } : { t: u.id });
  }
  async function startUpgrade(p) {
    AP.upgradeTask = { building: p.building, why: p.why, t: Date.now() };
    setCool('upgrade:' + p.building, 30 * 60);
    setStatus('🏢 Budynki', `${p.why} – ulepszam ${p.building === 'garage' ? 'garaż' : 'magazyn'} (${fmt(p.cost)})...`);
    await humanDelay(0.5);
    return go('properties');
  }
  async function startFire(p) {
    AP.fireTask = { id: String(p.unit.id), name: p.unit.name, why: p.why, t: Date.now() };
    setCool('fire:' + p.unit.id, 6 * 3600);
    setStatus('🧑‍💼 Kadry', `${p.unit.name}: zwalniam – ${p.why}...`);
    await humanDelay(0.5);
    return go('employees_select', { e: p.unit.id });
  }

  // Przycisk z potwierdzeniem gry ("Tak" / "Tak, chcę zwolnić…"): klik, a potem przycisk zatwierdzenia w okienku.
  // Gdy okienko się nie pojawi – to samo działanie strony wprost (fallback), żeby nie klikać w ciemno w kółko
  async function confirmClick(trigger, fallback) {
    const okLabel = norm(trigger.getAttribute('data-btn-ok-label') || 'Tak');
    await humanClick(trigger);
    let okBtn = null;
    await waitFor(() => (okBtn = [...document.querySelectorAll('.popover a, .popover button, [data-apply="confirmation"]')]
      .find(b => b !== trigger && !b.closest('#ltd-panel') && b.offsetParent !== null && (norm(txt(b)) === okLabel || b.matches('[data-apply="confirmation"]'))) || null), 2500, 100);
    if (okBtn) { await sleep(rand(250, 500)); await humanClick(okBtn); return 'popup'; }
    await fallback();
    return 'direct';
  }

  // Sprzedaż dealerowi (strona pojazdu): tylko pojazd stojący w mieście, bez ładunku; wynik sprawdzamy w garażu
  async function sellUnit(task) {
    if (!checkSafety()) return;
    const kind = task.kind;
    await refreshGarage();
    const u = unitById(kind, task.id);
    const fail = async why => {
      AP.sellTask = null;
      setCool(`sell:${kind}:${task.id}`, 6 * 3600);
      if (task.plan === 'renew' && AP.newSet && (AP.newSet.replace || AP.newSet.replaceTr)) { AP.newSet = null; setCool('renew', 6 * 3600); }
      logEvent(`⚠️ Sprzedaż ${task.name}: ${why}`);
      await saveAP();
      return go('warehouse');
    };
    const sold = async () => {
      AP.sellTask = null;
      logEvent(`💸 Sprzedano dealerowi: ${task.name}${task.value ? ` (${fmt(task.value)})` : ''} – ${task.why}`);
      notify('LogiTycoon: sprzedaż', `${task.name}${task.value ? ` za ${fmt(task.value)}` : ''} – ${task.why}`);
      const s = AP.newSet;
      const old = s && (s.replace || s.replaceTr);
      if (task.plan === 'renew' && old && String(old.id) === String(task.id)) {
        s.soldOld = true;
        newSetAdvance(s);
        await saveAP();
        if (await resumeNewSet()) return;
      }
      await saveAP();
      return go('warehouse');
    };
    if (!u) return task.sent ? sold() : fail('pojazdu nie ma już w garażu');
    if (onRoute(u.loc) || !isIdleStatus(u.status) || inService(u, kind)) {
      // w trasie / w serwisie – spróbujemy, gdy stanie (zadanie zostaje)
      setStatus('💸 Sprzedaż', `${task.name} jest teraz zajęta – sprzedam, gdy stanie w mieście...`);
      await humanDelay(0.5);
      return go('warehouse');
    }
    const form = document.getElementById(kind === 'truck' ? 'selltruck' : 'selltrailer');
    const btn = form && form.querySelector('button[type="submit"]');
    if (!form || !btn) return fail('nie znalazłem przycisku "Sprzedaj dealerowi"');
    if (btn.disabled) return fail('przycisk sprzedaży jest nieaktywny');
    task.value = parseMoney(btn.getAttribute('data-msgtext') || '') || u.value || null;
    if ((task.tries || 0) >= 2) return fail('gra nie potwierdza sprzedaży');
    task.tries = (task.tries || 0) + 1;
    task.sent = Date.now();
    await saveAP();
    setStatus('💸 Sprzedaż', `${task.name} – sprzedaję dealerowi${task.value ? ` za ${fmt(task.value)}` : ''} (${task.why})...`);
    await humanDelay(0.6);
    await confirmClick(btn, async () => { form.requestSubmit ? form.requestSubmit(btn) : form.submit(); });
    await sleep(2500);
    await refreshGarage();
    if (!unitById(kind, task.id)) return sold();
    await saveAP();
    return go(kind === 'truck' ? 'garage_truck' : 'garage_trailer', { t: task.id });   // jeszcze raz (najwyżej 2 próby)
  }

  // Zwolnienie (strona pracownika): tylko gdy nie jest przy ładunku; wynik sprawdzamy na liście pracowników
  async function fireEmployee(task) {
    if (!checkSafety()) return;
    await refreshEmployees();
    const e = ((ST.employees && ST.employees.list) || []).find(x => String(x.id) === String(task.id));
    const done = async ok => {
      AP.fireTask = null;
      if (ok) {
        logEvent(`🧑‍💼 Zwolniono: ${task.name} – ${task.why}`);
        notify('LogiTycoon: zwolnienie', `${task.name} – ${task.why}`);
      } else logEvent(`⚠️ Zwolnienie ${task.name} nie przeszło`);
      await saveAP();
      return go('warehouse');
    };
    if (!e) return done(!!task.sent);
    if (e.freight || !isIdleStatus(e.action)) { setStatus('🧑‍💼 Kadry', `${task.name} jest zajęty – zwolnienie później...`); await humanDelay(0.5); return go('warehouse'); }
    if (task.sent) return done(false);
    const btn = document.querySelector('button[data-successjs^="employee_fire"]');
    if (!btn) return done(false);
    task.sent = Date.now();
    await saveAP();
    setStatus('🧑‍💼 Kadry', `Zwalniam ${task.name} – ${task.why}...`);
    await humanDelay(0.6);
    await confirmClick(btn, async () => {
      // to samo, co robi przycisk gry po potwierdzeniu (employee_fire)
      try {
        await fetch(new URL('ajax/employees_fire.php', location.href).href, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
          body: 'employee=' + encodeURIComponent(task.id)
        });
      } catch (err) { console.warn('[LTD] zwolnienie', err); }
    });
    await sleep(2500);
    await refreshEmployees();
    return done(!((ST.employees && ST.employees.list) || []).some(x => String(x.id) === String(task.id)));
  }

  // --- Krok Przeniesienie pracownika (taksówka, €3/100 km) ---
  async function apHandleEmployeeTransfer() {
    if (!checkSafety()) return;
    const t = AP.moveTask;
    if (!t || t.kind !== 'emp' || String(t.id) !== String(urlParam('e'))) return go('warehouse');
    const fail = async why => {
      AP.moveTask = null;
      setCool('move:emp:' + t.id, 30 * 60);
      logEvent(`🚕 ${t.name}: przeniesienie niemożliwe – ${why}`);
      await humanDelay(0.6);
      return go('warehouse');
    };
    const form = document.getElementById('transferemployee');
    const sel = form && form.querySelector('select[name="city"]');
    const btn = form && form.querySelector('#submit-transfer, button[type="submit"]');
    if (!form || !sel || !btn) return fail('nie znalazłem formularza');
    const opt = [...sel.options].find(o => o.value && sameCity(o.text.replace(/\(.*?\)/, ''), t.to));
    if (!opt) return fail(`nie ma miasta ${t.to} na liście`);
    if (!canSpend(200, 'ops')) return fail('za mało pieniędzy na taksówkę');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await humanDelay(0.8);
    // Zapis przed kliknięciem: po udanym przeniesieniu gra sama przechodzi na stronę pracownika
    AP.moveTask = null;
    addMove('emp', { id: t.id, name: t.name, loc: t.from }, t.to, t.why);
    if (t.gapKey && AP.gap) delete AP.gap[t.gapKey];
    logEvent(`🚕 ${t.name}: ${t.from} → ${t.to} (taksówka) – ${t.why}`);
    await saveAP();
    setStatus('🚕 Przeniesienie', `${t.name}: ${t.from} → ${t.to} (taksówka) – ${t.why}...`);
    const r = await act(btn, { timeout: 8000 });
    if (r.error) {
      delete AP.moves['emp:' + t.id];
      return fail(r.error);
    }
    await refreshEmployees();
    return go('warehouse');
  }

  // --- Krok Przeniesienie ciężarówki (Transferio €600) – porządek floty albo nowy zestaw / wymiana ---
  async function apHandleTruckTransfer() {
    if (!checkSafety()) return;
    const t = AP.moveTask;
    if (!t || t.kind !== 'truck' || String(t.id) !== String(urlParam('t'))) {
      if (AP.newSet && await resumeNewSet()) return;
      return go('warehouse');
    }
    const fail = async why => {
      AP.moveTask = null;
      setCool('move:truck:' + t.id, 30 * 60);
      if (t.plan === 'newset') AP.newSet = null;
      logEvent(`⚠️ Transferio: ${t.name} – ${why}`);
      await humanDelay(0.6);
      return go('warehouse');
    };
    const sel = document.querySelector('select[name="city"]');
    const btn = document.querySelector('button[name="transfer"]');
    if (!sel || !btn) return fail('nie znalazłem formularza przewozu');
    const opt = [...sel.options].find(o => o.value && sameCity(o.text.replace(/\(.*?\)/, ''), t.to));
    if (!opt) return fail(`nie ma miasta ${t.to} na liście`);
    if (!canSpend(600, 'ops')) return fail('za mało pieniędzy na przewóz (€600)');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await humanDelay(0.5);
    const dur = hms((opt.text.match(/\d{1,2}:\d{2}:\d{2}/) || [])[0]);
    // Zapis przed wysłaniem: formularz przeładowuje stronę
    addMove('truck', { id: t.id, name: t.name, loc: t.from }, t.to, t.why, Number.isFinite(dur) ? dur : null);
    AP.moveTask = null;
    if (t.plan === 'newset' && AP.newSet) { AP.newSet.truckMoved = true; newSetAdvance(AP.newSet); }
    logEvent(`🚚 Transferio: ${t.name} jedzie do ${t.to}${Number.isFinite(dur) ? ` (${fmtDur(dur)})` : ''} – ${t.why}`);
    await saveAP();
    setStatus('🚚 Transferio', `Zatwierdzam przewóz ${t.name} do ${t.to}...`);
    await submitAndWait(btn);
    if (AP.newSet && await resumeNewSet()) return;
    return go('warehouse');
  }

  // --- Ulepszenie budynku (garaż: pojazdy + kierowcy, magazyn: ładunki + pracownicy) – sprawdzane po poziomie ---
  async function buildingUpgrade(building, onDone, onFail, money = 'tires') {
    readProperties(document);
    const b = (ST.props && ST.props[building]) || {};
    const job = building === 'garage' ? 'garLevelBefore' : 'whLevelBefore', tries = building + 'Tries';
    const st = AP.upgradeTask && AP.upgradeTask.building === building ? AP.upgradeTask : AP.newSet;
    if (st && st[job] != null && b.level > st[job]) return onDone(b);
    const btn = document.querySelector(`button[onclick^="${building}upgrade"]`);
    const name = building === 'garage' ? 'garaż' : 'magazyn';
    if ((st[tries] || 0) >= 2) return onFail(`ulepszenie (${name}) nie przechodzi`);
    if (b.rented) return onFail(`${name} jest wynajmowany – najpierw trzeba go kupić`);
    if (!btn || btn.disabled) return onFail(`${name} – ulepszenie teraz niedostępne`);
    if (!canSpend(b.upCost || 0, money)) return onFail(`za mało pieniędzy na ulepszenie (${name}, ${fmt(b.upCost)})`);
    st[tries] = (st[tries] || 0) + 1;
    st[job] = b.level;
    await saveAP();   // gra może przeładować stronę – licznik prób i poziom sprzed ulepszenia muszą być zapisane
    setStatus('🏢 Budynki', `Ulepszam ${name}: poziom ${b.level} → ${b.level + 1} (${fmt(b.upCost)})...`);
    await humanDelay(0.6);
    const r = await act(btn);
    if (r.error) return onFail(r.error);
    await sleep(1200);
    return go('properties');
  }

  // Sprzedaż / zwolnienie zlecone wcześniej: sprawdzenie wyniku (strona mogła się przeładować w trakcie)
  function checkPendingActions() {
    const now = Date.now();
    const f = AP.fireTask;
    if (f && f.sent) {
      const still = ((ST.employees && ST.employees.list) || []).some(x => String(x.id) === String(f.id));
      if (!still) { logEvent(`🧑‍💼 Zwolniono: ${f.name} – ${f.why}`); AP.fireTask = null; }
      else if (now - f.sent > 3 * 60000) { logEvent(`⚠️ Zwolnienie ${f.name} nie przeszło`); AP.fireTask = null; }
    } else if (f && now - f.t > 30 * 60000) AP.fireTask = null;
    const s = AP.sellTask;
    if (s && !s.plan && now - (s.t || now) > 6 * 3600000) AP.sellTask = null;
    const u = AP.upgradeTask;
    if (u && now - u.t > 20 * 60000) AP.upgradeTask = null;
    const mt = AP.moveTask;
    if (mt && now - mt.t > 10 * 60000) AP.moveTask = null;
  }

  // Wymiana słabej ciężarówki na lepszy model: zysk na godzinę z różnicy spalania, zużycia (stara ciężarówka – stawka
  // z prognoz gry) i prędkości; koszt = cena nowej − wartość starej u dealera + przewóz Transferio + ~15 min postoju zestawu.
  // Tylko gdy zwrot mieści się w limicie z ⚙; ciężarówka nie słabsza niż stara (uciągnie te same naczepy).
  function renewPlan() {
    const g = ST.garage, c = setRateCtx();
    if (!g || !c || !ST.models || !ST.models.list || !ST.hq) return null;
    const bad = AP.badModels || {};
    const models = Object.values(ST.models.list).filter(m => m.price > 0 && m.kmPerL > 0 && !(bad[m.id] > Date.now()));
    const youngW = youngWearKm('truck');
    let best = null;
    for (const t of g.trucks) {
      if (!(t.value > 0) || heldTruck(t) || isCool('sell:truck:' + t.id)) continue;
      const sp = truckSpec(t), wearOld = wearCost(t, 'truck', 100).v / 100;
      // Stara ciężarówka z Maksymalnym dystansem krótszym niż typowa trasa zarabia proporcjonalnie mniej (limit maleje z wiekiem)
      const mx = maxKmOf(t, 'truck'), reach = mx > 0 && c.avgKm > 0 ? Math.min(1, mx / c.avgKm) : 1;
      const rateOld = modelRate({ kmPerL: 1 / sp.lPerKm, speed: sp.speed, tank: sp.tank }, c, wearOld) * reach;
      for (const m of models) {
        if (m.hp < (sp.hp || 0) || String(m.id) === String(t.model)) continue;
        // zużycie nowej ciężarówki: z prognoz gry dla najmłodszych ciężarówek floty (wcześniej zakładane €0,02/km)
        const gain = modelRate(m, c, youngW) - rateOld;
        if (!(gain > 0)) continue;
        const cost = m.price - t.value + 600 + Math.max(0, rateOld) * 0.25;
        const payH = cost / gain, week = gain * 168 - cost;
        if (!best || week > best.week) best = { t, m, gain, cost, payH, week, rateOld };
      }
    }
    return best;
  }

  // Zużycie €/km nowego pojazdu danego rodzaju: z prognoz gry dla najmłodszych pojazdów floty (do 3 lat), inaczej
  // szacunek z modelu kondycji (€10 za 1% × 100% / ~4.100 km nowego pojazdu ≈ €0,25/km)
  function youngWearKm(kind) {
    const g = ST.garage, list = g ? (kind === 'truck' ? g.trucks : g.trailers) : [];
    const v = list.filter(u => Number.isFinite(u.age) && u.age < 3).map(u => wearCost(u, kind, 100)).filter(w => w.src === 'gra').map(w => w.v / 100).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0.25;
  }
  // Naczepa czekająca na wymianę (sprzedaż) – bez nowych tras
  function heldTrailer(t) {
    const ns = AP.newSet;
    return !!(ns && ns.replaceTr && !ns.soldOld && String(ns.replaceTr.id) === String(t.id));
  }
  // Wymiana naczepy na nową – tego samego typu, wyższego albo niższego. Zysk na godzinę: mniejsze zużycie €/km,
  // dłuższy Maksymalny dystans (stara z wiekiem skraca trasy – zestaw zarabia mniej, gdy limit jest krótszy niż typowa
  // trasa; liczony średnio na najbliższą dobę) i stawki typu. Koszt: nowa − sprzedaż starej + Transferio + licencja firmy
  // (gdy typ nowy) + egzaminy kierowcy z tego miasta (gdy nikt tam nie ma uprawnień) + postój.
  // Warunki: znana cena w salonie, ciężarówka w mieście z mocą na ten typ, kierowca w mieście, licencja dostępna.
  function renewTrailerPlan() {
    const g = ST.garage, c = setRateCtx();
    if (!g || !c || !ST.trailerShop || !ST.trailerShop.list || !ST.hq || !ST.licenses || !ST.company) return null;
    const L = ST.licenses.list || {}, lvl = ST.company.level;
    const emps = (ST.employees && ST.employees.list) || [];
    const rateSet = Math.max(0, c.kmh * c.basePerKm), Lkm = c.avgKm || 450;
    const wearNew = youngWearKm('trailer');
    let best = null;
    for (const t of g.trailers) {
      if (!(t.value > 0) || !t.loc || onRoute(t.loc) || !isIdleStatus(t.status) || inService(t, 'trailer') || isCool('sell:trailer:' + t.id)) continue;
      const T0 = t.type || 1;
      const trucks = g.trucks.filter(x => sameCity(x.loc, t.loc));
      const drivers = emps.filter(e => e.role === 'driver' && e.id && sameCity(e.loc, t.loc));
      if (!trucks.length || !drivers.length) continue;   // naczepa bez zestawu – to sprawa planu zestawów i Kadr
      // wyższy typ: moc musi mieć każda ciężarówka w mieście (inaczej nowa naczepa zabrałaby ciągnik innemu zestawowi)
      const hpMin = Math.min(...trucks.map(x => truckSpec(x).hp || 0));
      const wearOld = wearCost(t, 'trailer', 100).v / 100;
      const mx = maxKmOf(t, 'trailer'), info = ST.unitInfo && ST.unitInfo['trailer' + t.id];
      const mxSoon = mx > 0 ? Math.max(0, mx - ((info && info.slope) || AGE_KM_DAY) * 0.5) : null;
      const reachOld = mxSoon != null ? Math.min(1, mxSoon / Lkm) : 1;
      const d = drivers.slice().sort((a, b) => licOf(b) - licOf(a))[0];
      for (const T of Object.keys(TIERS).map(Number)) {
        const tier = TIERS[T], shop = ST.trailerShop.list[T];
        if (!(shop && shop.price > 0) || (T > T0 && (tier.hp || 200) > hpMin)) continue;
        const lic = T === 1 || g.trailers.some(x => (x.type || 1) === T) ? 'done' : L[T];
        if (lic !== 'done' && !(lic === 'exam' && !(lvl != null && lvl < tier.level))) continue;
        const licCost = lic === 'done' ? 0 : tier.licCompany;
        const exams = licOf(d) >= T ? 0 : examCost(licOf(d), T);
        const typeGain = T === T0 ? 0 : typeGainH(T, c) - typeGainH(T0, c);
        const gain = c.kmh * (wearOld - wearNew) + rateSet * (1 - reachOld) + typeGain;
        if (!(gain > 0)) continue;
        const transfer = sameCity(t.loc, ST.hq) ? 0 : 600;
        const money = shop.price - t.value + transfer + licCost + exams;
        const cost = money + rateSet * 0.25;
        const payH = cost / gain, week = gain * 168 - cost;
        if (!best || week > best.week) best = { kind: 'trailer', t, T, T0, price: shop.price, licCost, exams, driver: exams ? d : null, transfer, money, gain, cost, payH, week, mx, reachOld, wearOld, wearNew };
      }
    }
    return best;
  }
  const renewTrailerTitle = r => `Wymiana: ${r.t.name} (${(TYPES[r.T0] || '').toLowerCase()}, ${Number.isFinite(r.t.age) ? String(r.t.age).replace('.', ',') + ' lat' : 'wiek ?'}` +
    `${r.mx ? `, maks. dystans ${r.mx} km` : ''}, zużycie ~€${r.wearOld.toFixed(2).replace('.', ',')}/km, sprzedaż ~${fmt(r.t.value)}) → nowa ${(TYPES[r.T] || '').toLowerCase()}` +
    `${r.licCost ? ` + licencja ${TIERS[r.T].name}` : ''}${r.exams ? ` + egzamin kierowcy ${r.driver.name}` : ''}`;

  // Start wymiany: gdy zwrot w limicie, stać nas (ponad zapas) i nie ma lepszej inwestycji (szybszy zwrot nowego zestawu)
  async function startRenew() {
    if (!AP.autoRenew || !AP.autoNewSets || AP.newSet || AP.investState || AP.sellTask || isCool('renew')) return false;
    setCool('renew', 10 * 60);
    // Ciężarówka albo naczepa – która wymiana da więcej po tygodniu (obie w limicie zwrotu)
    const r = [renewPlan(), renewTrailerPlan()].filter(x => x && x.payH <= maxPayH()).sort((a, b) => b.week - a.week)[0];
    if (!r) return false;
    const xp = expansionPlan();
    if (xp.total > 0 && xp.payH <= maxPayH() && xp.payH < r.payH && !xp.block) return false;   // najpierw lepszy zwrot
    if (r.kind === 'trailer') return startRenewTrailer(r);
    const need = r.m.price - r.t.value + 600;
    if (!canSpend(need, 'invest')) return false;
    AP.newSet = {
      step: 'sell_old', replace: { id: String(r.t.id), name: r.t.name, city: r.t.loc, hp: truckSpec(r.t).hp || 0 }, model: r.m.id, type: null,
      total: need, extras: 600, startedAt: Date.now(), truckId: null, trailerId: null, city: r.t.loc, truckTo: r.t.loc,
      hireDriver: false, hireWorker: false
    };
    logEvent(`🔄 Wymiana: ${r.t.name} (${(1 / truckSpec(r.t).lPerKm).toFixed(2).replace('.', ',')} km/L, zużycie ~€${(wearCost(r.t, 'truck', 100).v / 100).toFixed(2).replace('.', ',')}/km, wartość ${fmt(r.t.value)}) → model ${r.m.id}: +${fmt(r.gain)}/h, koszt ${fmt(r.cost)}, zwrot ~${fmtDur(r.payH * 3600)}`);
    await saveAP();
    return resumeNewSet();
  }

  // Wymiana naczepy: najpierw to, co nie przerywa pracy zestawu (licencja firmy, egzamin kierowcy) – gdy się nie uda,
  // nic nie zostaje sprzedane; potem sprzedaż starej, zakup nowej, sprawdzenie w garażu i Transferio do zestawu
  async function startRenewTrailer(r) {
    if (!canSpend(r.money, 'invest')) return false;
    const t = r.t;
    AP.newSet = {
      step: r.licCost ? 'company_license' : r.exams ? 'driver_exam' : 'sell_old',
      replaceTr: { id: String(t.id), name: t.name, city: t.loc, type: r.T0 },
      licType: r.licCost ? r.T : null, licCost: r.licCost || 0, model: null, type: r.T,
      total: r.money, extras: r.transfer + r.licCost + r.exams, startedAt: Date.now(), truckId: null, trailerId: null, city: t.loc,
      transfer: false, hireDriver: false, hireWorker: false, exams: r.exams, examDriver: r.driver ? String(r.driver.id) : null
    };
    logEvent(`🔄 ${renewTrailerTitle(r)}: +${fmt(r.gain)}/h, koszt ${fmt(r.money)}, zwrot ~${fmtDur(r.payH * 3600)}`);
    await saveAP();
    return resumeNewSet();
  }

  async function startFuelRound(why) {
    AP.fuelRound = { visited: [], refuels: 0, seen: [], started: Date.now() };
    setStatus('⛽ Tankowanie', why + ' – idę na stację paliw...');
    await humanDelay(0.5);
    return go('fuelstation');
  }

  // Patrol budzi się tuż po końcu najbliższego etapu ładunku (znamy czasy z timerów gry)
  function nextPatrolDelay() {
    const now = Date.now();
    const w = ST.warehouse;
    const next = Object.values(AP.due || {}).concat(w && w.nextDone ? [w.nextDone] : []).filter(t => t > now).sort((a, b) => a - b)[0];
    if (next && next - now < 60000) return Math.max(2000, next - now + rand(800, 2200));
    // Coś jedzie / ładuje się / tankuje – sprawdzaj często; nic się nie dzieje – rzadziej
    const busy = (w && w.inProgress) || Object.values(AP.busyFuel || {}).some(t => t > now);
    return busy ? rand(6000, 10000) : rand(15000, 25000);
  }

  // Dlaczego wolna ciężarówka stoi – konkretny powód zamiast ogólnika
  function idleReason(t) {
    const g = ST.garage, emps = (ST.employees && ST.employees.list) || [];
    const city = t.loc;
    if (!city || /na trasie|on route/i.test(city)) return 'w trasie';
    const svc = inService(t);
    if (svc) return svc;
    if (!fuelOk(t)) return 'najpierw pełny bak (tankowanie przed trasą)';
    if (tiresBad(t)) return AP.tireTry && AP.tireTry[t.id] > Date.now() - 6 * 3600000 ? 'zużyte opony – załóż nowe ręcznie' : 'zużyte opony – wymiana';
    if (heldTruck(t)) return 'czeka na naczepę nowego typu (Auto-rozwój)';
    const here = g.trailers.filter(x => sameCity(x.loc, city));
    if (!here.length) {
      // naczepa właśnie jedzie tu przewozem (Transferio) – ciężarówka na nią czeka
      const mv = Object.values(AP.moves || {}).find(m => m.kind === 'trailer' && sameCity(m.to, city));
      return mv ? `czeka na ${mv.name} (przewóz${mv.until > Date.now() ? `, ~${fmtDur((mv.until - Date.now()) / 1000)}` : ''})` : `brak naczepy w ${city}`;
    }
    const free = here.filter(x => isIdleStatus(x.status) && !inService(x, 'trailer'));
    if (!free.length) return `naczepa w ${city} zajęta (${here.map(x => (x.status || '?').toLowerCase()).join(', ')})`;
    const hp = truckSpec(t).hp;
    const ok = free.filter(x => !hp || hp >= ((TIERS[x.type] || {}).hp || 200));
    if (!ok.length) return `za mała moc (${hp} KM) na naczepę w ${city}`;
    const type = Math.max(...ok.map(x => x.type || 1));
    if (emps.length) {
      // Co robi człowiek i ile jeszcze (licznik gry), np. "śpi – wstanie za 1 min"
      const doing = e => e.freight ? `przypisany do ${e.freight}`
        : `${(e.action || 'zajęty').toLowerCase()}${e.actionUntil > Date.now() ? ` – ${/śpi|spi|sleep/i.test(e.action) ? 'wstanie' : 'wolny'} za ${fmtDur((e.actionUntil - Date.now()) / 1000)}` : ''}`;
      const drv = emps.filter(e => e.role === 'driver' && sameCity(e.loc, city));
      if (!drv.length) {
        const mv = Object.values(AP.moves || {}).find(m => m.kind === 'emp' && sameCity(m.to, city) && emps.some(e => e.role === 'driver' && String(e.id) === m.id));
        return mv ? `czeka na ${mv.name} (taksówka)` : `brak kierowcy w ${city}`;
      }
      const freeDrv = drv.filter(e => isIdleStatus(e.action) && !e.freight);
      if (!freeDrv.length) return `kierowca w ${city}: ${drv.map(doing).join(', ')}`;
      if (!freeDrv.some(e => (e.lic || 9) >= type)) return `kierowca w ${city} bez uprawnień: ${TIERS[type].name}`;
      if (!freeDrv.some(e => (e.lic || 9) >= type && !(e.energy < S.sleepAt))) return `kierowca w ${city} musi się wyspać (energia ${Math.max(...freeDrv.map(e => e.energy || 0))}%)`;
      const wrk = emps.filter(e => e.role === 'worker' && sameCity(e.loc, city));
      if (!wrk.length) return `brak pracownika magazynu w ${city}`;
      const freeW = wrk.filter(e => isIdleStatus(e.action) && !e.freight);
      if (!freeW.length) return `pracownik magazynu w ${city}: ${wrk.map(doing).join(', ')}`;
      if (!freeW.some(e => !(e.energy < S.sleepAt))) return `pracownik magazynu w ${city} musi się wyspać`;
    }
    const waiting = ((ST.warehouse && ST.warehouse.rows) || []).find(r => r.state === 'load' && sameCity(r.from, city));
    if (waiting) return `czeka na załadunek ${waiting.label}`;
    const w = ST.warehouse;
    if (w && w.used >= w.cap) return `magazyn pełny (${w.used}/${w.cap})`;
    if (isCool(`trips:${norm(city)}:${type}`)) {
      const soon = ST.tripsRefreshAt && ST.tripsRefreshAt > Date.now() ? ` – nowe trasy za ${fmtDur((ST.tripsRefreshAt - Date.now()) / 1000)}` : '';
      return `brak opłacalnych tras z ${city} (${(TYPES[type] || '').toLowerCase()})${soon}`;
    }
    return 'szukam trasy';
  }

  // Stan każdej ciężarówki z kilku źródeł naraz: garaż (etykieta + licznik gry), ładunki w toku (faza, czas do końca,
  // czy ciężarówka jest jeszcze przy ładunku), ładunki czekające na ruch bota i własne akcje bota (tankowanie, serwis)
  const STATE_PL = { drive: 'jedzie', load: 'załadunek', unload: 'rozładunek', wait: 'czeka na akcję', refuel: 'tankuje', service: 'w serwisie', nofuel: 'bez paliwa w trasie', idle: 'wolna', unknown: 'stan nieznany' };
  const WAIT_PL = { load: 'Załaduj', drive: 'Jedź!', unload: 'Rozładuj', finish: 'Zakończ' };
  function truckState(t) {
    expireStatuses();
    const now = Date.now(), w = ST.warehouse || {}, fm = ST.fmap || {};
    const prog = w.prog || [], rows = w.rows || [];
    // ładunek tej ciężarówki (znany ze strony ładunku), o ile nadal jest w magazynie
    const n = Object.keys(fm).filter(k => String(fm[k].truckId) === String(t.id)).sort((a, b) => fm[b].t - fm[a].t)
      .find(k => prog.some(p => p.n === k && p.truck) || rows.some(r => r.n === k)) || null;
    const pr = n ? prog.find(p => p.n === n) : null, row = n ? rows.find(r => r.n === n) : null;
    const st = t.status || '';
    const out = (state, until, extra) => ({ state, label: STATE_PL[state], until: until > now ? until : null, n, from: (pr || row || {}).from, to: (pr || row || {}).to, ...extra });
    const fuelUntil = AP.busyFuel && AP.busyFuel[t.id], repUntil = AP.busyRepair && AP.busyRepair['truck' + t.id];
    if (/tankow|refuel/i.test(st) || fuelUntil > now) return out('refuel', t.statusUntil || fuelUntil);
    if (/konserwac|maintenance/i.test(st) || repUntil > now) return out('service', t.statusUntil || repUntil);
    if (/bez paliwa|out of fuel|no fuel/i.test(st) || (row && row.state === 'fuel')) return out('nofuel');
    if (/jedzie|jazda|w drodze|driv/i.test(st)) return out('drive', t.statusUntil || (pr && pr.until));
    if (pr && pr.truck && ['drive', 'load', 'unload'].includes(pr.phase)) return out(pr.phase, pr.until);
    if (row && WAIT_PL[row.state] && !isIdleStatus(st)) return out('wait', null, { waitFor: WAIT_PL[row.state] });
    if (isIdleStatus(st)) return out('idle');
    if (/czeka|wait|gotow|ready/i.test(st)) return out('wait');
    if (!st && /na trasie|on route/i.test(t.loc || '')) return out('drive');
    return out('unknown');
  }

  function fleetLine() {
    const g = ST.garage;
    if (!g || !g.trucks.length) return '';
    const all = g.trucks.map(t => ({ t, s: truckState(t) }));
    const cnt = (...k) => all.filter(x => k.includes(x.s.state)).length;
    const work = cnt('drive', 'load', 'unload');
    let h = `🚛 Pracuje: <b>${work}/${g.trucks.length}</b>`;
    const parts = [cnt('drive') && `🚚 jedzie ${cnt('drive')}`, cnt('load', 'unload') && `📦 ładunek/rozładunek ${cnt('load', 'unload')}`,
      cnt('wait') && `⏸ czeka na bota ${cnt('wait')}`, cnt('refuel') && `⛽ tankuje ${cnt('refuel')}`,
      cnt('nofuel') && `⚠ bez paliwa ${cnt('nofuel')}`, cnt('service') && `🔧 serwis ${cnt('service')}`].filter(Boolean);
    if (parts.length) h += ` (${parts.join(' · ')})`;
    const idle = all.filter(x => x.s.state === 'idle' || x.s.state === 'unknown');
    if (idle.length) h += ` · 🅿 wolne: ${idle.map(x => esc(`${x.t.name} (${x.t.loc || '?'})`)).join(', ')}`;
    return h;
  }

  // Opis stanu ciężarówki do panelu: gdzie jest, co robi, ile jeszcze, który ładunek – a gdy stoi, konkretny powód
  function truckStateHtml(t) {
    const s = truckState(t), now = Date.now();
    const left = s.until ? ` · jeszcze ${fmtDur((s.until - now) / 1000)}` : '';
    const fr = s.n ? ` · #${s.n.slice(-3)}${s.from && s.to ? ` ${s.from} → ${s.to}` : ''}` : '';
    if (s.state === 'idle' || s.state === 'unknown') {
      return `${esc(t.loc || '?')} · ${s.state === 'idle' ? 'stoi' : esc(t.status || 'stan nieznany')} <span style="color:#fbbf24">(${esc(idleReason(t))})</span>`;
    }
    const where = s.state === 'drive' ? '' : `${esc(t.loc || '?')} · `;
    return `${where}<b>${esc(s.label)}${s.waitFor ? ': ' + esc(s.waitFor) : ''}</b>${left}${esc(fr)}`;
  }

  // Ludzie: kto przy ładunkach, kto wolny (i zmęczony), kto śpi i kiedy pierwszy wstanie
  function staffLine() {
    const list = (ST.employees && ST.employees.list) || [];
    if (!list.length) return '';
    const now = Date.now();
    return [['driver', '🧑‍✈️ Kierowcy'], ['worker', '👷 Pracownicy'], ['manager', '💼 Menedżerowie']].map(([role, name]) => {
      const es = list.filter(e => e.role === role);
      if (!es.length) return null;
      const sleeping = es.filter(e => /śpi|spi|sleep/i.test(e.action));
      const free = es.filter(e => isIdleStatus(e.action) && !e.freight);
      const tired = free.filter(e => e.energy < S.sleepAt).length;
      const busy = es.length - sleeping.length - free.length;
      const wake = sleeping.map(e => e.actionUntil).filter(u => u > now).sort((a, b) => a - b)[0];
      return `${name} ${es.length}: przy ładunkach ${busy} · wolni ${free.length}${tired ? ` (zmęczeni ${tired})` : ''}`
        + (sleeping.length ? ` · śpi ${sleeping.length}${wake ? ` (pierwszy wstaje za ${fmtDur((wake - now) / 1000)})` : ''}` : '');
    }).filter(Boolean).join('<br>');
  }

  // --- Krok Magazyn: planowanie. Jedna decyzja na wizytę, potem powrót tutaj. ---
  // Szybkie przejścia: po akcji na stronie ładunku, Tras, stacji, garażu albo pracownika decyzja planera zapada od razu –
  // Magazyn pobrany w tle (te same dane co po wejściu na jego stronę, ta sama logika planera), a bot idzie prosto na
  // kolejną stronę zamiast przez stronę Magazynu (jedno pełne wczytanie strony mniej na każdą akcję).
  // Patrol (nic do zrobienia), błąd pobrania albo wywołanie z wnętrza planera – po staremu przez stronę Magazynu.
  let plannerRemote = false;
  function navStat(k, ms) {
    if (!(ms > 0 && ms < 60000)) return;
    const n = AP.navStat = AP.navStat || { saved: 0, full: 0 };
    n[k] = n[k] == null ? ms : Math.round(ema(n[k], ms, 0.15));
  }
  async function toPlanner() {
    if (!AP.enabled || AP.fastNav === false || plannerRemote || pageName() === 'warehouse') return go('warehouse');
    plannerRemote = true;
    try {
      const t0 = Date.now();
      // pobrana strona musi być Magazynem (np. wygasła sesja daje inną stronę) – inaczej po staremu
      if (!(await refreshPage('warehouse')) || !(ST.warehouse && ST.warehouse.t >= t0)) return go('warehouse');
      navStat('fetchMs', Date.now() - t0);
      AP.navStat.saved = (AP.navStat.saved || 0) + 1;
      return await apHandleWarehouse(true);
    } catch (e) {
      console.warn('[LTD] planer bez wchodzenia do Magazynu:', e);
      return go('warehouse');
    } finally {
      plannerRemote = false;
    }
  }

  async function apHandleWarehouse(remote = false) {
    AP.nextPatrolTime = 0;
    // DOM magazynu nie odświeża się sam – przy patrolu na tej samej stronie bierzemy świeże dane z serwera
    // (przy szybkim przejściu Magazyn jest już pobrany w tle przez toPlanner)
    if (!remote) {
      if (Date.now() - PAGE_T0 > 4000) await refreshPage('warehouse');
      else parsePage(document, 'warehouse');
    }
    await refreshData(30000);
    await refreshSlow();
    expireStatuses();
    trackFleetBusy();
    trackMoves();
    checkPendingActions();

    const rows = (ST.warehouse && ST.warehouse.rows) || [];
    const ready = st => rows.filter(r => r.state === st && !isCool('f:' + r.n));

    // 1. Ładunki gotowe do kolejnego kroku, które nie potrzebują nowych zasobów: Zakończ > Rozładuj > Jedź > inne
    const STEP = { finish: '💰 Odbiór zapłaty', unload: '📦 Rozładunek', drive: '🚀 Start w trasę', other: '▶ Sprawdzam ładunek' };
    for (const st of ['finish', 'unload', 'drive', 'other']) {
      const r = ready(st)[0];
      if (r) {
        setStatus(STEP[st], `${r.label} ${r.from} → ${r.to}: ${r.statusText || 'otwieram'}...`);
        await humanDelay(0.4);
        return go('freight', { n: r.n });
      }
    }

    // 2. Ładunek stoi w trasie bez paliwa → stacja (zakładka "Na trasie"), a po tankowaniu od razu wejście
    //    w ładunek i zielony przycisk (Kontynuuj). Gdy tankowanie trwa – w tym czasie obsługujemy resztę floty.
    const dry = ready('fuel');
    if (dry.length && AP.autoFuel) {
      const rr = AP.routeRefuel;
      const refueled = rr && Date.now() - rr.t < 15 * 60000;
      if (refueled && Date.now() < rr.until) {
        AP.due.route = rr.until;
      } else if (refueled || isCool('fuelround')) {
        setStatus('▶ Kontynuacja', `${dry[0].label}: zatankowana – wchodzę w ładunek i wznawiam trasę...`);
        await humanDelay(0.4);
        return go('freight', { n: dry[0].n });
      } else {
        return startFuelRound(`${dry[0].label} stoi bez paliwa w trasie`);
      }
    }

    // 3. Sen – każdy osobno, tylko gdy nic nie robi ("Idź spać" dla wszystkich jest premium)
    if (AP.autoSleep) {
      const e = pickTired();
      if (e) {
        AP.sleepTarget = e.id;
        setCool('sleep:' + e.id, 300);
        setStatus('😴 Sen', `${e.name}: energia ${e.energy}% – wysyłam spać...`);
        await humanDelay(0.5);
        return go('employees_select', { e: e.id });
      }
    }

    // 4. Media – nowa umowa przed wygaśnięciem (bez prądu/wody firma może stanąć)
    const up = utilPlan();
    if (up) {
      AP.utilTask = { key: up.key, offerId: up.offer.id };
      const unit = up.key === 'elec' ? 'kWh' : 'm3';
      const why = up.short ? `niedobór (potrzeba ${String(up.used).replace('.', ',')} ${unit}, umowy ${String(up.cap).replace('.', ',')} ${unit})` : 'kończy się umowa';
      logEvent(`⚡ ${up.key === 'elec' ? 'Prąd' : 'Woda'}: ${why} – nowa umowa ${up.offer.amount} ${unit}`);
      setStatus('⚡ Media', `${up.key === 'elec' ? 'Prąd' : 'Woda'}: ${why} – biorę ${up.offer.amount} ${unit} za ${fmt(up.offer.perHour)}/h na ${up.offer.hours} h...`);
      await humanDelay(0.5);
      return go('utilities');
    }

    // 4b. Mechanicy – kontrakt przed wygaśnięciem bieżącego (bez mechaników naprawy stają)
    const mp = mechPlan();
    if (mp) {
      AP.mechTask = { offerId: mp.offer.id, amount: mp.offer.amount, perHour: mp.offer.perHour, hours: mp.offer.hours, t: Date.now() };
      setCool('mech', 15 * 60);
      const why = mp.have === 0 ? 'brak mechaników' : mp.after < mp.have ? `kontrakt kończy się za ≤ ${S.utilHoursAhead} h` : `potrzeba ${mp.need}, jest ${mp.have}`;
      setStatus('🔧 Mechanicy', `${why} – biorę ${mp.offer.amount} mechaników za ${fmt(mp.offer.perHour)}/h na ${mp.offer.hours} h...`);
      await humanDelay(0.5);
      return go('contracts');
    }

    // 5. Opony: zużyte albo nie na sezon (zakup brakujących kompletów, potem założenie na konkretną ciężarówkę)
    const tp = tirePlan();
    if (tp) {
      if (tp.action === 'mount') {
        const t = unitById('truck', tp.truckId) || { name: 'Ciężarówka' };
        AP.tireMount = { truckId: tp.truckId, types: tp.types, minCond: tp.minCond, worn: !!tp.worn, t: Date.now(), clicks: 0 };
        setCool('tiremount:' + tp.truckId, 5 * 60);
        setStatus('🛞 Opony', `${t.name}: ${tp.worn ? 'zużyte opony' : `sezon ${SEASON_PL[ST.season.key]}`} – zakładam ${tp.types.map(x => TIRE_PL[x]).join(' / ')} z magazynu opon...`);
        await humanDelay(0.5);
        return go('garage_truck_wtires', { t: tp.truckId });
      }
      AP.tireTask = { action: tp.action, type: tp.type, n: tp.n, worn: tp.worn || null };
      const why = tp.worn ? `Zużyte opony (${tp.worn.map(id => (unitById('truck', id) || { name: id }).name).join(', ')})`
        : tp.prep ? 'Przygotowanie na kolejny sezon' : `Sezon: ${SEASON_PL[ST.season.key]}`;
      if (tp.action === 'buy') {
        setStatus('🛞 Opony', `${why} – brakuje ${tp.n} kompletów opon ${TIRE_PL[tp.type]}, idę do sklepu...`);
        await humanDelay(0.5);
        return go('shopcompany', { p: 'tires' });
      }
      setStatus('🛞 Opony', `${why} – zakładam opony ${TIRE_PL[tp.type]}...`);
      await humanDelay(0.5);
      return go('garage');
    }

    // 6. Naprawa stojących pojazdów
    if (AP.autoRepair) {
      const d = pickDamaged();
      if (d) {
        setStatus('🔧 Naprawa', `${d.name}: stan ${d.cond}% – idę do garażu...`);
        await humanDelay(0.5);
        return go('garage');
      }
    }

    // 7. Tankowanie wolnych ciężarówek przed kolejną trasą
    if (AP.autoFuel && fuelDue()) return startFuelRound('Tankuję wolne ciężarówki przed kolejnymi trasami');

    // 7b. Kadry: szkolenie kierowcy (w toku), następcy przed emeryturą, braki ludzi przy zestawach, menedżerowie.
    //     Najpierw dokończenie rozpoczętego zadania porządku floty (strona mogła się przeładować w trakcie)
    const pend = AP.fireTask && !AP.fireTask.sent ? ['employees_select', { e: AP.fireTask.id }, AP.fireTask]
      : AP.moveTask && AP.moveTask.plan !== 'newset' ? [AP.moveTask.kind === 'emp' ? 'employees_transfer' : AP.moveTask.kind === 'truck' ? 'truck_transfer' : 'trailer_transfer',
        AP.moveTask.kind === 'emp' ? { e: AP.moveTask.id } : { t: AP.moveTask.id }, AP.moveTask]
      : AP.upgradeTask ? ['properties', {}, AP.upgradeTask] : null;
    if (pend) {
      const task = pend[2];
      task.visits = (task.visits || 0) + 1;
      if (task.visits <= 3) { await humanDelay(0.4); return go(pend[0], pend[1]); }
      logEvent(`⚠️ Zadanie porządku floty porzucone (${task.name || task.building || ''}) – nie udało się go dokończyć`);
      if (task === AP.fireTask) AP.fireTask = null; else if (task === AP.moveTask) AP.moveTask = null; else AP.upgradeTask = null;
    }
    if (AP.pendingLicense) {
      const pl = AP.pendingLicense;
      const fresh = ((ST.employees && ST.employees.list) || []).find(e => e.role === 'driver' && e.id && !pl.known.includes(e.id));
      if (fresh) AP.licenseTask = { driverId: fresh.id, targetTier: pl.lic, t: Date.now() };
      if (fresh || Date.now() - pl.t > 15 * 60000) AP.pendingLicense = null;
    }
    if (AP.licenseTask) {
      const lt = AP.licenseTask;
      if (lt.lastVisit !== undefined && Date.now() - lt.t > 30 * 60000) {
        AP.licenseTask = null;
        logEvent('🎓 Szkolenie kierowcy przerwane (za długo)');
      } else {
        lt.lastVisit = Date.now();
        setCool('lic:' + lt.driverId, 30 * 60);
        setStatus('🎓 Szkolenie kierowcy', `Uprawnienia do: ${TIERS[lt.targetTier].name}...`);
        await humanDelay(0.5);
        return go('employees_upgrade', { e: lt.driverId });
      }
    }
    const hp = hirePlan();
    if (hp) {
      if (hp.role === 'license') {
        AP.licenseTask = { driverId: hp.driverId, targetTier: hp.lic, t: Date.now() };
        setCool('lic:' + hp.driverId, 30 * 60);
        logEvent(`🎓 Szkolenie: ${hp.why}`);
        setStatus('🎓 Szkolenie kierowcy', `${hp.why}...`);
        await humanDelay(0.5);
        return go('employees_upgrade', { e: hp.driverId });
      }
      if (hp.role === 'move') return startMove(hp);
      if (hp.role === 'upgrade') return startUpgrade(hp);
      if (hp.role === 'fire') return startFire(hp);
      AP.hireTask = hp;
      setCool('hire:' + hp.role, 5 * 60);
      setStatus('🧑‍💼 Kadry', `${hp.why} – zatrudniam: ${ROLE_PL[hp.role]}...`);
      await humanDelay(0.5);
      return go('employees_hire', { type: HIRE_FORMS[hp.role].type });
    }

    // 7c. Ciężarówka i naczepa bez pary w różnych miastach → przewóz (taniej niż kupno)
    const ru = reunitePlan();
    if (ru) return startMove({ kind: ru.kind, unit: ru.unit, to: ru.to, why: ru.why, gapKey: ru.key });

    // 8. Przyjęte ładunki → przydział ciężarówki, naczepy, ludzi i Załaduj (tylko ciężarówka z pełnym bakiem).
    //    Najpierw wyższe typy: "Losowy" bierze wtedy kierowcę z wyższymi uprawnieniami do właściwej naczepy,
    //    a nie do zwykłego ładunku (inaczej naczepa wyższego typu zostawała bez uprawnionego kierowcy)
    const loads = ready('load').sort((a, b) => (b.type || 1) - (a.type || 1));
    const truckOf = r => { const s = setFor(r.from, r.type); return s && s.truck; };
    const setOk = r => { const t = truckOf(r); return !t || (fuelOk(t) && !inService(t) && !tiresBad(t)); };
    // Ładunek niższego typu czeka chwilę, gdy w tym mieście wyższy typ jeszcze tankuje / jest w serwisie, a kierowców
    // z uprawnieniami do wyższego typu jest tam nie więcej niż takich ładunków – "Losowy" mógłby ich zabrać do zwykłego
    const qualIn = (city, t) => ((ST.employees && ST.employees.list) || [])
      .filter(e => e.role === 'driver' && sameCity(e.loc, city) && !e.freight && licOf(e) >= t).length;
    const guarded = r => loads.some(h => (h.type || 1) > (r.type || 1) && sameCity(h.from, r.from) && !setOk(h) && !tiresBad(truckOf(h) || {})
      && qualIn(r.from, h.type || 1) <= loads.filter(x => sameCity(x.from, r.from) && (x.type || 1) >= (h.type || 1)).length);
    const ld = loads.find(r => setOk(r) && !guarded(r));
    if (ld) {
      setStatus('🚛 Przydział zestawu', `${ld.label} ${ld.from} → ${ld.to}: przypisuję ciężarówkę, naczepę i ludzi...`);
      await humanDelay(0.4);
      return go('freight', { n: ld.n });
    }

    // 9. Rozbudowa floty: kolejny zestaw (dokończenie albo start) – przed licencją kolejnego typu,
    //    bo nieużywana naczepa i wolne miejsce w magazynie to najszybszy zwrot
    if (AP.newSet ? await resumeNewSet() : AP.autoNewSets && await startNewSet()) return;
    // 9a. Wymiana słabej ciężarówki na lepszy model (sprzedaż starej), gdy to najlepszy zwrot z dostępnych
    if (await startRenew()) return;
    // 9b. Auto-rozwój: licencja kolejnego typu + naczepa (nowy plan albo dokończenie rozpoczętego)
    if (AP.autoExpandFleet && (AP.investState ? await resumeInvest() : await checkAndTriggerAutoInvest())) return;

    // 10. Każdy wolny zestaw dostaje zlecenie
    const w = ST.warehouse;
    if (AP.autoTrips && w && w.used < w.cap) {
      const plan = tripNeeds();
      if (plan.length) {
        AP.tripPlan = plan;
        setStatus('📦 Szukam zleceń', `Wolne zestawy: ${plan.map(p => `${p.n}× ${TYPES[p.type] || 'typ ' + p.type} w ${p.city}${p.soon ? ' (kończy tankowanie)' : ''}`).join(', ')}. Idę do Tras...`);
        await humanDelay(0.5);
        return go('trips');
      }
    }

    // 11. Wszystko, co się dało, jest w ruchu – patrol (budzi się na koniec najbliższego etapu).
    //     Patrol zawsze na stronie Magazynu (jak dawniej) – przy szybkim przejściu najpierw tam wracamy.
    if (remote) {
      setStatus('Powrót do Magazynu', 'Na razie nic do zrobienia – wracam do Magazynu i czekam na koniec etapów...');
      await humanDelay(0.4);
      return go('warehouse');
    }
    const g = ST.garage;
    const states = g ? g.trucks.map(t => ({ t, s: truckState(t) })) : [];
    const idle = states.filter(x => x.s.state === 'idle' || x.s.state === 'unknown').map(x => x.t);
    const busy = states.filter(x => !['idle', 'unknown'].includes(x.s.state));
    const blocked = Object.keys(AP.blocked || {}).length;
    AP.patrolInfo = [
      w ? `Magazyn ${w.used}/${w.cap}.` : '',
      busy.length ? `${busy.map(x => `${x.t.name}: ${x.s.label}${x.s.waitFor ? ' ' + x.s.waitFor : ''}${x.s.until ? ` (${fmtDur((x.s.until - Date.now()) / 1000)})` : ''}`).join('; ')}.` : '',
      idle.length
        ? `Stoją: ${idle.map(t => `${t.name} (${t.loc || '?'}) – ${idleReason(t)}`).join('; ')}.`
        : 'Wszystkie ciężarówki są zajęte.',
      blocked ? `Ładunki czekające na zasoby: ${blocked}.` : ''
    ].filter(Boolean).join(' ');
    const wait = nextPatrolDelay();
    AP.nextPatrolTime = Date.now() + wait;
    workAdd();
    workFrom = null;   // patrol (czekanie na koniec etapów) to nie praca bota
    setStatus('🟢 Flota pracuje', `${AP.patrolInfo} Kolejna kontrola za ${Math.round(wait / 1000)}s...`);
    await saveAP();
  }

  // Po "Zakończ" ciężarówka, naczepa i ludzie są wolni w mieście docelowym (przy "Kończeniu" zostaje tylko menedżer) –
  // zaznaczamy to od razu, zamiast czekać do ~30 s na odświeżenie garażu: tankowanie i nowa trasa ruszają natychmiast
  function releaseAfterFinish(n) {
    const fm = ST.fmap && ST.fmap[n];
    const row = ((ST.warehouse && ST.warehouse.rows) || []).find(x => x.n === n);
    const city = row && row.to;
    if (!city) return;
    for (const u of [fm && unitById('truck', fm.truckId), fm && unitById('trailer', fm.trailerId)]) {
      if (!u || /tankow|konserwac/i.test(u.status || '')) continue;
      u.status = 'Nic';
      u.statusUntil = null;
      u.loc = city;
    }
    for (const e of (ST.employees && ST.employees.list) || []) {
      if (e.freight && row.label && e.freight === row.label && e.role !== 'manager') {
        e.freight = null;
        e.action = 'Nic';
        e.loc = city;
      }
    }
    saveState();
  }

  // Pracownik magazynu jedzie z ładunkiem – inaczej w mieście docelowym może nie mieć kto rozładować
  async function ensureWorkerGoes(n, lbl) {
    if (!AP.sendWorker) return false;
    const sw = document.getElementById('sendwhemployee');
    const info = document.getElementById('showifwhemployeesent');
    if (!sw || sw.disabled || !info || !/^\s*(nie|no)\s*$/i.test(info.textContent) || isCool('sw:' + n)) return false;
    setCool('sw:' + n, 120);
    await saveAP();
    setStatus('👷 Pracownik jedzie z ładunkiem', `${lbl}: ustawiam "Poślij z ładunkiem: Tak" – rozładuje towar na miejscu...`);
    await humanDelay(0.3);
    await act(sw, { until: () => /tak|yes/i.test(info.textContent) });
    return true;
  }

  // --- Krok Podstrona Ładunku: jedna akcja, potem powrót do Magazynu (bez czekania na timery) ---
  async function apHandleFreight() {
    const n = urlParam('n');
    if (!n) return go('warehouse');
    const key = 'f:' + n;
    const root = document.getElementById('page-content') || document.body;
    const lbl = (txt(root.querySelector('.page-title')).match(/#\d+/) || ['#' + n.slice(-3)])[0];
    const stateText = txt(root.querySelector('.portlet-title .caption-subject'));
    const btn = prefix => [...root.querySelectorAll(`button[onclick^="${prefix}"]`)].find(b => !b.disabled) || null;
    const card = id => document.getElementById(id);
    const info = readFreight(document, n);   // nauka: prognoza kosztów + czasy etapów
    // Wiadomo, że bak nie wystarczy na tę trasę? Najpierw tankowanie, potem start (inaczej postój w trasie po €2/L)
    const fuelShort = () => {
      if (!AP.autoFuel || !info || !info.truckId || !info.fin) return false;
      const fk = Object.keys(info.fin).find(k => k.startsWith('paliwo') || k.startsWith('fuel'));
      const needL = fk ? parseMoney(info.fin[fk].qty) : NaN;
      const lv = ST.fuelLevels && ST.fuelLevels[info.truckId];
      const since = lastTripEnd({ id: info.truckId });
      // Trasa dłuższa niż cały bak (np. przyjęta przed limitem): czekanie na tankowanie nic nie da – pełny bak i jazda
      return needL > 0 && !!lv && !lv.failed && lv.t >= since && lv.cur < needL * 1.05 && lv.cur < lv.max * 0.97;
    };
    // Zużyte opony: gra nie pozwala ruszyć ("Opony ciężarówki nie są już wystarczająco dobre") – wymiana zamiast klikania w kółko
    const tireBlock = async () => {
      const id = info && info.truckId;
      markTiresWorn(id);
      const t = unitById('truck', id) || { id, name: (txt(card('freight-truck')).match(/(Ciężarówka|Truck)\s+[\d.]+/i) || ['ciężarówka'])[0] };
      const tried = AP.tireTry && AP.tireTry[id] > Date.now() - 6 * 3600000;
      if (tried) {
        notify('LogiTycoon: wymień opony', `${t.name}: automatyczna zmiana opon nie pomogła – załóż nowy komplet ręcznie (Garaż → Informacja o ciężarówce).`);
        logEvent(`🛞 ${t.name}: zużyte opony – potrzebna ręczna wymiana`);
      } else logEvent(`🛞 ${t.name}: zużyte opony – kupię i założę nowy komplet`);
      return back(tried ? 'zużyte opony – załóż nowe ręcznie (automat nie pomógł)' : 'zużyte opony – wymieniam na nowe', tried ? 600 : 90);
    };
    const tireErr = r => r.error && /opon|tire/i.test(r.error);
    // Czas etapu, który zaraz wystartuje (pierwszy nieukończony z timerem) → patrol obudzi się na jego koniec
    const nextPhaseSec = () => { const ph = phasesOf(document).find(x => !x.done && x.sec); return ph ? ph.sec : null; };
    const started = sec => { if (sec) AP.due[n] = Date.now() + sec * 1000 + 1500; };

    const back = async (why, sec) => {
      if (why) block(n, lbl, why);
      setCool(key, sec);
      setStatus(AP.status, `${lbl}: ${why || stateText || 'w toku'} – wracam do Magazynu, reszta floty nie czeka...`);
      await humanDelay(0.5);
      return toPlanner();
    };
    // Po akcji ładunek odpoczywa dokładnie tyle, ile trwa jego etap – potem planer od razu go podejmie
    const done = async sec => {
      unblock(n);
      setCool(key, sec ? Math.max(3, Math.min(sec - 2, 180)) : 12);
      await humanDelay(0.4);
      return toPlanner();
    };

    // Gra odmówiła przydziału ciężarówki/naczepy (czerwony komunikat) – przy tej samej trasie i wolnych pojazdach to
    // kondycja, która nie wystarcza na tyle km. Odmowa jest zapamiętana (kolejne trasy dla tak zużytych pojazdów będą
    // krótsze), słabe pojazdy z miasta idą do naprawy, a ładunek czeka – po naprawie przydział przechodzi.
    const unitRefused = (kind, msg) => {
      if (/paliw|fuel/i.test(msg)) { AP.fuelSoon = true; return null; }
      if (/premium|0 dost|brak (wolnych|dost)|pieni|money|środk/i.test(msg)) return null;
      const row = ((ST.warehouse && ST.warehouse.rows) || []).find(r => r.n === n);
      const km = (info && info.km) || (row && row.km);
      const city = row && row.from;
      if (!(km > 0) || !city) return null;
      const g = ST.garage;
      const list = g ? (kind === 'truck' ? g.trucks : g.trailers).filter(u => sameCity(u.loc, city) && isIdleStatus(u.status)
        && !inService(u, kind) && Number.isFinite(u.cond) && (kind === 'truck' || !row.type || (u.type || 1) === row.type)) : [];
      const what = kind === 'truck' ? 'ciężarówki' : 'naczepy';
      if (list.length) {
        const lr = learn();
        lr.condFail = (lr.condFail || []).filter(x => Date.now() - x.t < 24 * 3600000)
          .concat({ kind, km, cond: Math.max(...list.map(u => u.cond)), t: Date.now(), msg: String(msg).slice(0, 160) }).slice(-20);
      }
      // Naprawa pomoże tylko, gdy trasa mieści się w Maksymalnym dystansie (wiek) – dłuższej żadna naprawa nie umożliwi
      const weak = list.filter(u => u.cond < 97 && km <= condRange(u, kind, 100));
      const old = list.filter(u => maxKmOf(u, kind) > 0 && km > maxKmOf(u, kind));
      if (old.length && !weak.length && !isCool(`refused:${n}:${kind}`)) {
        setCool(`refused:${n}:${kind}`, 30 * 60);
        logEvent(`⚠️ ${lbl} (${km} km): trasa dłuższa niż Maksymalny dystans ${old.map(u => `${u.name} (${maxKmOf(u, kind)} km)`).join(', ')} – „${msg}”. Tak długich tras bot już nie bierze`);
        notify('LogiTycoon: ładunek za długi', `${lbl}: ${km} km to więcej niż Maksymalny dystans ${old.map(u => u.name).join(', ')}. Anuluj ten ładunek ręcznie albo przypisz młodszy pojazd.`);
        return `trasa dłuższa niż Maksymalny dystans pojazdu (${Math.max(...old.map(u => maxKmOf(u, kind)))} km)`;
      }
      AP.repairFor = AP.repairFor || {};
      weak.forEach(u => { AP.repairFor[kind + u.id] = { km, why: `za słaba na ${km} km (odmowa gry)`, t: Date.now() }; });
      const key = `refused:${n}:${kind}`;
      if (!isCool(key)) {
        setCool(key, 30 * 60);
        if (weak.length && !AP.autoRepair) notify('LogiTycoon: naprawa potrzebna', `${lbl}: gra nie przydzieliła ${what} na ${km} km („${msg}”). Naprawy są wyłączone w ⚙ – napraw ${weak.map(u => u.name).join(', ')} ręcznie.`);
        if (weak.length) logEvent(`🔧 ${lbl} (${km} km): gra nie przydzieliła ${what} – „${msg}”. ${AP.autoRepair ? 'Naprawiam' : 'Do naprawy (naprawy wyłączone w ⚙):'} ${weak.map(u => `${u.name} (${u.cond}%)`).join(', ')}, potem ponowię; tak zużytym pojazdom bot da krótsze trasy`);
        else {
          logEvent(`⚠️ ${lbl} (${km} km): gra nie przydziela ${what}${list.length ? ' mimo dobrej kondycji' : ''} – „${msg}”`);
          notify('LogiTycoon: ładunek czeka', `${lbl}: gra nie przydziela ${what}: ${msg}. Sprawdź ten ładunek ręcznie.`);
        }
      }
      return weak.length ? `${kind === 'truck' ? 'ciężarówka' : 'naczepa'} za słaba na ${km} km – najpierw naprawa` : `gra nie przydziela ${what}: ${msg}`;
    };

    // Przydział przyciskiem "Losowy" (darmowy). "Przydziel wszystko" jest tylko dla premium.
    const MANUAL = { truck: 'freight_truck', trailer: 'freight_trailer', emp: 'freight_whemployee' };
    const assign = async (cardId, prefix, kind, name) => {
      const av = availIn(card(cardId));
      if (!av.length) return null;                       // już przydzielone / nie dotyczy
      if (av.includes(0)) return `brak wolnego zasobu: ${name} (0 dostępnych w tym mieście)`;
      const b = btn(prefix);
      if (b && !AP.losowyPremium && attempt(n, kind) <= 3) {
        await saveAP();
        setStatus('🎲 Przydział', `${lbl}: przydzielam ${name}...`);
        await humanDelay(0.4);
        const r = await act(b);
        if (r.error && /premium/i.test(r.error)) AP.losowyPremium = true;
        else if (r.error) return ((kind === 'truck' || kind === 'trailer') && unitRefused(kind, r.error)) || `${name}: ${r.error}`;
        else {
          // gra może dociągać treść AJAX-em – czekam na przydział; bez zmiany przeładowuję stronę zamiast klikać w ciemno
          if (await waitFor(() => !availIn(card(cardId)).length, 4000)) return 'acted';
          await go('freight', { n });
          return 'nav';
        }
      }
      // Ręczny wybór na stronie "Zmień" – raz na 15 min dla danego ładunku i zasobu
      const ms = AP.manualSel;
      if (!(ms && ms.n === n && ms.kind === kind && Date.now() - ms.t < 15 * 60000)) {
        AP.manualSel = { n, kind, t: Date.now() };
        setStatus('🖐 Ręczny wybór', `${lbl}: wybieram ${name} ręcznie...`);
        await humanDelay(0.4);
        await go(MANUAL[kind], { n });
        return 'nav';
      }
      return `nie udało się przydzielić: ${name}`;
    };

    // A. Zakończ – potrzebny wolny menedżer (gdy go brak: wracam za minutę, zamiast wyłączać bota)
    const finishBtn = btn('freightstartfinishing');
    if (finishBtn) {
      if (availIn(card('freight-manager')).includes(0)) {
        // Notujemy braki – gdy powtarzają się często, Kadry zatrudnią kolejnego menedżera
        const ms = AP.mgrShort;
        AP.mgrShort = { n: ms && Date.now() - ms.t < 3600000 ? ms.n + 1 : 1, t: Date.now() };
        return back('brak wolnego menedżera – spróbuję za minutę', 60);
      }
      if (attempt(n, 'finish') > 3) return back('"Zakończ" nie przechodzi – spróbuję później', 180);
      const sec = nextPhaseSec();
      const rec = learn().net[n];
      // Każdy ładunek liczony raz (ponowne "Zakończ" tego samego ładunku nie może zawyżać zarobków)
      const dup = (ST.hist || []).some(x => x.n === n);
      if (!dup) AP.stats.trips++;
      AP.fuelSoon = true;
      ST.hist = (ST.hist || []).filter(x => x.n !== n).concat(rec ? [{ t: Date.now(), net: rec.net, km: rec.km, n }] : []).slice(-150);
      await Promise.all([saveAP(), saveStateNow()]);
      setStatus('💰 Odbiór zapłaty', `${lbl}: rozładowany – kończę zlecenie${rec ? ` (netto ~${fmt(rec.net)})` : ''}...`);
      await humanDelay(0.4);
      const r = await act(finishBtn);
      if (r.error) {
        if (!dup) AP.stats.trips--;
        ST.hist = (ST.hist || []).filter(x => x.n !== n);
        return back('Zakończ: ' + r.error, 90);
      }
      started(sec);
      releaseAfterFinish(n);
      logEvent(`💰 ${lbl} zakończony${rec ? `: netto ~${fmt(rec.net)}` : ''}`);
      return done(sec);
    }

    // B. Rozładuj – potrzebny pracownik magazynu na miejscu
    const unloadBtn = btn('freightstartunloading');
    if (unloadBtn) {
      const a = await assign('freight-employees', 'freightautowhemployee', 'emp', 'pracownika magazynu');
      if (a === 'acted') return later(rand(700, 1100));
      if (a === 'nav') return;
      if (a) return back(a, 120);
      if (attempt(n, 'unload') > 3) return back('"Rozładuj" nie przechodzi – spróbuję później', 180);
      const sec = nextPhaseSec();
      AP.fuelSoon = true;   // ciężarówka jest już wolna w mieście docelowym – zatankuj ją przed kolejną trasą
      await saveAP();
      setStatus('📦 Rozładunek', `${lbl}: zestaw dojechał – zaczynam rozładunek...`);
      await humanDelay(0.4);
      const r = await act(unloadBtn);
      if (r.error) return back('Rozładuj: ' + r.error, 90);
      started(sec);
      return done(sec);
    }

    // C. Jedź! (po załadunku)
    const driveBtn = btn('freightstartdriving');
    if (driveBtn) {
      if (await ensureWorkerGoes(n, lbl)) return later(rand(600, 1000));
      if (fuelShort()) {
        AP.fuelSoon = true;
        return back('w baku za mało paliwa na tę trasę – najpierw tankowanie', 60);
      }
      // Gra już raz odmówiła z powodu opon, a nowych jeszcze nie założono – nie klikamy na próżno
      if (info && tiresBad({ id: info.truckId })) return tireBlock();
      if (attempt(n, 'drive') > 3) return back('"Jedź!" nie przechodzi – spróbuję później', 180);
      const sec = nextPhaseSec();
      await saveAP();
      setStatus('🚀 Start w trasę', `${lbl}: załadowane – wysyłam zestaw w trasę${sec ? ` (${fmtDur(sec)})` : ''}...`);
      await humanDelay(0.4);
      const r = await act(driveBtn);
      if (r.error) {
        if (tireErr(r)) return tireBlock();
        if (/paliw|fuel/i.test(r.error)) AP.fuelSoon = true;
        return back('Jedź!: ' + r.error, 90);
      }
      started(sec);
      // Koniec jazdy tej ciężarówki – po nim bak jest "po kursie" i przed kolejną trasą musi przejść przez stację
      if (info && info.truckId) {
        ST.driveEnd = ST.driveEnd || {};
        ST.driveEnd[info.truckId] = Date.now() + (sec || 180) * 1000;
      }
      condTripStart(info, sec);
      return done(sec);
    }

    // D. Kontynuuj (po zatankowaniu w trasie) – dopiero gdy tankowanie się skończy (trwa np. 00:01:23)
    const continueBtn = btn('freightcontinue');
    if (continueBtn) {
      const rr = AP.routeRefuel;
      if (rr && Date.now() < rr.until) {
        AP.due[n] = rr.until;
        AP.status = '⛽ Tankowanie w trasie';
        return back(null, Math.max(5, Math.ceil((rr.until - Date.now()) / 1000)));
      }
      if (attempt(n, 'continue') > 4) {
        AP.routeRefuel = null;
        AP.fuelSoon = true;
        return back('"Kontynuuj" nie przechodzi – tankuję ponownie', 60);
      }
      await saveAP();
      setStatus('▶ Kontynuacja trasy', `${lbl}: zatankowana – wznawiam podróż...`);
      await humanDelay(0.4);
      const r = await act(continueBtn);
      if (r.error) {
        const recent = rr && Date.now() - rr.t < 15 * 60000;
        if (!recent) AP.fuelSoon = true;   // jeszcze nie zatankowana – najpierw stacja
        return back('Kontynuuj: ' + r.error, recent ? 20 : 45);
      }
      AP.routeRefuel = null;
      logEvent(`▶ ${lbl}: trasa wznowiona po tankowaniu`);
      return done();
    }

    // E. Przyjęty: ciężarówka → naczepa → kierowca i pracownik → Załaduj
    const loadBtn = btn('freightstartloading') || [...root.querySelectorAll('#loadfreight-button button')].find(b => !b.disabled);
    if (loadBtn) {
      for (const [id, prefix, kind, name] of [
        ['freight-truck', 'freightautotruck', 'truck', 'ciężarówkę'],
        ['freight-trailer', 'freightautotrailer', 'trailer', 'naczepę'],
        ['freight-employees', 'freightautowhemployee', 'emp', 'kierowcę i pracownika magazynu']
      ]) {
        // Kierowca wybierany konkretnie, gdy w mieście stoi kilku wolnych z różnymi uprawnieniami: ten z najniższymi
        // wystarczającymi ("Losowy" brał np. kierowcę od cystern do zwykłego ładunku, a cysterna potem stała)
        if (kind === 'emp') {
          const dc = driverChoice(n, card(id));
          if (dc) {
            AP.driverPick = { ...dc, t: Date.now() };
            await saveAP();
            setStatus('🖐 Wybór kierowcy', `${lbl}: ${dc.name} (${TYPE_SHORT[dc.lic] || dc.lic}) – najniższe wystarczające uprawnienia...`);
            await humanDelay(0.4);
            return go('freight_trucker', { n });
          }
        }
        const a = await assign(id, prefix, kind, name);
        if (a === 'acted') return later(rand(700, 1100));
        if (a === 'nav') return;
        if (a) return back(a, 120);
      }
      if (await ensureWorkerGoes(n, lbl)) return later(rand(600, 1000));
      if (fuelShort()) {
        AP.fuelSoon = true;
        return back('w baku za mało paliwa na tę trasę – najpierw tankowanie', 60);
      }
      if (attempt(n, 'load') > 3) return back('"Załaduj" nie przechodzi – spróbuję później', 180);
      const sec = nextPhaseSec();
      await saveAP();
      setStatus('📦 Załadunek', `${lbl}: zestaw kompletny – rozpoczynam załadunek...`);
      await humanDelay(0.4);
      const r = await act(loadBtn);
      if (r.error) {
        if (tireErr(r)) return tireBlock();
        if (/paliw|fuel/i.test(r.error)) AP.fuelSoon = true;
        return back('Załaduj: ' + r.error, 90);
      }
      started(sec || learn().phase.load);
      return done(sec || learn().phase.load);
    }

    // E2. Inny zielony przycisk akcji (np. wznowienie trasy pod inną nazwą) – kliknij go jak człowiek
    const green = [...root.querySelectorAll('.portlet-title .actions button')]
      .find(b => !b.disabled && /green/.test(b.className) && !isPremium(b) && !isDanger(b));
    if (green) {
      if (attempt(n, 'green') > 3) return back('zielony przycisk nie przechodzi – spróbuję później', 120);
      await saveAP();
      setStatus('▶ Akcja ładunku', `${lbl}: klikam "${btnLabel(green) || 'zielony przycisk'}"...`);
      await humanDelay(0.4);
      const r = await act(green);
      if (r.error) {
        if (tireErr(r)) return tireBlock();
        if (/paliw|fuel/i.test(r.error)) AP.fuelSoon = true;
        return back(`${btnLabel(green) || 'akcja'}: ${r.error}`, 60);
      }
      if (/bez paliwa|out of fuel|no fuel/i.test(stateText)) AP.routeRefuel = null;
      logEvent(`▶ ${lbl}: ${btnLabel(green) || 'akcja'}`);
      return done();
    }

    // F. Trwa załadunek / jazda / rozładunek (albo czeka na paliwo) – nie stoję przy jednym ładunku,
    //    ale wracam dokładnie na koniec etapu (nasz zegar albo "Trwa do" z gry)
    if (/bez paliwa|out of fuel|no fuel/i.test(stateText) && !(AP.routeRefuel && Date.now() - AP.routeRefuel.t < 15 * 60000)) AP.fuelSoon = true;
    AP.status = '⏱ W toku';
    let until = AP.due[n] > Date.now() ? AP.due[n] : trwaDo(document);
    if (!(until > Date.now())) until = Date.now() + 12000;
    AP.due[n] = until;
    return back(null, Math.max(3, Math.ceil((until - Date.now()) / 1000) - 1));
  }

  // Który kierowca do ładunku: wśród wolnych w mieście startu (wypoczętych, z uprawnieniami do typu ładunku) ten
  // z najniższymi wystarczającymi uprawnieniami, przy remisie bardziej wypoczęty. Tylko gdy wybór ma znaczenie
  // (różne uprawnienia); raz na ładunek – gdyby wybór się nie udał, zostaje "Losowy".
  function driverChoice(n, cardEl) {
    if (!cardEl) return null;
    const drvPart = txt(cardEl).split(/Pracownik magazynu/i)[0];
    if (!/\d+\s*dost/i.test(drvPart)) return null;               // kierowca już przydzielony
    const dp = AP.driverPick;
    if (dp && dp.n === n && Date.now() - dp.t < 10 * 60000) return null;
    const row = ((ST.warehouse && ST.warehouse.rows) || []).find(r => r.n === n);
    if (!row || !row.from) return null;
    const ty = row.type || 1;
    const cands = ((ST.employees && ST.employees.list) || []).filter(e => e.role === 'driver' && sameCity(e.loc, row.from) && !e.freight
      && isIdleStatus(e.action) && e.lic > 0 && e.lic >= ty && !(e.energy < S.sleepAt));
    if (cands.length < 2 || new Set(cands.map(e => e.lic)).size < 2) return null;
    const best = cands.sort((a, b) => a.lic - b.lic || (b.energy || 0) - (a.energy || 0))[0];
    return { n, id: String(best.id), name: best.name, lic: best.lic, type: ty, others: cands.filter(e => e !== best).map(e => `${e.name} (${TYPE_SHORT[e.lic] || e.lic})`) };
  }

  // --- Krok Wybór kierowcy (Zmień → Kierowca): konkretny kierowca wskazany przez driverChoice ---
  async function apHandleTruckerSelect() {
    const n = urlParam('n'), dp = AP.driverPick;
    if (!dp || dp.n !== n) return apHandleFreightSelect('freight_trucker');
    if (dp.done) return go('freight', { n });
    dp.done = true;
    await saveAP();
    const root = document.getElementById('page-content') || document.body;
    const re = new RegExp(`select\\w*\\(\\s*['"]?${dp.id}['"]?\\s*[,)]`, 'i');
    const btn = [...root.querySelectorAll('button[onclick], a[onclick]')].find(b => re.test(b.getAttribute('onclick') || '') && !b.disabled);
    const lbl = '#' + n.slice(-3);
    if (!btn) {
      logEvent(`🚛 ${lbl}: ${dp.name} nie do wybrania (zajęty?) – przydział "Losowy"`);
      await humanDelay(0.4);
      return go('freight', { n });
    }
    setStatus('🖐 Wybór kierowcy', `${lbl}: ${dp.name} (${TYPE_SHORT[dp.lic] || dp.lic})...`);
    await humanDelay(0.4);
    const r = await act(btn);
    if (r.error) logEvent(`🚛 ${lbl}: wybór ${dp.name} – ${r.error}`);
    else logEvent(`🚛 ${lbl}: ${dp.name} (${TYPE_SHORT[dp.lic] || dp.lic}) – ${dp.others.join(', ')} ${dp.others.length > 1 ? 'zostają' : 'zostaje'} do naczep wyższego typu`);
    await humanDelay(0.4);
    return go('freight', { n });
  }

  // --- Krok Ręczny wybór zasobu (strona "Zmień"), gdy "Losowy" nie działa ---
  async function apHandleFreightSelect(p) {
    const n = urlParam('n');
    const ms = AP.manualSel;
    if (!ms || ms.n !== n || Date.now() - ms.t > 10 * 60000) {
      return go('warehouse');
    }
    const root = document.getElementById('page-content') || document.body;
    const cands = [...root.querySelectorAll('button, a.btn, input[type=submit], input[type=button]')]
      .filter(b => !b.closest('#ltd-panel') && !b.disabled && !isPremium(b) && !isDanger(b))
      .filter(b => /wybierz|select|przydziel|assign|choose/i.test(btnLabel(b)) || /select|choose|assign/i.test(b.getAttribute('onclick') || ''));
    // Na stronie pracowników mogą być dwie listy (kierowca + pracownik magazynu) – po jednym z każdej
    const groups = new Map();
    cands.forEach(b => { const g = b.closest('.portlet, table') || root; if (!groups.has(g)) groups.set(g, b); });
    const picks = p === 'freight_whemployee' ? [...groups.values()] : cands.slice(0, 1);
    if (!picks.length) {
      const radio = root.querySelector('input[type="radio"]:not([disabled])');
      const submit = radio && radio.form && radio.form.querySelector('button[type="submit"], input[type="submit"]');
      if (radio && submit) {
        radio.click();
        picks.push(submit);
      }
    }
    if (!picks.length) {
      dumpButtons(`Ręczny wybór (${p})`);
      setCool('f:' + n, 5 * 60);
      block(n, '#' + n.slice(-3), `nie umiem wybrać zasobu na stronie "${p}" – zapisz ją (Ctrl+S) i podeślij`);
      setStatus('⚠️ Ręczny wybór', `Nie znalazłem przycisku wyboru na stronie ${p}. Wracam do Magazynu...`);
      await humanDelay(1.5);
      return go('warehouse');
    }
    for (const b of picks) {
      setStatus('🖐 Ręczny wybór', `Wybieram: ${btnLabel(b) || 'pozycja'}...`);
      await humanDelay(0.4);
      await act(b);
    }
    return go('freight', { n });
  }

  // --- Krok Stacja Paliw: zbiornik firmy → korporacja (niebieski) → publiczne; pojedynczo, bez premium ---
  function nextRefuel() {
    const root = document.getElementById('page-content') || document.body;
    for (const tb of root.querySelectorAll('tbody[id^="truck-"]')) {
      const id = tb.id.replace('truck-', '');
      if (isCool('fuel:' + id)) continue;
      const t = unitById('truck', id);
      if ((AP.busyRepair && AP.busyRepair['truck' + id] > Date.now()) || (AP.busyFuel && AP.busyFuel[id] > Date.now())
        || (t && inService(t))) continue;                          // najpierw serwis, potem tankowanie; nie tankuj drugi raz
      const lvl = tankLevel(tb);
      if (lvl && lvl.cur >= lvl.max * 0.97) continue;
      const get = p => [...tb.querySelectorAll(`button[onclick^="${p}("]`)].find(b => !b.disabled) || null;
      const pub = get('refuel'), corp = get('refuelc'), tank = get('refuelft');
      // Czas tankowania z kolumny "Czas" (np. 00:01:23) – tyle ciężarówka będzie zajęta
      const sec = [...tb.querySelectorAll('td')].map(td => hms(txt(td))).find(Number.isFinite) || 90;
      if (pub || corp || tank) return { id, tb, lvl, sec, pub, corp, tank };
    }
    return null;
  }

  async function apHandleFuelstation() {
    parsePage(document, 'fuelstation');
    if (!AP.autoFuel) {
      return go('warehouse');
    }
    const round = AP.fuelRound || (AP.fuelRound = { visited: [], refuels: 0, seen: [], started: Date.now() });
    round.seen = round.seen || [];
    const tabs = fuelTabs(document);
    const cur = String(urlParam('f') ?? ((tabs.find(t => t.active) || tabs[0] || {}).f ?? '0'));
    if (!round.visited.includes(cur)) round.visited.push(cur);
    const tab = tabs.find(t => String(t.f) === cur);
    const tabName = (tab && tab.name) || 'bieżąca zakładka';
    const onRoute = cur === '0' || /na trasie|on route/i.test(tabName);
    const pubP = ST.fuel && ST.fuel.tabPub && ST.fuel.tabPub[cur];
    const root = document.getElementById('page-content') || document.body;
    for (const tb of root.querySelectorAll('tbody[id^="truck-"]')) {
      const id = tb.id.replace('truck-', '');
      if (!round.seen.includes(id)) round.seen.push(id);
    }

    for (let i = 0; i < 10; i++) {
      const x = nextRefuel();
      if (!x) break;
      setCool('fuel:' + x.id, 240);
      await saveAP();
      const name = txt(x.tb.querySelector('td')) || 'Ciężarówka';
      const corp = ST.fuel && ST.fuel.corp;
      const need = x.lvl ? x.lvl.max - x.lvl.cur : null;
      // Korporacja, jeśli wystarczy litrów na pełny bak i nie jest droższa od publicznego; inaczej publiczne
      const corpOk = !!x.corp && (!corp || ((corp.avail == null || need == null || corp.avail >= need)
        && (corp.price == null || pubP == null || corp.price <= pubP)));
      const order = [x.tank && ['zbiornik firmy', x.tank], corpOk && ['korporacja', x.corp], x.pub && ['publiczne', x.pub]].filter(Boolean);
      let ok = null;
      for (const [how, b] of order) {
        if (!b.isConnected) continue;
        setStatus('⛽ Tankowanie', `${name} (${tabName}): paliwo – ${how}${need ? `, ${Math.round(need)} L` : ''}...`);
        await humanDelay(0.4);
        const r = await act(b);
        if (!r.error) { ok = how; break; }
        AP.statusDetail = `${name}: ${how} – gra odpowiedziała: ${r.error}`;
        renderStatus();
        await humanDelay(0.6);
      }
      if (ok) {
        AP.stats.refuels++;
        round.refuels++;
        if (ok === 'korporacja' && corp && corp.avail != null && need) corp.avail = Math.max(0, corp.avail - need);
        const until = Date.now() + x.sec * 1000;
        if (x.sec > 0 && x.sec < 1800) learn().refuelSec = ema(learn().refuelSec, x.sec, 0.3);
        ST.fuelLevels[x.id] = { cur: x.lvl ? x.lvl.max : 999, max: x.lvl ? x.lvl.max : 999, t: Date.now() };
        // Ciężarówka tankuje przez "Czas" – patrol obudzi się dokładnie na koniec
        AP.busyFuel = { ...(AP.busyFuel || {}), [x.id]: until };
        const ft = unitById('truck', x.id);
        if (ft && isIdleStatus(ft.status)) ft.status = 'Tankowanie';
        AP.due['fuel:' + x.id] = until + 1500;
        // W trasie: po tankowaniu trzeba wejść w ładunek i kliknąć zielony przycisk (Kontynuuj)
        if (onRoute) AP.routeRefuel = { until: Math.max(until, (AP.routeRefuel && AP.routeRefuel.until) || 0) + 2000, t: Date.now() };
        logEvent(`⛽ ${name}: zatankowano (${ok}${need ? `, ${Math.round(need)} L` : ''}${onRoute ? ', w trasie' : ''}) – gotowa za ${fmtDur(x.sec)}`);
      } else if (order.length) {
        // Nie udało się (np. brak pieniędzy) – nie blokuj floty w nieskończoność
        ST.fuelLevels[x.id] = { ...(x.lvl || { cur: 0, max: 999 }), t: Date.now(), failed: true };
      }
      await humanDelay(0.3);
    }

    // Kolejne zakładki (Na trasie / kraje), w których stoją ciężarówki do zatankowania
    const next = fuelTabs(document).find(t => t.count > 0 && !round.visited.includes(String(t.f)));
    if (next && round.visited.length < 15) {
      setStatus('⛽ Tankowanie', `Przechodzę do zakładki: ${next.name} (${next.count})...`);
      await humanDelay(0.5);
      return go('fuelstation', { f: next.f, t: 0 });
    }

    // Stojące ciężarówki, których stacja nie pokazała w żadnej zakładce, mają pełny bak
    AP.fuelSeen = AP.fuelSeen || {};
    for (const t of ((ST.garage && ST.garage.trucks) || [])) {
      if (isIdleStatus(t.status) && !round.seen.includes(String(t.id))) {
        const tank = truckSpec(t).tank;
        ST.fuelLevels[t.id] = { cur: tank, max: tank, t: Date.now(), assumed: true };
        AP.fuelSeen[t.id] = Date.now();
      }
    }
    // Obsłużone = zatankowane, pełne albo bez szans (np. brak pieniędzy); ciężarówka w serwisie wróci, gdy będzie wolna
    for (const id of round.seen) {
      const lv = ST.fuelLevels[id];
      if (lv && (lv.failed || lv.cur >= lv.max * 0.9)) AP.fuelSeen[id] = Date.now();
    }
    for (const [id, t] of Object.entries(AP.fuelSeen)) if (Date.now() - t > 600000) delete AP.fuelSeen[id];
    AP.fuelRound = null;
    AP.lastFuelRound = Date.now();
    AP.fuelSoon = false;
    setCool('fuelround', 20);
    setStatus('Koniec tankowania', `Zatankowano: ${round.refuels}. Wracam do Magazynu...`);
    await humanDelay(0.6);
    return toPlanner();
  }

  // --- Krok Pracownicy (lista) – samo odświeżenie danych, decyzje podejmuje Magazyn ---
  async function apHandleEmployees() {
    parsePage(document, 'employees');
    setStatus('Powrót do floty', 'Wracam do Magazynu...');
    await humanDelay(0.8);
    return go('warehouse');
  }

  // --- Krok Strona pracownika: sen pojedynczo ("Idź spać" dla wszystkich jest tylko dla premium) ---
  function findSleepButton() {
    const root = document.getElementById('page-content') || document.body;
    const scored = [...root.querySelectorAll('button, a, input[type=button], input[type=submit]')]
      .filter(b => !b.closest('#ltd-panel') && !b.disabled && !isPremium(b) && !isDanger(b))
      .map(b => {
        const code = ((b.getAttribute('onclick') || '') + ' ' + (b.getAttribute('href') || '')).toLowerCase();
        const lab = btnLabel(b).toLowerCase();
        let s = 0;
        if (/sleep|spac/.test(code)) s += 3;
        if (/spa[ćc]|[śs]pij|sleep|odpocz|\bsen\b/.test(lab)) s += 2;
        if (b.querySelector('.fa-bed, .fa-moon')) s += 2;
        return { b, s };
      })
      .filter(x => x.s >= 2)
      .sort((a, b) => b.s - a.s);
    return scored.length ? scored[0].b : null;
  }

  // Ewentualne okienko potwierdzenia po kliknięciu "Idź spać"
  async function confirmModal() {
    const m = [...document.querySelectorAll('.modal.in, .modal.show, .bootbox, .swal2-popup')].find(x => x.offsetParent !== null);
    if (!m) return false;
    const ok = [...m.querySelectorAll('button, a.btn')].find(b => /^(tak|yes|ok|potwierd[źz]|confirm|id[źz] spa[ćc]|spa[ćc])/i.test(btnLabel(b)) && !isDanger(b));
    if (!ok) return false;
    await act(ok);
    return true;
  }

  async function apHandleEmployeeSelect() {
    const id = urlParam('e');
    readEmployeeDetail(document, id);
    if (AP.fireTask && String(AP.fireTask.id) === String(id)) return fireEmployee(AP.fireTask);
    if (!AP.autoSleep || !AP.sleepTarget || String(AP.sleepTarget) !== String(id)) {
      return go('warehouse');
    }
    AP.sleepTarget = null;
    const emp = ((ST.employees && ST.employees.list) || []).find(x => String(x.id) === String(id));
    const name = (emp && emp.name) || 'Pracownik';
    const b = findSleepButton();
    if (!b) {
      dumpButtons('Strona pracownika (sen)');
      setCool('sleep:' + id, 20 * 60);
      setStatus('⚠️ Sen', `${name}: nie znalazłem przycisku "Idź spać" na stronie pracownika.`);
      await humanDelay(2);
      return go('warehouse');
    }
    setCool('sleep:' + id, 30 * 60);
    AP.stats.sleeps = (AP.stats.sleeps || 0) + 1;
    await saveAP();
    setStatus('😴 Sen', `${name} (energia ${emp ? emp.energy + '%' : '?'}): klikam "${btnLabel(b) || 'Idź spać'}"...`);
    await humanDelay(0.5);
    const r = await act(b);
    await confirmModal();
    if (r.error) {
      AP.stats.sleeps--;
      setCool('sleep:' + id, 10 * 60);
      setStatus('⚠️ Sen', `${name}: gra odpowiedziała: ${r.error}`);
      await humanDelay(1.5);
    } else {
      if (emp) emp.action = 'Śpi';
      logEvent(`😴 ${name} poszedł spać (energia ${emp ? emp.energy + '%' : '?'})`);
    }
    await refreshEmployees();
    return toPlanner();
  }

  // --- Krok Garaż: zmiana opon na sezon + naprawy stojących pojazdów + relokacja naczepy (Auto-Inwestycje) ---
  async function apHandleGarage() {
    const units = parsePage(document, 'garage') || [];

    // Zadanie 0: Obsługa relokacji naczepy po zakupie (Auto-Inwestycje)
    if (AP.investState && AP.investState.step === 'transfer_trailer') {
      const trailers = (ST.garage && ST.garage.trailers) || [];
      const targetTier = AP.investState.targetTier;
      const truckCity = AP.investState.truckCity;
      const fresh = trailers.filter(t => t.type === targetTier).sort((a, b) => (a.age || 0) - (b.age || 0));
      const there = fresh.find(t => sameCity(t.loc, truckCity));
      const targetTrailer = there || fresh.find(t => isIdleStatus(t.status)) || fresh[0];

      if (targetTrailer) {
        if (there) {
          AP.stats.investments = (AP.stats.investments || 0) + 1;
          logEvent(`🎉 Nowa naczepa (${TYPES[targetTier]}) jest w ${truckCity} – inwestycja ukończona`);
          AP.investState = null;
          setStatus('🎉 Zestaw gotowy!', `Naczepa (${TYPES[targetTier]}) jest w ${truckCity}. Inwestycja ukończona.`);
          await humanDelay(1.2);
          return go('warehouse');
        }
        setStatus('🚚 Transfer naczepy', `Naczepa stoi w ${targetTrailer.loc || 'innym mieście'}, ciągnik w ${truckCity}. Otwieram panel naczepy...`);
        await humanDelay(0.7);
        return go('garage_trailer', { t: targetTrailer.id });
      }
    }

    // Zadanie 1: Opony na sezon ("Opony letnie"/"Opony zimowe" w menu Opcje – zmienia całą flotę)
    const task = AP.tireTask;
    if (task && task.action === 'switch') {
      AP.tireTask = null;
      setCool('tireswitch', 10 * 60);
      await saveAP();
      const link = document.querySelector(`a[onclick*="tireswitchall${task.type}"]`);
      if (link) {
        const worn = (task.worn || []).map(id => unitById('truck', id)).filter(Boolean);
        setStatus('🛞 Opony', worn.length
          ? `Zużyte opony (${worn.map(t => t.name).join(', ')}) – zakładam nowe ${TIRE_PL[task.type]}...`
          : `Zakładam opony ${TIRE_PL[task.type]} na całą flotę...`);
        await humanDelay(0.6);
        const r = await act(link);
        if (r.error) logEvent(`🛞 Zmiana opon: ${r.error}`);
        else {
          AP.stats.tires = (AP.stats.tires || 0) + 1;
          logEvent(`🛞 Założono opony ${TIRE_PL[task.type]}${worn.length ? ` (zużyte: ${worn.map(t => t.name).join(', ')})` : ''}`);
          // Wynik sprawdzi kolejny odczyt opon na stronie ładunku; bez poprawy – prośba o ręczną wymianę zamiast pętli
          for (const t of worn) {
            AP.tireTry = { ...(AP.tireTry || {}), [t.id]: Date.now() };
            if (ST.tireCond && ST.tireCond[t.id]) ST.tireCond[t.id].pending = Date.now();
          }
          ST.tires = null;   // stan magazynu opon zmienił się – odśwież przy kolejnym przebiegu
        }
        await refreshGarage();
      } else {
        dumpButtons('Garaż (opony)');
      }
    }

    // Zadanie 2: Naprawa stojących pojazdów < repairAt albo za słabych na dłuższą trasę (każdy osobno)
    if (AP.autoRepair) {
      let fixed = 0;
      for (const u of units) {
        if (fixed >= 4) break;
        if (!needsRepair(u) || !isIdleStatus(u.status) || inService(u, u.kind)) continue;
        const rf = AP.repairFor && AP.repairFor[u.kind + u.id];
        const k = 'rep:' + u.kind + u.id;
        if (isCool(k)) continue;
        setCool(k, 600);
        const b = document.getElementById(`repairbtn-${u.kind}${u.id}`);
        if (!b || b.disabled) continue;
        await saveAP();
        setStatus('🔧 Naprawa', `Zlecam naprawę: ${u.name} (stan ${u.cond}%)...`);
        await humanDelay(0.6);
        const st = document.getElementById(`action-${u.kind}${u.id}`);
        const r = await act(b, { until: () => st && /konserwac|maintenance/i.test(st.textContent) });
        if (r.error) {
          AP.statusDetail = `${u.name}: gra odpowiedziała: ${r.error}`;
          // Naprawa odrzucona z braku mechaników – kolejny kontrakt z większą liczbą (od razu, bez czekania na koniec bieżącego)
          if (/mechani/i.test(r.error)) {
            AP.mechLearned = Math.max(AP.mechLearned || 0, ((ST.mech && ST.mech.count) || 0) + 1);
            if (AP.cool) delete AP.cool.mech;
            ST.mech && (ST.mech.t = 0);
            logEvent(`🔧 Za mało mechaników do napraw – utrzymuję co najmniej ${AP.mechLearned}`);
          }
          renderStatus();
          await humanDelay(1);
        } else {
          AP.stats.repairs++;
          fixed++;
          // Serwis trwa – do czasu odświeżenia garażu pamiętamy go sami (żadnego tankowania ani zlecenia w tym czasie)
          AP.busyRepair = { ...(AP.busyRepair || {}), [u.kind + u.id]: Date.now() + 90000 };
          AP.repClick = { ...(AP.repClick || {}), [u.kind + u.id]: Date.now() };
          AP.repLast = { ...(AP.repLast || {}), [u.kind + u.id]: Date.now() };
          if (AP.repairFor) delete AP.repairFor[u.kind + u.id];
          const su = unitById(u.kind, u.id);
          if (su) su.status = 'W konserwacji';
          logEvent(`🔧 Naprawa: ${u.name} (stan był ${u.cond}%${u.cond >= S.repairAt && rf ? ` – ${rf.why}` : ''})`);
        }
        await humanDelay(0.5);
      }
    }

    setStatus('Powrót do Magazynu', 'Garaż obsłużony. Wracam do Magazynu...');
    await humanDelay(0.8);
    return toPlanner();
  }

  // --- Krok Opony ciężarówki (Garaż → ciężarówka → "Zmień"): wybór najlepszego kompletu z magazynu ---
  // Wiersze: obecny komplet ("Obecny") i komplety z magazynu z przyciskiem "Wybierz" = tireswitch(id opon, rodzaj)
  function readTireChoice(doc) {
    let current = null;
    const options = [];
    for (const tr of doc.querySelectorAll('table tbody tr')) {
      const c = [...tr.querySelectorAll('td')].map(txt);
      if (c.length < 3) continue;
      const all = c.join(' ');
      const type = tr.querySelector('.fa-snowflake') || /\bzim|winter/i.test(all) ? 'winter' : tr.querySelector('.fa-sun') || /\blat|summer/i.test(all) ? 'summer' : null;
      const cond = pct(all);
      if (!type || !Number.isFinite(cond)) continue;
      const b = tr.querySelector('button[onclick^="tireswitch("]');
      if (b) options.push({ id: (b.getAttribute('onclick').match(/tireswitch\((\d+)/) || [])[1], type, cond, btn: b });
      else if (/obecny|current/i.test(all)) current = { type, cond };
    }
    return { current, options };
  }

  async function apHandleTruckTires() {
    const job = AP.tireMount;
    // id ciężarówki z adresu, a gdy go brak – ze skryptu strony (truckid: …)
    const tid = urlParam('t') || ((document.documentElement.innerHTML.match(/truckid:\s*(\d+)/) || [])[1]);
    if (!job || String(job.truckId) !== String(tid)) return go('warehouse');
    const info = readTireChoice(document);
    const t = unitById('truck', tid) || { id: tid, name: 'Ciężarówka' };
    const end = async (msg, fail, coolSec = 0) => {
      AP.tireMount = null;
      ST.tires = null;   // stan magazynu opon się zmienił – odśwież przy kolejnym przebiegu
      if (msg) logEvent(msg);
      if (fail && job.worn) {
        AP.tireTry = { ...(AP.tireTry || {}), [tid]: Date.now() };
        notify('LogiTycoon: wymień opony', `${t.name}: ${fail}`);
      }
      if (coolSec) setCool('tiremount:' + tid, coolSec);
      await humanDelay(0.5);
      return go('warehouse');
    };
    if (!info.current && !info.options.length) {
      // Inna wersja strony – raz przez stronę ciężarówki (przycisk "Zmień" przy oponach)
      if (!job.viaTruck) {
        job.viaTruck = true;
        await saveAP();
        return go('garage_truck', { t: tid });
      }
      return end('🛞 Nie znalazłem listy opon do wyboru', 'nie znalazłem wyboru opon – załóż nowy komplet ręcznie (Garaż → ciężarówka → Zmień)', 30 * 60);
    }
    const cur = info.current;
    // Założony komplet jest już dobry (po zmianie albo odczyt był nieaktualny) – zapamiętaj stan i koniec
    if (cur && job.types.includes(cur.type) && cur.cond >= job.minCond) {
      ST.tireCond = ST.tireCond || {};
      ST.tireCond[tid] = { cond: cur.cond, type: cur.type, t: Date.now() };
      t.tires = cur.type;
      if (job.clicks) AP.stats.tires = (AP.stats.tires || 0) + 1;
      return end(job.clicks ? `🛞 ${t.name}: założono opony ${TIRE_PL[cur.type]} (${cur.cond}%)` : null);
    }
    const pick = info.options
      .filter(o => job.types.includes(o.type) && o.cond >= job.minCond && (!cur || o.type !== cur.type || o.cond > cur.cond + 5))
      .sort((a, b) => b.cond - a.cond)[0];
    // Magazyn opon był odczytany wcześniej i dobrego kompletu już nie ma – planer kupi nowy
    if (!pick) return end(`🛞 ${t.name}: brak dobrego kompletu (${job.types.map(x => TIRE_PL[x]).join(' / ')}) w magazynie opon`, null, 600);
    if (job.clicks >= 2) return end(`🛞 ${t.name}: zmiana opon nie przechodzi`, 'zmiana opon nie przechodzi – załóż nowy komplet ręcznie (Garaż → ciężarówka → Zmień)', 30 * 60);
    job.clicks++;
    await saveAP();   // gra po wyborze sama przeładowuje stronę – licznik prób musi być już zapisany
    setStatus('🛞 Opony', `${t.name}: zakładam ${TIRE_PL[pick.type]} (${pick.cond}%) zamiast ${cur ? `${TIRE_PL[cur.type]} (${cur.cond}%)` : 'obecnych'}...`);
    await humanDelay(0.5);
    const r = await act(pick.btn);
    if (r.error) return end(`🛞 ${t.name}: ${r.error}`, `gra odrzuciła zmianę opon: ${r.error}`, 30 * 60);
    // Gdy strona sama się nie przeładowała – sprawdzam "Obecny" na świeżej stronie
    await sleep(1500);
    return go('garage_truck_wtires', { t: tid });
  }

  // --- Strona ciężarówki: sprzedaż (wymiana na lepszy model) albo droga do wyboru opon ("Zmień" przy oponach) ---
  async function apHandleGarageTruck() {
    const st = AP.sellTask;
    if (st && st.kind === 'truck' && String(st.id) === String(urlParam('t'))) return sellUnit(st);
    const job = AP.tireMount;
    if (!job || String(job.truckId) !== String(urlParam('t'))) return go('warehouse');
    const root = document.getElementById('page-content') || document.body;
    const link = root.querySelector('[href*="wtires"], [onclick*="wtires"]')
      || [...root.querySelectorAll('a, button')].find(el => /zmie[ńn]/i.test(btnLabel(el)) && !isDanger(el) && !isPremium(el)
        && /opon|tires/i.test(txt(el.closest('.row-static, tr, li'))));
    if (!link) {
      AP.tireMount = null;
      setCool('tiremount:' + job.truckId, 30 * 60);
      logEvent('🛞 Nie znalazłem przycisku zmiany opon na stronie ciężarówki');
      return go('warehouse');
    }
    setStatus('🛞 Opony', 'Otwieram wybór opon ciężarówki...');
    await humanDelay(0.4);
    await humanClick(link);
    await sleep(6000);
    return go('warehouse');
  }

  // --- Krok Sklep: zakup kompletów opon (Opony zimowe / Opony letnie) ---
  function shopTireItem(type) {
    const root = document.getElementById('page-content') || document.body;
    const want = type === 'winter' ? /opony zimowe|winter tires/i : /opony letnie|summer tires/i;
    for (const card of root.querySelectorAll('.mt-action')) {
      if (!want.test(txt(card.querySelector('.mt-action-row')))) continue;
      const btn = card.querySelector('button[id^="buy"]');
      const id = btn ? btn.id.replace('buy', '') : null;
      const amountEl = (id && document.getElementById('amount' + id)) || card.querySelector('[id^="amount"]');
      const price = parseMoney((jtxt(card).match(/Cena:?\s*\|?\s*€\s*[\d.]+/i) || [''])[0]);
      const owned = () => {
        const v = parseInt(txt(amountEl));
        if (Number.isFinite(v)) return v;
        const m = jtxt(card).match(/Posiadasz:?\s*\|?\s*(\d+)/i);
        return m ? +m[1] : 0;
      };
      return { btn, price: price > 0 ? price : 2000, owned };
    }
    return null;
  }

  async function apHandleShop() {
    const task = AP.tireTask;
    if (!task || task.action !== 'buy') return go('warehouse');
    AP.tireTask = null;
    setCool('tirebuy', 15 * 60);
    const item = shopTireItem(task.type);
    if (!item || !item.btn || item.btn.disabled) {
      dumpButtons('Sklep (opony)');
      logEvent(`🛞 Nie mogę kupić opon ${TIRE_PL[task.type]} (przycisk niedostępny)`);
      return go('warehouse');
    }
    let bought = 0;
    for (let i = 0; i < task.n; i++) {
      // Zużyte opony blokują ciężarówkę – to koszt bieżący (jak paliwo), nie zakup "z nadwyżki"
      if (!canSpend(item.price, task.worn ? 'ops' : 'tires')) {
        logEvent(`🛞 Za mało pieniędzy na opony ${TIRE_PL[task.type]}${task.worn ? '' : ` (rezerwa ${fmt(S.reserve)})`}`);
        break;
      }
      const before = item.owned();
      setStatus('🛞 Zakup opon', `Kupuję komplet opon ${TIRE_PL[task.type]} (${i + 1}/${task.n}) za ${fmt(item.price)}...`);
      await saveAP();
      await humanDelay(0.5);
      const r = await act(item.btn, { until: () => item.owned() > before });
      if (r.error || item.owned() <= before) {
        if (r.error) logEvent(`🛞 Zakup opon: ${r.error}`);
        break;
      }
      bought++;
      AP.stats.tires = (AP.stats.tires || 0) + 1;
      if (ST.balance != null) ST.balance -= item.price;
      await humanDelay(0.4);
    }
    if (bought) {
      logEvent(`🛞 Kupiono ${bought}× opony ${TIRE_PL[task.type]}`);
      setCool('tirebuy', 60);
    }
    ST.tires = null;   // wymuś odświeżenie stanu magazynu opon
    return go('warehouse');
  }

  // --- Krok Media: przyjęcie wybranej umowy (najtańszej, która pokrywa zużycie) ---
  async function apHandleUtilities() {
    readUtilities(document);
    const task = AP.utilTask;
    if (!task) return go('warehouse');
    AP.utilTask = null;
    setCool('util:' + task.key, 20 * 60);
    await saveAP();   // gdyby gra przeładowała stronę po przyjęciu umowy, nie może przyjąć drugiej
    const radio = document.querySelector(`#contracts input[name="id"][value="${task.offerId}"]`);
    const btn = document.getElementById('accept');
    if (!radio || !btn || btn.disabled) {
      logEvent('⚡ Media: wybrana oferta zniknęła – sprawdzę ponownie');
      setCool('util:' + task.key, 60);
      ST.util = null;
      return go('warehouse');
    }
    const row = radio.closest('tr');
    await humanClick(row || radio);
    if (!radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await humanDelay(0.4);
    const r = await act(btn);
    if (r.error) {
      logEvent(`⚡ Media: ${r.error}`);
      notify('LogiTycoon: media', `Nie udało się przyjąć umowy: ${r.error}`);
    } else {
      AP.stats.contracts = (AP.stats.contracts || 0) + 1;
      logEvent(`⚡ Nowa umowa: ${task.key === 'elec' ? 'prąd' : 'woda'}`);
    }
    ST.util = null;
    await refreshPage('utilities');
    return go('warehouse');
  }

  // --- Krok Kontrakty: przyjęcie wybranego kontraktu z mechanikami ---
  async function apHandleContracts() {
    if (!checkSafety()) return;
    readContracts(document);
    const task = AP.mechTask;
    if (!task) return go('warehouse');
    AP.mechTask = null;
    await saveAP();   // gdyby gra przeładowała stronę po przyjęciu, nie może przyjąć drugiego
    const radio = document.querySelector(`#contracts input[name="id"][value="${task.offerId}"]`);
    const btn = document.getElementById('accept');
    if (!radio || !btn || btn.disabled) {
      logEvent('🔧 Mechanicy: wybrana oferta zniknęła – sprawdzę ponownie');
      setCool('mech', 60);
      ST.mech = null;
      return go('warehouse');
    }
    if (!canSpend(task.perHour * 3, 'ops')) {
      logEvent(`🔧 Mechanicy: za mało pieniędzy na kontrakt (${fmt(task.perHour)}/h)`);
      return go('warehouse');
    }
    const before = (ST.mech && ST.mech.count) || 0;
    await humanClick(radio.closest('tr') || radio);
    if (!radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await humanDelay(0.4);
    const r = await act(btn);
    ST.mech = null;
    await refreshPage('contracts');
    const after = (ST.mech && ST.mech.count) || 0;
    if (r.error && !(after > before)) {
      logEvent(`🔧 Mechanicy: ${r.error}`);
      notify('LogiTycoon: mechanicy', `Nie udało się przyjąć kontraktu: ${r.error}`);
    } else {
      AP.stats.contracts = (AP.stats.contracts || 0) + 1;
      logEvent(`🔧 Kontrakt: ${task.amount} mechaników za ${fmt(task.perHour)}/h na ${task.hours} h (teraz ${after || '?'} mechaników)`);
    }
    return go('warehouse');
  }

  // --- Krok Trasy: zlecenie dla KAŻDEGO wolnego zestawu, z miasta, w którym stoi, wg prawdziwego zysku na godzinę ---
  async function apHandleTrips() {
    const rows = parsePage(document, 'trips') || [];
    if (!AP.autoTrips) {
      return go('warehouse');
    }
    let plan = AP.tripPlan && AP.tripPlan.length ? AP.tripPlan : null;
    if (!plan) {
      await refreshData(60000);
      plan = tripNeeds();
    }
    AP.tripPlan = null;
    const w = ST.warehouse;
    let space = w ? w.cap - w.used : 1;

    if (!plan.length || space <= 0) {
      setStatus('Trasy', space <= 0 ? 'Magazyn pełny – przechodzę do realizacji ładunków...' : 'Brak wolnych zestawów – wracam do Magazynu...');
      await humanDelay(0.8);
      return go('warehouse');
    }

    const taken = new Set();
    let accepted = 0;
    const load = botLoad();
    pruneRepairFor();
    for (const need of plan) {
      const coolKey = `trips:${norm(need.city)}:${need.type}`;
      const set = setFor(need.city, need.type);
      const truck = unitById('truck', need.truckId) || (set && set.truck);
      const trailer = unitById('trailer', need.trailerId) || (set && set.trailer);
      for (let k = 0; k < need.n && space > 0; k++) {
        // Twardo: trasa w zasięgu pełnego baku najsłabszej wolnej ciężarówki z miasta; ocena efektywna (obciążenie bota)
        const rk = rankTrips(rows.filter(x => !taken.has(x)), need, truck, trailer, load);
        const best = rk.ok[0], top = rk.list[0];
        // Najlepsza trasa wymaga lepszej kondycji niż ma ciężarówka/naczepa: naprawa i dopiero potem dłuższa trasa,
        // jeśli razem z czasem naprawy wychodzi wyraźnie lepiej niż najlepsza trasa możliwa teraz
        if (top && !top.condOk && top.fixable && AP.autoRepair && rk.lim.weak && k === 0) {
          const lim = rk.lim, wk = lim.weak;
          const weak = lim.units.filter(({ kind, u }) => condRange(u, kind) < top.x.km && u.cond < 97
            && !(AP.repLast && AP.repLast[kind + u.id] > Date.now() - 30 * 60000));
          // naprawy ciężarówki i naczepy idą równolegle – liczy się dłuższa
          const rs = Math.max(30, ...weak.map(({ kind, u }) => repairSecOf(u, kind)));
          const withRepair = top.e.profit / (top.cyc + rs) * 3600;
          if (weak.length && (!best || withRepair > best.eff * 1.15)) {
            AP.repairFor = AP.repairFor || {};
            weak.forEach(({ kind, u }) => { AP.repairFor[kind + u.id] = { km: top.x.km, why: `kondycja starczy na ~${condRange(u, kind)} km, a lepsze trasy mają ~${top.x.km} km`, t: Date.now() }; });
            setCool(coolKey, Math.ceil(rs) + 60);
            logEvent(`🔧 ${need.city}: ${wk.u.name} (${wk.u.cond}%) wystarczy na ~${wk.km} km, a najlepsza trasa ma ${top.x.km} km (${fmt(withRepair)}/h z naprawą` +
              `${best ? ` vs ${fmt(best.eff)}/h teraz na ${best.x.km} km` : ''}) – najpierw naprawa`);
            setStatus('🔧 Kondycja przed trasą', `${need.city}: naprawa ${weak.map(x => x.u.name).join(', ')}, potem dłuższa trasa...`);
            await humanDelay(0.6);
            break;
          }
        }
        if (!best) {
          setCool(coolKey, 5 * 60);
          const lim = rk.lim;
          const why = rk.list.length ? (lim.condKm >= lim.ageKm ? `Maksymalny dystans pojazdu (wiek) to ~${lim.ageKm} km` : `kondycja pozwala tylko na ~${lim.condKm} km`)
            : rk.tooLong ? `opłacalne trasy są dłuższe niż pełny bak (~${lim.fuelKm} km)` : 'brak opłacalnej trasy';
          setStatus('Brak tras', `${need.city} (${TYPES[need.type] || 'typ ' + need.type}): ${why}. Sprawdzę ponownie za 5 min.`);
          await humanDelay(0.8);
          break;
        }
        taken.add(best.x);
        const form = best.x.r.closest('form');
        const submitBtn = (form && form.querySelector('button[type="submit"], input[type="submit"]'))
          || document.getElementById('submit-desttrips')
          || document.getElementById('submit-trips');
        if (!submitBtn) {
          setCool(coolKey, 5 * 60);
          break;
        }

        // Blokada przed dublowaniem zlecenia, gdyby gra przeładowała stronę w trakcie (dalej pilnuje licznik "Przyjęty" w magazynie)
        setCool(coolKey, 25);
        await saveAP();
        const effTxt = `${fmt(best.eff)}/h${best.botBound ? ` (zestaw i tak wróci do pracy po ~${fmtDur(best.cyc)} – tyle bot potrzebuje na ${load.K} ${plural(load.K, 'zestaw', 'zestawy', 'zestawów')})` : ''}`;
        setStatus('🚀 Wybór zlecenia', `${best.x.from} → ${best.x.to} (${best.x.km} km): zysk ~${fmt(best.e.profit)}, ${effTxt}${best.x.corp ? ' · korporacyjne' : ''}...`);
        await humanDelay(0.4);
        await humanClick(best.x.r);
        const radio = best.x.r.querySelector('input[type="radio"]');
        if (radio && !radio.checked) {
          await sleep(rand(50, 100));
          radio.checked = true;
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await humanDelay(0.3);
        const r = await act(submitBtn, { reenable: true, timeout: 9000 });
        if (r.error) {
          setCool(coolKey, 3 * 60);
          setStatus('⚠️ Zlecenie', `Gra nie przyjęła zlecenia: ${r.error}`);
          await humanDelay(1.2);
          break;
        }
        accepted++;
        space--;
        AP.stats.profitEst += best.e.profit;
        AP.accTrips = (AP.accTrips || []).filter(a => Date.now() - a.t < 3 * 3600000)
          .concat({ km: best.x.km, price: best.x.price, traffic: best.x.traffic || 0, from: best.x.from, to: best.x.to, t: Date.now() }).slice(-20);
        logEvent(`📦 Zlecenie ${best.x.from} → ${best.x.to} (${best.x.km} km${best.x.traffic ? `, ${best.x.traffic > 1 ? 'duże' : 'średnie'} korki` : ''}): ~${fmt(best.e.profit)}, ${fmt(best.eff)}/h${best.botBound ? ` przy cyklu ~${fmtDur(best.cyc)}` : ''}`);
        await humanDelay(0.5);
      }
    }

    setStatus('Zlecenia', accepted
      ? `Przyjęto zleceń: ${accepted}. Przechodzę do Magazynu, aby wysłać zestawy...`
      : 'Wracam do Magazynu...');
    await humanDelay(0.6);
    return toPlanner();
  }

  // --- Krok Licencja Firmy: Auto-rozwój (kolejny typ dla istniejącego zestawu) albo nowy zestaw z naczepą nowego typu ---
  async function apHandleTransportLicense() {
    if (!checkSafety()) return;
    readLicenses(document);
    const ns = AP.newSet && AP.newSet.step === 'company_license' ? AP.newSet : null;
    const job = ns || AP.investState;
    if (!job) {
      return go('warehouse');
    }
    const targetTier = ns ? ns.licType : job.targetTier;
    const tier = TIERS[targetTier];
    // Licencja gotowa: Auto-rozwój → prawo jazdy kierowcy; nowy zestaw → zakupy (pieniądze na licencję już wydane)
    const next = async () => {
      if (ns) {
        ns.extras = Math.max(0, (ns.extras || 0) - (ns.licCost || 0));
        ns.licCost = 0;
        newSetAdvance(ns);
        if (await resumeNewSet()) return;
        return go('warehouse');
      }
      if (job.licenseOnly) {
        // Rozpoznanie zakończone: salon naczep i trasy pokażą teraz ceny i stawki nowego typu
        AP.investState = null;
        AP.stats.investments = (AP.stats.investments || 0) + 1;
        ST.trailerShop = null;
        await humanDelay(0.8);
        return go('warehouse');
      }
      // Najpierw naczepa (sprawdzona w garażu), dopiero potem egzamin kierowcy – wcześniej przy nieudanym zakupie
      // naczepy zostawał przeszkolony kierowca bez naczepy
      job.step = 'buy_trailer';
      await humanDelay(0.8);
      return go('trailerstore');
    };
    const cancel = async msg => {
      if (ns) AP.newSet = null; else AP.investState = null;
      setCool(ns ? 'newset' : 'invest', 30 * 60);
      logEvent(msg);
      await humanDelay(1);
      return go('warehouse');
    };

    setStatus('🎓 Licencja Transportowa', `Sprawdzam egzamin licencji firmy dla: ${tier ? tier.name : targetTier}...`);
    await humanDelay(0.6);

    const btn = document.getElementById(`upgrade-${targetTier}`);
    const row = btn ? btn.closest('tr') : null;
    const targetRow = row || [...document.querySelectorAll('table tr')].find(r => r.textContent.includes(tier.name));

    if (targetRow && /gotowe|done|completed/i.test(targetRow.textContent)) {
      // Gra po egzaminie sama przeładowuje stronę – wpis do dziennika dopiero tutaj
      if (job.licTries && !job.licLogged) { job.licLogged = true; logEvent(`🎓 Licencja firmy: ${tier.name}`); }
      setStatus('🎓 Licencja Transportowa', `Licencja firmy ${tier.name} zdobyta – dalej ${ns ? 'zakupy do nowego zestawu' : 'prawo jazdy kierowcy'}...`);
      return next();
    }

    if (btn && !btn.disabled && /egzamin|exam/i.test(btn.textContent)) {
      job.licTries = (job.licTries || 0) + 1;
      if (job.licTries > 2 || !canSpend(tier.licCompany, 'invest')) {
        return cancel('🎓 Licencja firmy: za mało pieniędzy ponad zapas albo egzamin nie przechodzi – odkładam');
      }
      await saveAP();   // gra po egzaminie sama przeładowuje stronę – licznik prób musi już być zapisany
      setStatus('🎓 Licencja Transportowa', `Zdaję egzamin licencji firmy ${tier.name} (${fmt(tier.licCompany)})...`);
      await humanDelay(0.6);
      const r = await act(btn);
      if (r.error) return cancel(`🎓 Licencja firmy: ${r.error}`);
      job.licLogged = true;
      logEvent(`🎓 Licencja firmy: ${tier.name}`);
      if (ST.licenses && ST.licenses.list) ST.licenses.list[targetTier] = 'done';
      await humanDelay(1.5);
      return next();
    }

    setStatus('⚠️ Zablokowany poziom', `Licencja ${tier.name} wymaga Poziomu ${tier.level} firmy. Odkładam.`);
    return cancel(`🎓 Licencja ${tier.name}: egzamin niedostępny (wymaga poziomu ${tier.level})`);
  }

  // --- Krok Prawo Jazdy Kierowcy: egzaminy po kolei aż do docelowego typu ---
  // (dla Auto-Inwestycji albo dla nowo zatrudnionego kierowcy, który ma prowadzić zestaw z naczepą wyższego typu)
  async function apHandleDriverUpgrade() {
    if (!checkSafety()) return;
    const inv = AP.investState && AP.investState.step === 'driver_license' ? AP.investState : null;
    const lt = !inv && AP.licenseTask && String(AP.licenseTask.driverId) === String(urlParam('e')) ? AP.licenseTask : null;
    const task = inv || lt;
    if (!task) {
      return go('warehouse');
    }
    const driverId = inv ? inv.driverId : lt.driverId;
    const targetTier = task.targetTier;
    const tier = TIERS[targetTier];
    const finish = async (ok, msg) => {
      if (msg) logEvent(msg);
      if (inv) {
        // Naczepa jest już kupiona – po egzaminie przewóz do ciężarówki; bez egzaminu zostaje wolna w siedzibie
        // (dokupienie do niej ciężarówki ocenia plan zestawów)
        if (ok) inv.step = 'transfer_trailer';
        else AP.investState = null;
      } else {
        AP.licenseTask = null;
        // Egzamin w ramach wymiany naczepy: zdany → dalej sprzedaż starej; niezdany → wymiana przerwana, nic nie sprzedano
        const ns = AP.newSet;
        if (lt && lt.newSet && ns && ns.step === 'driver_exam') {
          if (ok) {
            ns.examDone = true;
            newSetAdvance(ns);
            await saveAP();
            if (await resumeNewSet()) return;
          } else {
            AP.newSet = null;
            setCool('renew', 6 * 3600);
            logEvent('⚠️ Wymiana naczepy przerwana – egzamin kierowcy się nie udał (nic nie sprzedano)');
          }
        }
      }
      await humanDelay(0.8);
      return go(inv && ok ? 'garage' : 'warehouse');
    };

    setStatus('🎓 Prawo jazdy kierowcy', `Sprawdzam szkolenie kierowcy dla: ${tier ? tier.name : targetTier}...`);
    await humanDelay(0.6);

    const rowOf = id => { const b = document.getElementById(`upgrade-${id}`); return (b && b.closest('tr')) || [...document.querySelectorAll('table tr')].find(r => r.textContent.includes(TIERS[id].name)); };
    const targetRow = rowOf(targetTier);
    if (targetRow && /gotowe|done|completed/i.test(targetRow.textContent)) {
      return finish(true, inv ? null : `🎓 Kierowca gotowy: ${tier.name}`);
    }

    // Prawa jazdy zdaje się po kolei – najniższy dostępny egzamin do typu docelowego (z limitem prób: egzaminy są płatne)
    task.exams = (task.exams || 0) + 1;
    if (task.exams > targetTier + 2) {
      return finish(false, '🎓 Egzaminy kierowcy nie kończą się sukcesem – przerywam');
    }
    let next = null;
    for (let i = 1; i <= targetTier; i++) {
      const b = document.getElementById(`upgrade-${i}`);
      if (b && !b.disabled && /egzamin|exam/i.test(b.textContent)) { next = { i, b }; break; }
    }
    if (next && !canSpend(TIERS[next.i].licDriver, inv ? 'invest' : 'ops')) {
      return finish(false, `🎓 Za mało pieniędzy na egzamin (${fmt(TIERS[next.i].licDriver)})`);
    }
    await saveAP();   // gra po egzaminie sama przeładowuje stronę – licznik prób musi już być zapisany
    if (next) {
      setStatus('🎓 Prawo jazdy kierowcy', `Egzamin kierowcy: ${TIERS[next.i].name} (${fmt(TIERS[next.i].licDriver)})...`);
      await humanDelay(0.6);
      const r = await act(next.b);
      if (r.error) {
        return finish(false, `🎓 Prawo jazdy: ${r.error}`);
      }
      logEvent(`🎓 Prawo jazdy: ${TIERS[next.i].name}`);
      await humanDelay(1.2);
      return go('employees_upgrade', { e: driverId });
    }

    // Bez uprawnień kierowcy nowa naczepa stałaby bezużytecznie – przerywam plan zamiast kupować
    return finish(false, '🎓 Kierowca nie może zdać wymaganego egzaminu – przerywam');
  }

  // --- Krok Budynki: ulepszenie garażu (więcej miejsc na pojazdy i kierowców) przed zakupem do nowego zestawu ---
  async function apHandleProperties() {
    if (!checkSafety()) return;
    readProperties(document);
    const s = AP.newSet;
    // Nowy zestaw: najpierw miejsce w garażu (pojazdy, kierowcy) / magazynie (ładunki, pracownicy)
    if (s && (s.step === 'garage_upgrade' || s.step === 'warehouse_upgrade')) {
      const building = s.step === 'garage_upgrade' ? 'garage' : 'warehouse';
      return buildingUpgrade(building, async b => {
        if (building === 'garage') s.garageDone = true; else s.whDone = true;
        s.extras = Math.max(0, (s.extras || 0) - ((building === 'garage' ? s.upCost : s.whCost) || 0));
        logEvent(`🏗 ${building === 'garage' ? 'Garaż' : 'Magazyn'} ulepszony do poziomu ${b.level}` +
          (building === 'garage' ? ` (${b.vehicles ? b.vehicles.cap + ' pojazdów' : 'więcej miejsca'})` : ` (${b.freights ? b.freights.cap + ' ładunków' : 'więcej miejsca'})`));
        newSetAdvance(s);
        if (await resumeNewSet()) return;
        return go('warehouse');
      }, async why => {
        AP.newSet = null;
        setCool('newset', 30 * 60);
        logEvent(`🏗 ${why} – wstrzymuję rozbudowę`);
        await humanDelay(0.8);
        return go('warehouse');
      }, 'invest');
    }
    // Brak miejsca na człowieka przy zestawie (Kadry)
    const up = AP.upgradeTask;
    if (up) {
      return buildingUpgrade(up.building, async b => {
        AP.upgradeTask = null;
        logEvent(`🏢 ${up.building === 'garage' ? 'Garaż' : 'Magazyn'} ulepszony do poziomu ${b.level} – ${up.why}`);
        await humanDelay(0.5);
        return go('warehouse');
      }, async why => {
        AP.upgradeTask = null;
        logEvent(`🏢 ${why}`);
        await humanDelay(0.8);
        return go('warehouse');
      });
    }
    return go('warehouse');
  }

  // --- Krok Salon Ciężarówek: zakup ciągnika do nowego zestawu (Rozbudowa floty) ---
  async function apHandleTruckStore() {
    if (!checkSafety()) return;
    readTruckStore(document);
    const s = AP.newSet;
    if (!s || s.step !== 'buy_truck') {
      // Po zakupie strona przeładowuje się tutaj – od razu sprawdzenie w garażu i kolejny krok zestawu
      if (s && await resumeNewSet()) return;
      return go('warehouse');
    }
    // Naczepa do tego zestawu jeszcze nie kupiona: jej prawdziwa cena z salonu (po licencji salon pokazuje ceny nowych
    // typów, wcześniej był tylko szacunek) – żeby nie kupić samej ciężarówki, gdy potem na naczepę zabraknie
    if (!s.trailerId && !s.replace && s.type && !s.priceChecked) {
      const est = trailerPriceOf(s.type);
      await refreshPage('trailerstore');
      const real = trailerPriceOf(s.type);
      s.priceChecked = true;
      if (real > est) {
        s.extras = (s.extras || 0) + (real - est);
        s.total = (s.total || 0) + (real - est);
        logEvent(`🏗 Naczepa (${TYPES[s.type] || s.type}) kosztuje naprawdę ${fmt(real)} (szacunek ${fmt(est)}) – przeliczam zestaw`);
      }
    }
    let m = ST.models && ST.models.list[s.model];
    let btn = document.querySelector(`button[name="buytruck"][value="${s.model}"]`);
    // Wymiana: stara ciężarówka już sprzedana, a zestaw czeka – gdy wybrany model jest niedostępny, najlepszy inny,
    // na który starczy (nie słabszy niż sprzedany)
    if (s.replace && s.soldOld && (!btn || btn.disabled || !m || !canSpend(m.price + (s.extras || 0), 'ops'))) {
      const c = setRateCtx(), minHp = s.replace.hp || 0;
      const alt = Object.values((ST.models && ST.models.list) || {})
        .filter(x => x.price > 0 && x.hp >= minHp && canSpend(x.price + (s.extras || 0), 'ops'))
        .map(x => ({ x, b: document.querySelector(`button[name="buytruck"][value="${x.id}"]`) }))
        .filter(o => o.b && !o.b.disabled)
        .sort((a, b) => (c ? modelRate(b.x, c) - modelRate(a.x, c) : a.x.price - b.x.price))[0];
      if (alt) { logEvent(`🔄 Model ${s.model} niedostępny – kupuję model ${alt.x.id}`); s.model = alt.x.id; m = alt.x; btn = alt.b; }
    }
    const money = m && canSpend(m.price + (s.extras || 0), s.replace && s.soldOld ? 'ops' : 'invest');
    if (!btn || btn.disabled || !m || !money) {
      if (s.replace && s.soldOld) notify('LogiTycoon: wymiana ciężarówki', `Sprzedano ${s.replace.name}, ale nie da się kupić nowej – zestaw w ${s.city} czeka na ciężarówkę.`);
      AP.newSet = null;
      setCool('newset', 15 * 60);
      // Przycisk zablokowany mimo pieniędzy (np. wymagany poziom) – ten model pomijamy przez kilka godzin
      if (m && money) AP.badModels = { ...(AP.badModels || {}), [s.model]: Date.now() + 6 * 3600000 };
      logEvent(`🏗 Nie mogę kupić ciężarówki model ${s.model} (${!money ? 'za mało pieniędzy ponad zapas' : 'przycisk niedostępny'}) – spróbuję później`);
      return go('warehouse');
    }
    // Zapis przed kliknięciem: formularz przeładowuje stronę, a zakup nie może się powtórzyć
    await refreshGarage();
    s.verify = { before: ((ST.garage && ST.garage.trucks) || []).map(t => String(t.id)), t: Date.now() };
    s.step = 'verify_truck';
    await saveAP();
    setStatus('🏗 Rozbudowa floty', `Kupuję ciężarówkę: model ${s.model} – ${String(m.kmPerL).replace('.', ',')} km/L, ${m.speed} km/h, ${m.hp} KM (${fmt(m.price)})...`);
    await humanDelay(0.6);
    logEvent(`🏗 Kupuję ciężarówkę: model ${s.model} (${fmt(m.price)})`);
    await submitAndWait(btn);
    if (await resumeNewSet()) return;
    return go('warehouse');
  }

  // --- Krok Zatrudnianie (kierowca / pracownik magazynu / menedżer) ---
  // Najtańsza oferta w horyzoncie tygodnia: cena + płaca × przewidywana praca (km / akcje / ładunki). Niska płaca
  // szybko odrabia wyższą cenę (np. €3.890 z płacą €50 vs €1.170 z €150 za 1000 km przy kilku tysiącach km na dobę).
  // Gdy na najlepszą nie starcza pieniędzy (budget) – najlepsza z tych, na które firmę stać.
  function bestOffer(role, budget = Infinity) {
    const h = ST.hire && ST.hire[role];
    if (!h) return null;
    const lvl = ST.company && ST.company.level;
    const ok = h.offers.filter(o => !o.disabled && o.price > 0 && !(o.limit != null && o.used >= o.limit)
      && (!Number.isFinite(o.level) || lvl == null || o.level <= lvl));
    if (!ok.length) return null;
    const er = earnings(6), sets = Math.max(1, (ST.garage && ST.garage.trucks.length) || 1);
    const kmh = er && er.kmPerH > 0 ? er.kmPerH / sets : 600;
    const fph = er ? er.fph / sets : 6;
    const H = 168;
    const units = role === 'driver' ? kmh * H / 1000 : role === 'worker' ? fph * H * 2 : fph * H;
    return ok.map(o => ({ ...o, costWeek: o.price + (o.wage || 0) * units })).sort((a, b) => a.costWeek - b.costWeek)
      .find(o => o.price <= budget) || null;
  }

  async function apHandleHire() {
    readHire(document);
    const task = AP.hireTask;
    if (!task) return go('warehouse');
    AP.hireTask = null;
    const cfg = HIRE_FORMS[task.role];
    const form = cfg && document.querySelector(cfg.form);
    // Ludzie przy zestawach to koszt operacyjny jak paliwo: zestaw bez kierowcy nic nie zarabia, a płaci ubezpieczenie –
    // dlatego bez progu rezerwy (pieniądze na ludzi nowego zestawu i tak policzono w jego planie)
    const offer = bestOffer(task.role, ST.balance != null ? ST.balance : Infinity);
    const fail = async why => {
      logEvent(`🧑‍💼 ${ROLE_PL[task.role] || task.role}: ${why}`);
      if (task.newSet) AP.newSet = null;
      setCool('hire:' + task.role, (task.newSet || task.gapKey ? 10 : 30) * 60);
      await humanDelay(0.8);
      return go('warehouse');
    };
    if (!form || !bestOffer(task.role)) return fail('brak dostępnej oferty');
    if (!offer || !canSpend(offer.price, 'ops')) return fail(`za mało pieniędzy (${fmt((bestOffer(task.role) || {}).price)})`);
    const radio = form.querySelector(`input[type="radio"][name="${cfg.radio}"][value="${offer.value}"]`);
    if (!radio || radio.disabled) return fail('oferta niedostępna');
    if (cfg.city) {
      const sel = form.querySelector(`select[name="${cfg.city}"]`);
      const opt = sel && [...sel.options].find(o => task.city ? sameCity(o.text.replace(/\(.*?\)/, ''), task.city) : /\(HQ\)/i.test(o.text));
      if (!opt) return fail(`nie ma miasta ${task.city || 'siedziby'} na liście`);
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const submit = form.querySelector('button[type="submit"]');
    if (!submit) return fail('brak przycisku Zatrudnij');

    // Zapis przed kliknięciem: gdyby gra przeładowała stronę, zatrudnienie nie może się powtórzyć
    const known = ((ST.employees && ST.employees.list) || []).map(e => e.id);
    const prevStep = AP.newSet && AP.newSet.step;
    setCool('hire:' + task.role, 10 * 60);
    if (task.replaces) AP.replaced = { ...(AP.replaced || {}), [task.replaces]: Date.now() };
    if (task.gapKey && AP.gap) delete AP.gap[task.gapKey];
    if (task.role === 'manager') AP.mgrShort = null;
    if (task.newSet && AP.newSet) newSetAdvance(AP.newSet);
    if (task.role === 'driver' && task.lic > 1) AP.pendingLicense = { known, lic: task.lic, city: task.city, t: Date.now() };
    await saveAP();

    setStatus('🧑‍💼 Kadry', `Zatrudniam: ${ROLE_PL[task.role]} (${fmt(offer.price)}, płaca ${fmt(offer.wage)}) w ${task.city || 'siedzibie'} – ${task.why}...`);
    await humanClick(radio.closest('tr') || radio);
    if (!radio.checked) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await humanDelay(0.4);
    const r = await act(submit);
    if (r.error) {
      if (task.newSet && AP.newSet) AP.newSet.step = prevStep;
      AP.pendingLicense = null;
      return fail(r.error);
    }
    AP.stats.hires = (AP.stats.hires || 0) + 1;
    logEvent(`🧑‍💼 Zatrudniono: ${ROLE_PL[task.role]} w ${task.city || 'siedzibie'} (${fmt(offer.price)}) – ${task.why}`);
    await refreshEmployees();
    if (task.newSet && AP.newSet && AP.newSet.step === 'done') newSetDone();
    // Nowy zestaw: od razu kolejna osoba (bez przystanku w Magazynie)
    if (task.newSet && AP.newSet && await resumeNewSet()) return;
    return go('warehouse');
  }

  // --- Krok Salon Naczep (Auto-Inwestycje albo nowy zestaw) ---
  async function apHandleTrailerStore() {
    if (!checkSafety()) return;
    readTrailerStore(document);
    if (AP.newSet && AP.newSet.step === 'buy_trailer') {
      const s = AP.newSet;
      const priceOf = t => (ST.trailerShop && ST.trailerShop.list[t] && ST.trailerShop.list[t].price) || TIERS[t].trailerPrice;
      let btn = document.querySelector(`button[name="buytrailer"][value="${s.type}"]`);
      let price = priceOf(s.type);
      // Wymiana naczepy: stara już sprzedana, a nowego typu nie da się kupić – ten sam typ co sprzedana,
      // żeby zestaw nie został bez naczepy
      const afterSale = !!(s.replaceTr && s.soldOld);
      if (afterSale && (!btn || btn.disabled || !canSpend(price, 'ops')) && s.replaceTr.type !== s.type) {
        const b0 = document.querySelector(`button[name="buytrailer"][value="${s.replaceTr.type}"]`);
        if (b0 && !b0.disabled && canSpend(priceOf(s.replaceTr.type), 'ops')) {
          logEvent(`🔄 ${TYPES[s.type] || s.type} niedostępna – kupuję taką jak sprzedana (${(TYPES[s.replaceTr.type] || '').toLowerCase()})`);
          s.type = s.replaceTr.type;
          btn = b0;
          price = priceOf(s.type);
        }
      }
      // Po zakupie ciężarówki (albo sprzedaży starej naczepy) pieniądze na naczepę są już policzone – bez progu inwestycyjnego
      if (!btn || btn.disabled || !canSpend(price, s.model || afterSale ? 'ops' : 'invest')) {
        if (afterSale) notify('LogiTycoon: wymiana naczepy', `Sprzedano ${s.replaceTr.name}, ale nie da się teraz kupić nowej naczepy – zestaw w ${s.city} czeka; bot dokupi ją, gdy będzie można.`);
        AP.newSet = null;
        setCool('newset', 15 * 60);
        logEvent(`🏗 Nie mogę teraz kupić naczepy (${TYPES[s.type] || s.type}) – ${btn && !btn.disabled ? 'za mało pieniędzy' : 'przycisk niedostępny'}; spróbuję później`);
        return go('warehouse');
      }
      await refreshGarage();
      s.verify = { before: ((ST.garage && ST.garage.trailers) || []).map(t => String(t.id)), t: Date.now() };
      s.step = 'verify_trailer';
      await saveAP();
      setStatus('🏗 Rozbudowa floty', `Kupuję naczepę: ${TYPES[s.type]} (${fmt(price)})...`);
      await humanDelay(0.6);
      logEvent(`🏗 Kupuję naczepę: ${TYPES[s.type]} (${fmt(price)})`);
      await submitAndWait(btn);
      if (await resumeNewSet()) return;
      return go('warehouse');
    }
    if (AP.newSet && AP.newSet.step === 'verify_trailer') {
      if (await resumeNewSet()) return;
      return go('warehouse');
    }
    const inv = AP.investState;
    if (inv && inv.step === 'verify_trailer') return investVerifyTrailer(inv);
    if (!inv || inv.step !== 'buy_trailer') {
      return go('warehouse');
    }
    const targetTier = inv.targetTier;
    const tier = TIERS[targetTier];

    setStatus('🛒 Salon naczep', `Szukam nowej naczepy: ${tier ? tier.trailerName : targetTier}...`);
    await humanDelay(0.6);

    const buyBtn = document.querySelector(`button[name="buytrailer"][value="${targetTier}"]`);
    const price = (ST.trailerShop && ST.trailerShop.list[targetTier] && ST.trailerShop.list[targetTier].price) || tier.trailerPrice;
    if (buyBtn && !buyBtn.disabled && canSpend(price, 'invest')) {
      // Zapis przed kliknięciem: formularz przeładowuje stronę; zakup sprawdzimy w garażu (nowe id), a egzamin
      // kierowcy dopiero, gdy naczepa naprawdę jest
      await refreshGarage();
      inv.verify = { before: ((ST.garage && ST.garage.trailers) || []).map(t => String(t.id)), t: Date.now() };
      inv.step = 'verify_trailer';
      inv.boughtAt = Date.now();
      await saveAP();
      setStatus('🛒 Salon naczep', `Kupuję naczepę ${tier.trailerName} (${fmt(price)})...`);
      await humanDelay(0.6);
      logEvent(`🛒 Kupuję naczepę: ${tier.trailerName} (${fmt(price)})`);
      await submitAndWait(buyBtn);
      return investVerifyTrailer(inv);
    }

    AP.investState = null;
    setStatus('⚠️ Brak możliwości zakupu', 'Przycisk zakupu niedostępny albo za mało pieniędzy ponad rezerwę. Anuluję plan inwestycji...');
    await humanDelay(1.5);
    return go('warehouse');
  }

  // Auto-rozwój: czy kupiona naczepa jest w garażu – dopiero wtedy egzamin kierowcy (jeśli potrzebny) i przewóz
  async function investVerifyTrailer(inv) {
    const T = inv.targetTier, v = inv.verify || { before: [], t: Date.now() };
    await refreshGarage();
    const fresh = ((ST.garage && ST.garage.trailers) || []).find(x => !v.before.includes(String(x.id)) && (x.type || 1) === T);
    if (fresh) {
      delete inv.verify;
      const drv = ((ST.employees && ST.employees.list) || []).find(e => String(e.id) === String(inv.driverId));
      inv.step = drv && licOf(drv) >= T ? 'transfer_trailer' : 'driver_license';
      logEvent(`🛒 Kupiono: ${fresh.name}${fresh.loc ? ' (' + fresh.loc + ')' : ''}`);
      await saveAP();
      await humanDelay(0.6);
      return inv.step === 'driver_license' ? go('employees_upgrade', { e: inv.driverId }) : go('garage');
    }
    v.tries = (v.tries || 0) + 1;
    inv.verify = v;
    if (v.tries < 3 && Date.now() - v.t < 3 * 60000) { await saveAP(); return go('warehouse'); }
    AP.investState = null;
    setCool('invest', 30 * 60);
    logEvent(`⚠️ Zakup naczepy (${TYPES[T] || T}) nie pojawił się w garażu – przerywam plan bez szkolenia kierowcy`);
    await saveAP();
    return go('warehouse');
  }

  // --- Krok Panel Naczepy (Przejście do Transferio) – Auto-rozwój albo nowy zestaw ---
  async function apHandleGarageTrailer() {
    if (!checkSafety()) return;
    const st = AP.sellTask;
    if (st && st.kind === 'trailer' && String(st.id) === String(urlParam('t'))) return sellUnit(st);
    const job = transferJob();
    if (!job || (job.trailerId && String(urlParam('t')) !== String(job.trailerId))) {
      return go('warehouse');
    }
    setStatus('🚚 Panel naczepy', `Otwieram Transferio – przewóz naczepy do ${job.city}...`);
    await humanDelay(0.6);
    const transferBtn = document.querySelector('#page-content [onclick*="trailer_transfer"], #page-content a[href*="trailer_transfer"]')
      || [...document.querySelectorAll('#page-content a, #page-content button')].find(el => /przenie[śs]|transfer/i.test(el.textContent));
    if (transferBtn) {
      await saveAP();
      await humanClick(transferBtn);
      await sleep(6000);   // przycisk przechodzi do formularza; gdyby nie zadziałał – adres formularza wprost
      return go('trailer_transfer', { t: urlParam('t') });
    }
    transferCancel(job, 'nie znaleziono przycisku Przenieś');
    setStatus('⚠️ Transfer', 'Nie znaleziono przycisku Przenieś. Powrót do Magazynu...');
    await humanDelay(1);
    return go('warehouse');
  }

  // --- Krok Formularz Transferio ---
  async function apHandleTrailerTransfer() {
    if (!checkSafety()) return;
    const citySelect = document.querySelector('select[name="city"]');
    const job = transferJob();
    // Tylko w ramach własnego planu: formularz po wysłaniu wraca na tę samą stronę
    // i bez tej blokady bot wysyłał przeniesienie ponownie (za każdym razem €600)
    if (!citySelect || !job) {
      if (AP.newSet && await resumeNewSet()) return;   // nowy zestaw: od razu kolejny krok (zatrudnienie)
      return go('warehouse');
    }
    const targetCity = job.city;
    setStatus('🚚 Relokacja Transferio', `Wybieram miasto docelowe zestawu: ${targetCity}...`);
    await humanDelay(0.6);

    const opt = targetCity && [...citySelect.options].find(o => o.value && (sameCity(o.text.replace(/\(.*\)/, ''), targetCity) || norm(o.text).includes(norm(targetCity))));
    const submitBtn = document.querySelector('button[name="transfer"]');
    if (opt && submitBtn && canSpend(600, 'ops')) {
      citySelect.value = opt.value;
      citySelect.dispatchEvent(new Event('change', { bubbles: true }));
      await humanDelay(0.5);
      const city = opt.text.replace(/\(.*\)/, '').trim();
      // Czas przewozu z listy miast, np. "Dresden (00:02:34)"
      const dur = hms((opt.text.match(/\d{1,2}:\d{2}:\d{2}/) || [])[0]);
      const tr = unitById('trailer', job.trailerId || urlParam('t'));
      if (tr) addMove('trailer', tr, city, job.kind === 'move' && AP.moveTask ? AP.moveTask.why : job.kind === 'invest' ? 'Auto-rozwój' : AP.newSet && AP.newSet.replaceTr ? `zamiast ${AP.newSet.replaceTr.name}` : 'nowy zestaw', Number.isFinite(dur) ? dur : null);
      if (job.kind === 'invest') {
        AP.stats.investments = (AP.stats.investments || 0) + 1;
        // Ciężarówka czeka na miejscu, aż naczepa dojedzie
        if (AP.investState.truckId) AP.holdTruck = { id: AP.investState.truckId, until: Date.now() + ((Number.isFinite(dur) ? dur : 300) + 90) * 1000 };
        AP.investState = null;
      } else if (job.kind === 'move') {
        logEvent(`🚚 Porządek floty: ${AP.moveTask.name} jedzie do ${city} (Transferio €600) – ${AP.moveTask.why}`);
        AP.moveTask = null;
      } else if (AP.newSet) newSetAdvance(AP.newSet);
      logEvent(`🚚 Transferio: naczepa jedzie do ${city} (€600)`);
      await saveAP();
      setStatus('🚚 Relokacja Transferio', `Zatwierdzam przewóz naczepy do ${city}...`);
      await submitAndWait(submitBtn);
      if (AP.newSet && await resumeNewSet()) return;
      return go('warehouse');
    }
    transferCancel(job, !opt ? `nie ma miasta ${targetCity || '?'} na liście` : !submitBtn ? 'brak przycisku formularza' : 'za mało pieniędzy na przewóz (€600)');
    setStatus('⚠️ Transfer', `Przewóz naczepy do ${targetCity || '?'} niemożliwy. Powrót do Magazynu...`);
    await humanDelay(1.2);
    return go('warehouse');
  }

  // --- Auto-rozwój: kolejny typ dla istniejącego zestawu (licencja firmy + egzamin kierowcy + naczepa + przewóz) ---
  // Zysk = wyższe stawki tego typu (z listy tras albo ostrożny szacunek). Dotychczasowa naczepa zostaje wolna,
  // więc przy wolnym miejscu w magazynie bot dokupi do niej ciężarówkę (osobna decyzja w planie zestawów).
  function tierPlan() {
    const g = ST.garage;
    // Oceniamy dopiero z kompletem danych (moc z salonu, licencje, poziom) – inaczej fałszywe "nie da się"
    if (!g || !g.trailers || !g.trailers.length || ST.balance == null || !ST.models || !ST.licenses || !ST.company) return null;
    const owned = new Set(g.trailers.map(t => t.type || 1));
    let T = AP.targetTier || Math.min(9, Math.max(...owned) + 1);
    if (!AP.targetTier) while (owned.has(T) && T < 9) T++;
    const tier = TIERS[T];
    if (!tier || owned.has(T)) return null;
    const lic = ST.licenses.list && ST.licenses.list[T], level = ST.company.level;
    if (lic === 'locked' || (level != null && level < tier.level)) return { T, tier, why: `licencja ${tier.name} wymaga poziomu ${tier.level}` };
    // Ciężarówka, która uciągnie nową naczepę (moc z salonu) i stoi w mieście razem z kierowcą. Uprawnienia dostaje
    // kierowca z tego samego miasta – inaczej nowa naczepa stanęłaby przy ciężarówce bez uprawnionego kierowcy,
    // a przeszkolony byłby ktoś, kto jeździ gdzie indziej. Najmniej egzaminów: ktoś, kto już ma uprawnienia.
    const drivers = ((ST.employees && ST.employees.list) || []).filter(e => e.role === 'driver' && e.id && !onRoute(e.loc));
    const cands = g.trucks.filter(t => (truckSpec(t).hp || 0) >= tier.hp && !onRoute(t.loc)).map(t => {
      const d = drivers.filter(e => sameCity(e.loc, t.loc)).sort((a, b) => licOf(b) - licOf(a))[0] || null;
      return { t, d, ex: d ? examCost(licOf(d), T) : Infinity };
    }).sort((a, b) => a.ex - b.ex || isIdleStatus(b.t.status) - isIdleStatus(a.t.status));
    if (!cands.length) return { T, tier, why: `żadna stojąca ciężarówka nie ma ${tier.hp} KM` };
    const truck = cands[0].t, drv = cands[0].d;
    if (!drv) return { T, tier, truck, why: 'przy stojącej ciężarówce nie ma kierowcy do przeszkolenia' };
    const exams = examCost(licOf(drv), T);
    const total = (lic === 'done' ? 0 : tier.licCompany) + exams + trailerPriceOf(T) + 600;
    const c = setRateCtx(), w = ST.warehouse;
    // Magazyn pełny – zwolniona naczepa nie dostanie ciągnika i tylko płaci ubezpieczenie
    const full = !!w && Math.min(g.trucks.length, g.trailers.length) >= w.cap;
    const gainH = c ? typeGainH(T, c) - typeGainH(truck.type || 1, c) - (full ? 400 / 24 : 0) : null;
    return { T, tier, truck, drv, lic, exams, total, gainH, payH: gainH > 0 ? total / gainH : Infinity, src: c ? (typeRevKm(T, c.avgKm || 450) || {}).src : null };
  }

  // Licencja jako rozpoznanie: przy dużej nadwyżce sama licencja firmy (tania w porównaniu z naczepą) –
  // odsłania prawdziwe stawki i ceny nowego typu, a dopiero na ich podstawie mózg zdecyduje o naczepie/zestawie
  function licenseScoutPlan() {
    if (!AP.autoExpandFleet || !ST.licenses || !ST.company) return null;
    const T = nextLicense();
    if (!T) return null;
    const tier = TIERS[T];
    const money = (ST.balance ?? 0) - investFloor();
    const xp = AP.autoNewSets ? expansionPlan() : {};
    // pieniądze na opłacalny zestaw mają pierwszeństwo – licencja tylko z tego, co zostanie ponad niego
    const reserved = xp.total > 0 && xp.payH <= maxPayH() ? xp.total : 0;
    const need = Math.max(25000, reserved) + tier.licCompany;
    return { T, tier, cost: tier.licCompany, money, need, ok: money >= need, reserved };
  }

  async function checkAndTriggerAutoInvest() {
    if (!AP.autoExpandFleet || isCool('invest') || AP.newSet || AP.investState) return false;
    // Decyzja dopiero z kompletem danych (licencje, poziom, garaż, salon) – inaczej fałszywe "nie" na 5 minut
    if (!ST.licenses || !ST.company || !ST.garage || !ST.models || ST.balance == null) return false;
    setCool('invest', 5 * 60);
    const xp = AP.autoNewSets ? expansionPlan() : {};
    const pendingSet = xp.total > 0 && xp.payH <= maxPayH() ? xp.total : 0;
    // 1. Kolejny typ dla stojącego zestawu – tylko gdy stawki pokazują zwrot w limicie (ciężarówka czeka na naczepę)
    const p = loneTrailers().length ? null : tierPlan();
    if (p && p.truck && p.drv && p.total > 0 && p.payH <= maxPayH() && canSpend(p.total + pendingSet, 'invest')) {
      const { T, tier, truck, drv, total } = p;
      AP.investState = {
        targetTier: T, targetTierName: tier.name, step: 'company_license', driverId: drv.id,
        truckId: truck.id, truckCity: truck.loc, totalCost: total, startedAt: Date.now()
      };
      logEvent(`🚀 Rozwój: ${tier.name} (${fmt(total)}) dla ${truck.name} w ${truck.loc}, zwrot ~${fmtDur(p.payH * 3600)}`);
      setStatus('🚀 Auto-rozwój', `Odblokowuję ${tier.name}: licencja firmy, prawo jazdy (${drv.name}), naczepa, przewóz do ${truck.loc}...`);
      await humanDelay(0.8);
      await go('transportlicense');
      return true;
    }
    // 2. Sama licencja jako rozpoznanie (przy dużej nadwyżce)
    const ls = licenseScoutPlan();
    if (ls && ls.ok && canSpend(ls.cost, 'invest')) {
      AP.investState = { targetTier: ls.T, targetTierName: ls.tier.name, step: 'company_license', licenseOnly: true, totalCost: ls.cost, startedAt: Date.now() };
      logEvent(`🎓 Rozpoznanie: licencja ${ls.tier.name} (${fmt(ls.cost)}) – poznam prawdziwe stawki i ceny tego typu, zanim kupię naczepę`);
      setStatus('🎓 Auto-rozwój', `Licencja firmy: ${ls.tier.name} (${fmt(ls.cost)}) – nadwyżka pieniędzy, rozpoznanie nowego typu ładunków...`);
      await humanDelay(0.8);
      await go('transportlicense');
      return true;
    }
    return false;
  }

  // Niedokończony plan inwestycji: wcześniej Magazyn kończył wtedy pracę bez żadnej nawigacji i bot zamierał
  async function resumeInvest() {
    const s = AP.investState;
    if (!s) return false;
    if (s.lastStep !== s.step) { s.lastStep = s.step; s.visits = 0; }
    s.visits = (s.visits || 0) + 1;
    s.startedAt = s.startedAt || Date.now();
    const target = {
      company_license: ['transportlicense'], buy_trailer: ['trailerstore'], verify_trailer: ['trailerstore'],
      driver_license: ['employees_upgrade', { e: s.driverId }], transfer_trailer: ['garage']
    }[s.step];
    if (!target || s.visits > 6 || Date.now() - s.startedAt > 45 * 60000) {
      AP.investState = null;
      logEvent('⚠️ Plan inwestycji utknął – anulowany');
      setStatus('⚠️ Auto-inwestycja', 'Plan inwestycji utknął – anuluję go i wracam do pracy floty.');
      await saveAP();
      return false;
    }
    setStatus('🚀 Auto-inwestycja', `Kontynuuję krok: ${s.step}...`);
    await humanDelay(0.6);
    await go(...target);
    return true;
  }

  // Znak życia dla service workera: gdy strona padnie (błąd sieci, zamrożona karta), rozszerzenie samo ją przeładuje
  function sendAlive() {
    if (Date.now() - lastAlive < 15000) return;
    lastAlive = Date.now();
    try { chrome.runtime.sendMessage({ ltd: 'alive', enabled: !!AP.enabled }, () => void chrome.runtime.lastError); } catch (e) {}
  }

  // Heartbeat: odliczanie przerwy/patrolu + watchdog, który wznawia bota, gdy coś utknie
  function heartbeat() {
    sendAlive();
    if (!AP.enabled) return;
    if (!extAlive()) {
      AP.enabled = false;
      AP.statusDetail = 'Rozszerzenie zostało przeładowane – odśwież stronę gry (F5).';
      renderStatus();
      return;
    }
    const now = Date.now();
    if (AP.breakUntil && now < AP.breakUntil) {
      AP.statusDetail = `Przerwa AFK. Wznowienie za ${Math.ceil((AP.breakUntil - now) / 1000)}s...`;
      lastProgress = now;
      renderStatus();
      return;
    }
    if (AP.nextPatrolTime && now < AP.nextPatrolTime) {
      AP.statusDetail = `${AP.patrolInfo || 'Flota pracuje.'} Kolejna kontrola za ${Math.ceil((AP.nextPatrolTime - now) / 1000)}s...`;
      lastProgress = now;
      renderStatus();
      return;
    }
    if (AP.nextPatrolTime) {
      AP.nextPatrolTime = 0;
      lastProgress = now;
      workFrom = now;
      if (pageName() === 'warehouse') autopilotLoop();
      else go('warehouse');
      return;
    }
    const idleFor = now - lastProgress;
    if (idleFor > 45000 && (!apRunning || idleFor > 120000)) {
      apRunning = false;
      lastProgress = now;
      setStatus('⏱ Watchdog', 'Bot stał bez zmian – wznawiam od Magazynu...');
      logEvent('⏱ Watchdog wznowił bota');
      if (pageName() === 'warehouse') autopilotLoop();
      else go('warehouse');
    }
  }

  // Awaryjne zatrzymanie klawiszem ESC
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && AP.enabled) {
      stopAutopilot('Awaryjne zatrzymanie klawiszem ESC');
    }
  });

  // =========================================================================
  // ---------- PANEL INTERFEJSU UŻYTKOWNIKA ----------
  // =========================================================================
  const FIELDS = [
    ['target', 'Cel salda €'], ['reserve', 'Rezerwa gotówki € (opony jej nie ruszą)'], ['expandReserve', 'Inwestycje tylko ponad € na koncie (0 = auto)'],
    ['maxPaybackH', 'Inwestuj, gdy zwrot do (h)'],
    ['repairAt', 'Naprawa poniżej % stanu'], ['condReserve', 'Kondycja po kursie co najmniej % (dłuższa trasa = najpierw naprawa)'], ['sleepAt', 'Sen poniżej % energii'], ['tireMinCond', 'Komplet opon w magazynie zużyty poniżej %'],
    ['tireWornAt', 'Wymiana opon na ciężarówce poniżej %'],
    ['utilHoursAhead', 'Nowa umowa (media, mechanicy), gdy zostało h'], ['mechanics', 'Mechanicy – ilu utrzymywać (0 = auto)'],
    ['fuelManual', 'Paliwo €/L na sztywno (0 = z gry)'],
    ['syncMin', 'Pełne odświeżenie danych co min'], ['earnWinMin', 'Zarobek/h w panelu – z ostatnich minut'],
    ['minDelay', 'Min. opóźnienie bota (ms)'], ['maxDelay', 'Maks. opóźnienie bota (ms)'],
    ['breakMinInterval', 'Przerwa AFK co (minuty)'], ['breakDuration', 'Długość przerwy AFK (sekundy)']
  ];

  const AP_CHECKBOXES = [
    ['autoTrips', 'Auto-trasy: każdy wolny zestaw dostaje najlepsze zlecenie (prawdziwy €/h)'],
    ['autoFuel', 'Auto-tankowanie: zbiornik firmy → korporacja → publiczne'],
    ['autoSleep', 'Auto-sen kierowców, pracowników i menedżerów'],
    ['autoRepair', 'Auto-naprawa stojących pojazdów'],
    ['autoTires', 'Auto-opony: zmiana na sezon + zakup brakujących kompletów'],
    ['autoUtilities', 'Auto-media: nowa umowa na prąd/wodę przed wygaśnięciem i przy niedoborze (np. po ulepszeniu budynku)'],
    ['autoMechanics', 'Auto-mechanicy: najtańszy kontrakt z wystarczającą liczbą mechaników, odnawiany przed końcem'],
    ['sendWorker', 'Pracownik magazynu jedzie z ładunkiem (rozładuje go na miejscu)'],
    ['avoidRouteRefuel', 'Trasy tylko na jednym baku (bez tankowania w trasie po ~€2/L)'],
    ['fastNav', 'Szybkie przejścia: kolejna decyzja bez wchodzenia na stronę Magazynu (Magazyn pobierany w tle)'],
    ['stealthMode', 'Tryb Stealth (ludzkie opóźnienia + przerwy AFK)'],
    ['autoHire', 'Auto-kadry: braki ludzi i uprawnień w zestawach (zatrudnienie, szkolenie), następcy przed emeryturą, menedżerowie'],
    ['autoReorg', 'Porządek floty: łączenie ciężarówek i naczep z różnych miast (Transferio), przewóz wolnych ludzi, gdy brak miejsca na nowych'],
    ['autoExpandFleet', 'Auto-rozwój: licencje kolejnych typów (gdy się zwracają albo przy dużej nadwyżce – rozpoznanie stawek)'],
    ['autoNewSets', 'Auto-rozbudowa: ciężarówka do nieużywanej naczepy albo nowy zestaw, gdy zwrot w limicie z parametrów (duże wydatki!)'],
    ['autoRenew', 'Wymiana floty: sprzedaż starej ciężarówki/naczepy i zakup nowej (z licencją i egzaminem kierowcy, gdy trzeba), gdy szybko się zwraca']
  ];

  function buildPanel(pos) {
    panel = document.createElement('div');
    panel.id = 'ltd-panel';
    panel.innerHTML = `
      <div class="ltd-head"><b>🚚 Doradca & Autopilot ${VERSION}</b><span>
        <button data-a="sync" title="Pobierz świeże dane ze wszystkich stron">⟳ Dane</button>
        <button data-a="settings" title="Ustawienia i konfiguracja bota">⚙</button><button data-a="min" title="Zwiń">–</button></span></div>
      <div class="ltd-body"></div>
      <div class="ltd-settings" hidden>
        <b style="color:#38bdf8;margin-bottom:4px;display:block;">Opcje Autopilota:</b>
        ${AP_CHECKBOXES.map(([k, l]) => `<label class="ltd-cb"><input type="checkbox" data-ap-cb="${k}" ${AP[k] ? 'checked' : ''}>${l}</label>`).join('')}
        <b style="color:#38bdf8;margin:8px 0 4px;display:block;">Parametry:</b>
        ${FIELDS.map(([k, l]) => `<label>${l}<input type="number" step="any" data-k="${k}" value="${k in AP ? AP[k] : S[k]}"></label>`).join('')}
        <button data-a="clear">Wyczyść zapamiętane dane (nauka też)</button>
      </div>`;
    document.body.appendChild(panel);
    body = panel.querySelector('.ltd-body');
    setEl = panel.querySelector('.ltd-settings');
    panelPos = pos || null;
    placePanel();
    window.addEventListener('resize', placePanel);
    // Stan z poprzedniej strony tej karty: zwinięcie, otwarte ustawienia, przewinięcie (treść panelu pojawi się
    // przy pierwszym render() – wtedy wracamy do zapamiętanej pozycji)
    if (UI.min) panel.classList.add('ltd-min');
    if (UI.setOpen) { setEl.hidden = false; if (UI.setTop) setEl.scrollTop = UI.setTop; }
    restoreTop = UI.bodyTop > 0 ? UI.bodyTop : null;
    restoreUntil = Date.now() + 4000;
    body.addEventListener('scroll', () => { if (restoreTop == null) { UI.bodyTop = body.scrollTop; saveUI(); } }, { passive: true });
    setEl.addEventListener('scroll', () => { UI.setTop = setEl.scrollTop; saveUI(); }, { passive: true });
    // Ręczne przewijanie w trakcie przywracania wygrywa z zapamiętaną pozycją
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) body.addEventListener(ev, () => { restoreTop = null; }, { passive: true });

    panel.addEventListener('click', e => {
      const a = e.target.dataset.a;
      if (a === 'min') {
        UI.min = panel.classList.toggle('ltd-min');
        saveUI();
        if (!UI.min) body.scrollTop = UI.bodyTop || 0;
      }
      if (a === 'settings') {
        setEl.hidden = !setEl.hidden;
        UI.setOpen = !setEl.hidden;
        saveUI();
        if (UI.setOpen) setEl.scrollTop = UI.setTop || 0;
      }
      if (a === 'log-all') { UI.logAll = !UI.logAll; saveUI(); render(); }
      if (a === 'sync') syncAll();
      if (a === 'clear') { ST = {}; saveStateNow(); syncAll(); }
      if (a === 'skip-break') {
        AP.breakUntil = 0;
        AP.lastBreakTime = Date.now();
        AP.statusDetail = 'Pominięto przerwę AFK. Wracam do zadań...';
        saveAP();
        render();
        later(400);
      }
      if (a === 'toggle-ap') {
        if (AP.enabled) stopAutopilot('Zatrzymany przez użytkownika');
        else startAutopilot();
      }
    });

    panel.addEventListener('change', e => {
      const apCb = e.target.dataset.apCb;
      if (apCb) {
        AP[apCb] = e.target.checked;
        saveAP();
        render();
        return;
      }
      const k = e.target.dataset.k;
      if (!k) return;
      const v = parseFloat(e.target.value);
      if (Number.isFinite(v)) {
        if (k in AP) { AP[k] = v; saveAP(); }
        else { S[k] = v; saveSettings(); }
        schedule();
      }
    });

    const head = panel.querySelector('.ltd-head');
    head.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => { panelPos = { x: ev.clientX - dx, y: ev.clientY - dy }; placePanel(); };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const r2 = panel.getBoundingClientRect();
        panelPos = { x: r2.left, y: r2.top };
        store({ ltd3_pos: panelPos });
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  // Przeciągnięty panel zawsze w oknie, a jego wysokość tak dobrana, żeby dół nie uciekał pod krawędź ekranu
  // (panel przesunięty w dół miał dolne sekcje poza ekranem i nie dało się ich doczytać)
  function placePanel() {
    if (!panel || !panelPos) return;
    const x = Math.round(Math.min(Math.max(panelPos.x, 120 - panel.offsetWidth), innerWidth - 120));
    const y = Math.round(Math.min(Math.max(panelPos.y, 0), innerHeight - 60));
    Object.assign(panel.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto', maxHeight: `min(82vh, calc(100vh - ${y + 12}px))` });
  }

  const item = x => x.href
    ? `<a class="ltd-item lvl${x.lvl || 0}" href="${x.href}">${x.t}</a>`
    : `<div class="ltd-item lvl${x.lvl || 0}">${x.t}</div>`;

  function statusBoxHtml() {
    const now = Date.now();
    const fleet = fleetLine();
    const blocked = Object.entries(AP.blocked || {}).filter(([, b]) => b && now - b.t < 15 * 60000)
      .map(([n, b]) => `⏸ ${esc(b.label || '#' + n.slice(-3))}: ${esc(b.why)}`);
    const gameMsg = AP.lastGameMsg && now - AP.lastGameMsg.t < 10 * 60000 ? AP.lastGameMsg : null;
    const er = shownEarnings();
    return `
        <div class="ltd-ap-status-box">
          <div class="ltd-ap-status-title">
            <span>${AP.enabled ? '🟢 AUTOPILOT AKTYWNY' : '⚪ AUTOPILOT WYŁĄCZONY'}</span>
            <small style="color:#94a3b8;font-weight:400;">${AP.stealthMode ? '🛡 Stealth ON' : '⚡ Tryb Szybki'}</small>
          </div>
          <div class="ltd-ap-status-msg">
            ${syncMsg ? `<span class="ltd-sync-inline">${esc(syncMsg)}</span><br>` : ''}${esc(AP.statusDetail || AP.status)}
            ${AP.breakUntil && now < AP.breakUntil ? '<button data-a="skip-break" class="ltd-skip">⏩ Pomiń przerwę AFK</button>' : ''}
          </div>
          ${fleet ? `<div class="ltd-ap-fleet">${fleet}</div>` : ''}
          ${staffLine() ? `<div class="ltd-ap-fleet ltd-staff">${staffLine()}</div>` : ''}
          ${blocked.length ? `<div class="ltd-ap-blocked">${blocked.join('<br>')}</div>` : ''}
          ${gameMsg ? `<div class="ltd-ap-gamemsg ${gameMsg.type === 'success' ? 'ok' : ''}">Gra: ${esc(gameMsg.msg)}</div>` : ''}
          <div class="ltd-ap-stats-row">
            <span>Trasy: <b>${AP.stats.trips}</b></span>
            ${er ? `<span>Zarobek: <b>${fmt(er.perH)}/h</b></span>` : `<span>Plan: <b>+${fmt(AP.stats.profitEst)}</b></span>`}
            <span>Sen: <b>${AP.stats.sleeps || 0}</b></span>
            <span>Paliwo: <b>${AP.stats.refuels}</b></span>
            <span>Naprawy: <b>${AP.stats.repairs}</b></span>
            <span>Opony: <b>${AP.stats.tires || 0}</b></span>
            <span>Media: <b>${AP.stats.contracts || 0}</b></span>
            <span>Kadry: <b>${AP.stats.hires || 0}</b></span>
          </div>
        </div>`;
  }

  // Tani odśwież co sekundę: tylko okienko statusu (pełny panel przy zmianach strony)
  function renderStatus() {
    const box = body && body.querySelector('.ltd-ap-status-box');
    if (!box) { render(); return; }
    const sec = box.closest('[data-sec]');
    if (sec) sec.ltdHtml = null;   // kolejny pełny render musi tę sekcję odświeżyć
    box.outerHTML = statusBoxHtml();
  }

  // Panel składany z sekcji: niezmienione sekcje zostają w DOM, więc przewijanie, zaznaczony tekst i kursor
  // nie skaczą przy każdym odświeżeniu (przeglądarka trzyma widok, gdy zmienia się coś wyżej)
  function patchBody(parts) {
    const old = new Map();
    for (const el of [...body.children]) {
      if (el.dataset && el.dataset.sec) old.set(el.dataset.sec, el); else el.remove();
    }
    let prev = null;
    for (const [key, html] of parts) {
      if (!html) continue;
      let el = old.get(key);
      if (el) old.delete(key);
      else { el = document.createElement('div'); el.dataset.sec = key; }
      if (el.ltdHtml !== html) { el.innerHTML = html; el.ltdHtml = html; }
      const at = prev ? prev.nextSibling : body.firstChild;
      if (el !== at) body.insertBefore(el, at);
      prev = el;
    }
    for (const el of old.values()) el.remove();
  }

  // Zestawy: liczby w firmie, uprawnienia vs naczepy i konkretne braki – z tym, co bot z nimi zrobi i kiedy
  const TYPE_SHORT = { 1: 'zwykła', 2: 'kontener', 3: 'wywrotka', 4: 'chłodnia', 5: 'cysterna', 6: 'niskopodłogowa', 7: 'chemikalia', 8: 'radioaktywne', 9: 'ciężki' };
  function crewHtml() {
    const m = crewModel();
    if (!m) return '';
    const gaps = crewGaps(m), now = Date.now();
    const types = [...new Set(((ST.garage && ST.garage.trailers) || []).map(x => x.type || 1))].filter(t => t > 1).sort((a, b) => b - a);
    let h = `<div class="ltd-sec">Zestawy</div>` +
      `<div class="ltd-muted">🚛 ${m.T} ${plural(m.T, 'ciężarówka', 'ciężarówki', 'ciężarówek')} · 🚚 ${m.R} ${plural(m.R, 'naczepa', 'naczepy', 'naczep')} · 🧑‍✈️ ${m.D} ${plural(m.D, 'kierowca', 'kierowców', 'kierowców')} · 👷 ${m.W} ${plural(m.W, 'pracownik', 'pracowników', 'pracowników')}</div>`;
    if (types.length) {
      h += `<div class="ltd-muted">Uprawnienia – kierowcy / naczepy tego albo wyższego typu: ${types.map(t => `${TYPE_SHORT[t]} <b>${m.qual(t)}/${m.need(t)}</b>`).join(' · ')}</div>`;
      const extra = types.filter(t => m.qual(t) > m.need(t) && (t === types[0] || m.qual(t) - m.need(t) > m.qual(types[0]) - m.need(types[0])));
      if (extra.length) h += `<div class="ltd-muted">ℹ Kierowców z uprawnieniami (${extra.map(t => TYPE_SHORT[t]).join(', ')}) jest więcej niż takich naczep – zostają: wożą też niższe typy, a przy zwolnieniu pieniądze za licencję przepadają. Bot nie szkoli nikogo, dopóki uprawnionych nie brakuje.</div>`;
    }
    if (m.D < m.T) h += `<div class="ltd-muted" style="color:#fbbf24;">Kierowców mniej niż ciężarówek (${m.D}/${m.T})</div>`;
    for (const x of gaps) {
      const tn = TYPE_SHORT[x.type] || '';
      const when = x.due ? 'teraz' : `za ${fmtDur((x.at - now) / 1000)}`;
      const sp = x.kind === 'driver' || x.kind === 'worker' ? spareFor(x.kind, x.type || 1) : null;
      const fix = sp ? `przewiozę wolnego: ${sp.name} z ${sp.loc} (taksówka)` : null;
      const t = x.kind === 'driver'
        ? `⚠ ${x.city}: ${x.pair.truck.name} + naczepa (${tn}) bez kierowcy → ${fix || `zatrudnię kierowcę${x.type > 1 ? ` z egzaminem (${tn})` : ''} ${when}`}`
        : x.kind === 'license'
          ? (x.ok ? `⚠ ${x.city}: ${x.driver.name} stoi przy naczepie (${tn}) bez uprawnień → szkolenie ${when}`
                  : `⏳ ${x.city}: naczepa (${tn}) czeka na kierowcę z uprawnieniami – uprawnieni jeżdżą gdzie indziej; szkolenie ${x.driver.name}, jeśli tak zostanie (${when})`)
          : `⚠ ${x.city}: zestaw bez pracownika magazynu → ${fix || `zatrudnię ${when}`}`;
      h += `<div class="ltd-item lvl2">${esc(t)}</div>`;
    }
    // Przewozy w toku i wolni ludzie (rezerwa – nic nie kosztują, bo pensje płaci się tylko za pracę)
    for (const mv of Object.values(AP.moves || {})) {
      const left = mv.until ? mv.until - now : null;
      h += `<div class="ltd-muted">🚚 W drodze: ${esc(mv.name)} ${esc(mv.from || '')} → <b>${esc(mv.to)}</b>${left > 0 ? ` (jeszcze ~${fmtDur(left / 1000)})` : ''}${mv.why && mv.why.length > 6 ? ` – ${esc(mv.why)}` : ''}</div>`;
    }
    const sp = crewSpares();
    const spares = sp.drivers.map(e => `${e.name} (${TYPE_SHORT[licOf(e)] || '?'}, ${e.loc})`).concat(sp.workers.map(e => `${e.name} (${e.loc})`));
    if (spares.length) h += `<div class="ltd-muted">🧍 Wolni (rezerwa, bez kosztów): ${esc(spares.join('; '))}</div>`;
    for (const [task, label] of [[AP.fireTask, t => `zwolnienie ${t.name} – ${t.why}`], [AP.upgradeTask, t => `ulepszenie: ${t.building === 'garage' ? 'garaż' : 'magazyn'} – ${t.why}`],
      [AP.moveTask, t => `przewóz ${t.name} → ${t.to} – ${t.why}`], [AP.sellTask, t => `sprzedaż ${t.name} – ${t.why}`]]) {
      if (task) h += `<div class="ltd-item lvl2">🛠 W toku: ${esc(label(task))}</div>`;
    }
    return h;
  }

  function routeHtml() {
    const g = ST.garage;
    if (!g || !g.trucks.length) return '';
    const bl = botLoad(), lr = learn(), c = lr.cond || {};
    const min = Math.round(bl.cycle / 60 * 10) / 10;
    let h = `<div class="ltd-sec">Długość tras</div>`;
    h += `<div class="ltd-muted">🧠 Bot: ~${Math.round(bl.W)} s pracy na kurs (${bl.src}) · zajęty ${Math.round(bl.busyPct * 100)}% czasu · ` +
      `${bl.K} ${plural(bl.K, 'zestaw', 'zestawy', 'zestawów')} → każdy zestaw może ruszać najwyżej co ~${String(min).replace('.', ',')} min, ` +
      `więc kurs krótszy niż ~${kmForSec(bl.cycle, g.trucks[0])} km nic nie daje (zestaw czeka na bota) – bot wybiera dłuższe</div>`;
    h += `<div class="ltd-muted">⛽ Pełny bak = najdłuższa trasa${AP.avoidRouteRefuel ? '' : ' (limit wyłączony w ⚙)'}: ${g.trucks.map(t => `${esc(t.name)} ~${tankRange(t)} km`).join(', ')}</div>`;
    const units = [...g.trucks.map(u => ['truck', u]), ...g.trailers.map(u => ['trailer', u])].filter(([, u]) => Number.isFinite(u.cond));
    if (units.length) {
      // najsłabsze pojazdy (to one ograniczają trasy): Maksymalny dystans (wiek) i ile z niego zostało przy obecnej kondycji
      const list = units.map(([kind, u]) => ({ kind, u, km: condRange(u, kind), mx: maxKmOf(u, kind), r: c[kind + u.id] })).sort((a, b) => a.km - b.km);
      h += `<div class="ltd-muted">🔧 Najdłuższa trasa teraz (maks. dystans × kondycja, zostaje ${S.condReserve}%): ` + list.slice(0, 5).map(({ u, km, mx, r }) =>
        `${esc(u.name)} ${u.cond}%${mx ? ` z ${mx} km` : ''} → ${Number.isFinite(km) ? '~' + km + ' km' : '?'}${mx || r ? '' : ' (szac.)'}`).join(', ') +
        (list.length > 5 ? ` · pozostałe ${list.length - 5}: więcej niż ${list[4].km} km` : '') + '</div>';
      const kn = lr.condKn || 0;
      h += `<div class="ltd-muted">📐 Model: kurs zużywa km ÷ Maksymalny dystans × 100% kondycji` +
        (kn ? ` · pomiary z ${kn} ${plural(kn, 'kursu', 'kursów', 'kursów')}: rzeczywisty spadek = ${String(condK().toFixed(2)).replace('.', ',')} × model${Math.abs(condK() - 1) < 0.15 ? ' (model się zgadza)' : ''}` : ' · sprawdzam na pierwszych kursach') + '</div>';
    }
    // Szybkie przejścia: ile kosztuje wejście na stronę, a ile pobranie Magazynu w tle (zmierzone)
    const ns = AP.navStat;
    if (ns && ns.navMs) {
      const save = ns.fetchMs ? Math.max(0, ns.navMs - ns.fetchMs) / 1000 : null;
      h += `<div class="ltd-muted">⚡ Szybkie przejścia${AP.fastNav === false ? ' (wyłączone w ⚙)' : ''}: wejście na stronę ~${(ns.navMs / 1000).toFixed(1).replace('.', ',')} s` +
        (ns.fetchMs ? `, Magazyn w tle ~${(ns.fetchMs / 1000).toFixed(1).replace('.', ',')} s → ~${save.toFixed(1).replace('.', ',')} s mniej przy każdej kolejnej decyzji` : '') +
        ` · pominięte wejścia do Magazynu: ${ns.saved || 0}, wejścia: ${ns.full || 0}</div>`;
    }
    const tl = lr.traffic || {}, tr = k => `×${String(+trafficMult(k).toFixed(2)).replace('.', ',')}${tl[k] && tl[k].n ? ` (z ${tl[k].n} ${plural(tl[k].n, 'kursu', 'kursów', 'kursów')})` : ' (szac.)'}`;
    h += `<div class="ltd-muted">🚦 Korki wydłużają jazdę: średnie ${tr(1)} · duże ${tr(2)} – bot liczy to w czasie kursu</div>`;
    const fails = [...recentCondFails('truck'), ...recentCondFails('trailer')];
    if (fails.length) h += `<div class="ltd-muted">⛔ Odmowy gry (24 h): ${fails.slice(-3).map(f => `${f.kind === 'truck' ? 'ciężarówka' : 'naczepa'} ${f.cond}% na ${f.km} km – „${esc(f.msg || '')}”`).join('; ')}</div>`;
    return h;
  }

  function render() {
    if (!body) return;
    const bal = ST.balance;
    const parts = [['ap', `
      <div class="ltd-ap-box">
        <div class="ltd-ap-top">
          <button class="ltd-btn-ap ${AP.enabled ? 'ltd-btn-ap-on' : 'ltd-btn-ap-off'}" data-a="toggle-ap">
            ${AP.enabled ? '⏹ ZATRZYMAJ AUTOPILOTA (ESC)' : '▶ URUCHOM AUTOPILOTA'}
          </button>
        </div>
        ${statusBoxHtml()}
      </div>`]];
    let h = '';

    if (bal != null) {
      const p = Math.max(0, Math.min(100, bal / S.target * 100));
      const er = shownEarnings(), fx = fixedPerDay();
      h += `<div class="ltd-bal">${fmt(bal)} <small>/ ${fmt(S.target)} · ${p.toFixed(1)}%</small></div>
            <div class="ltd-bar"><i style="width:${p}%"></i></div>`;
      if (er) {
        const day = er.perH * 24 - (fx || 0);
        h += `<div class="ltd-muted">Netto z ładunków: <b class="pos">${fmt(er.perH)}/h</b> (ost. ${er.label}, ${er.n} ${plural(er.n, 'kurs', 'kursy', 'kursów')})${fx ? ` · po kosztach stałych ~<b class="${day < 0 ? 'neg' : 'pos'}">${fmt(day)}/dzień</b>` : ''}` +
             (day > 0 && bal < S.target ? ` · cel za ~${fmtDur((S.target - bal) / day * 86400)}` : '') + '</div>';
      } else {
        h += `<div class="ltd-muted">Netto z ładunków: zbieram dane do prognozy (min. 3 zakończone kursy)` +
             (ST.change != null ? ` · zmiana dziś: <b class="${ST.change < 0 ? 'neg' : 'pos'}">${fmt(ST.change)}</b>` : '') + '</div>';
      }
    }
    parts.push(['bal', h]);
    h = '';

    // Flota: każda ciężarówka z danymi z gry
    const g = ST.garage;
    if (g && g.trucks.length) {
      h += `<div class="ltd-sec">Flota</div>`;
      for (const t of g.trucks) {
        const sp = truckSpec(t), lvl = ST.fuelLevels && ST.fuelLevels[t.id];
        const wc = wearCost(t, 'truck', 100);
        h +=`<div class="ltd-unit"><div><b>${esc(t.name)}</b> <span class="ltd-muted">model ${t.model ?? '?'} · ${(1 / sp.lPerKm).toFixed(2).replace('.', ',')} km/L (${sp.src}) · ${sp.speed} km/h${sp.hp ? ' · ' + sp.hp + ' KM' : ''}</span></div>` +
             `<div class="ltd-muted">${truckStateHtml(t)} · ${t.tires === 'winter' ? '❄ zimowe' : t.tires === 'summer' ? '☀ letnie' : 'opony ?'}${ST.tireCond && ST.tireCond[t.id] && Number.isFinite(ST.tireCond[t.id].cond) ? ` ${ST.tireCond[t.id].cond}%` : ''} · stan ${Number.isFinite(t.cond) ? t.cond + '%' : '?'}` +
             `${lvl ? ` · ⛽ ${Math.round(lvl.cur)}/${lvl.max} L` : ''} · zużycie ~€${(wc.v / 100).toFixed(2).replace('.', ',')}/km (${wc.src})</div></div>`;
      }
      const lone = loneTrailers();
      if (lone.length) h += `<div class="ltd-muted" style="color:#fbbf24;">📦 Naczepy bez ciągnika: ${lone.map(x => esc(`${x.name} (${(TYPES[x.type] || '').toLowerCase()}, ${x.loc || '?'})`)).join('; ')}` +
        `${AP.autoNewSets ? ' → bot dokupi ciężarówkę (szczegóły w Reinwestycjach)' : ' → włącz Auto-rozbudowę w ⚙'}</div>`;
    }
    parts.push(['fleet', h]);
    parts.push(['crew', crewHtml()]);

    // Strażnik 24/7
    const gd = guardian();
    parts.push(['guard', gd.length ? `<div class="ltd-sec">Strażnik 24/7</div>` + gd.map(item).join('') : '']);
    h = '';

    // Ekonomia z danych gry
    const lr = learn();
    const f = ST.fuel || {};
    h += `<div class="ltd-sec">Ekonomia (z danych gry)</div>`;
    h += `<div class="ltd-muted">Paliwo: mediana ${medianFuel().toFixed(3).replace('.', ',')} €/L` +
         (f.list && f.list.length ? ` · najtaniej ${esc(f.list[0].c)} ${f.list[0].p.toFixed(3).replace('.', ',')}` : '') +
         (f.corp ? ` · <b>korporacja ${f.corp.price.toFixed(3).replace('.', ',')} €/L</b>${f.corp.avail != null ? ` (${Math.round(f.corp.avail).toLocaleString('pl-PL')} L)` : ''}` : '') + '</div>';
    h += `<div class="ltd-muted">Kierowca ${lr.driverPerKm.toFixed(2).replace('.', ',')} €/km · pracownik €${lr.workerUnit} · menedżer €${lr.managerFee}/ładunek · 1 h gry ≈ ${Math.round(lr.secPerGameHour)} s · załadunek ${Math.round(lr.phase.load)} s, rozładunek ${Math.round(lr.phase.unload)} s, zakończenie ${Math.round(lr.phase.finish)} s</div>`;

    parts.push(['econ', h]);
    h = '';

    // Długość tras: ile bot nadąży obsłużyć, zasięg baku i kondycji
    h += routeHtml();
    // Najlepsze trasy dla wolnych zestawów (prawdziwy zysk, ocena efektywna przy obciążeniu bota, bez tras dłuższych niż bak)
    if (ST.trips && ST.trips.rows && ST.trips.rows.length && g) {
      const bl = botLoad();
      const best = ST.trips.rows.map(x => {
        const s = setFor(x.from, x.type);
        if (!s || (AP.avoidRouteRefuel && x.km > tankRange(s.truck))) return null;
        const e = tripEcon(x, s.truck, s.trailer);
        return { x, e, ...tripScore(e, bl), weak: x.km > Math.min(condRange(s.truck, 'truck'), condRange(s.trailer, 'trailer')) };
      }).filter(o => o && o.e.profit > 0).sort((a, b) => b.eff - a.eff).slice(0, 4);
      if (best.length) {
        h += `<div class="ltd-sec">Najlepsze trasy teraz</div>` + best.map(({ x, e, eff, weak }) =>
          `<div class="ltd-row"><span>${esc(x.from)} → ${esc(x.to)} · ${x.km} km${x.traffic ? ' 🚦' : ''}${weak ? ' 🔧' : ''}${x.corp ? ' · korpo' : ''}</span><b>${fmt(e.profit)} · ${fmt(eff)}/h</b></div>`).join('');
      }
    }
    parts.push(['trips', h]);

    // Reinwestycje: cel, ile brakuje, zysk/h, zwrot, blokady, dane, inne możliwości
    parts.push(['invest', reinvestHtml()]);

    // Dziennik (10 ostatnich, po kliknięciu wszystkie zapamiętane – przydaje się do diagnozy)
    if (AP.log && AP.log.length) {
      const n = UI.logAll ? AP.log.length : Math.min(10, AP.log.length);
      parts.push(['log', `<div class="ltd-sec">Dziennik</div><div class="ltd-log">` + AP.log.slice(0, n).map(x =>
        `<div><span>${new Date(x.t).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</span> ${esc(x.msg)}</div>`).join('') + '</div>' +
        (AP.log.length > 10 ? `<button data-a="log-all" class="ltd-skip">${UI.logAll ? 'Pokaż 10 ostatnich' : `Pokaż wszystkie (${AP.log.length})`}</button>` : '')]);
    }

    const src = [['Magazyn', ST.warehouse], ['Garaż', ST.garage], ['Ludzie', ST.employees], ['Paliwo', ST.fuel], ['Trasy', ST.trips],
                 ['Salon', ST.models], ['Opony', ST.tires], ['Media', ST.util], ['Mechanicy', ST.mech], ['Budynki', ST.props], ['Finanse', ST.fixed]];
    parts.push(['src', `<div class="ltd-src">Dane: ${src.map(([n, d]) => d && d.t ? `<span class="ok">${n} ${mins(d.t)}′</span>` : `<span class="miss">${n} ✗</span>`).join(' ')}</div>`]);
    patchBody(parts);
    // Po przejściu bota na inną stronę: przewinięcie panelu z poprzedniej strony (gdy treść już jest dość wysoka)
    if (restoreTop != null) {
      body.scrollTop = restoreTop;
      if (Math.abs(body.scrollTop - restoreTop) < 2 || Date.now() > restoreUntil) restoreTop = null;
    }
  }

  // ---------- start skryptu ----------
  chrome.storage.local.get(['ltd3_s', 'ltd3_state', 'ltd3_pos', 'ltd3_ap'], r => {
    S = { ...DEF, ...(r.ltd3_s || {}) };
    ST = r.ltd3_state || {};
    AP = { ...DEF_AP, ...(r.ltd3_ap || {}) };
    AP.stats = { ...DEF_AP.stats, ...(AP.stats || {}) };
    AP.cool = AP.cool || {};
    AP.blocked = AP.blocked || {};
    AP.due = AP.due || {};
    AP.log = Array.isArray(AP.log) ? AP.log : [];
    // 3.1: stała rezerwa inwestycyjna €25.000 blokowała rozbudowę przy obecnych saldach → auto;
    // rozbudowa floty (ciężarówka do nieużywanej naczepy) domyślnie włączona
    if (!AP.migr31) {
      if (AP.expandReserve === 25000) AP.expandReserve = 0;
      AP.autoNewSets = true;
      AP.migr31 = true;
      saveAP();
    }
    const lr = ST.learn || {};
    ST.learn = { ...JSON.parse(JSON.stringify(LEARN0)), ...lr, phase: { ...LEARN0.phase, ...(lr.phase || {}) } };

    buildPanel(r.ltd3_pos);
    watchToasts();
    // Zmiany wewnątrz panelu (odliczanie co sekundę) nie mogą wyzwalać ponownej analizy strony
    obs = new MutationObserver(muts => {
      if (panel && muts.every(m => panel.contains(m.target))) return;
      schedule();
    });
    analyze();

    const sp = ST.syncProg;
    if (sp && Date.now() - sp.t < 5 * 60000) syncAll(sp.i);
    else if (!ST.synced || mins(ST.synced) >= S.syncMin) syncAll();
    setInterval(() => { if (!syncing && mins(ST.synced) >= S.syncMin) syncAll(); }, 60000);
    setInterval(schedule, 5000);

    // Heartbeat co sekundę na timerze service workera (działa też, gdy karta jest w tle)
    (async () => {
      for (;;) {
        await sleep(1000);
        try { heartbeat(); } catch (e) { console.warn('[LTD] heartbeat', e); }
      }
    })();

    // Jeśli autopilot był aktywny przed przeładowaniem strony, kontynuuj
    if (AP.enabled) {
      lastProgress = Date.now();
      // Praca bota liczy się od przejścia z poprzedniej strony (wczytanie strony też trwa), ale nie w patrolu ani przerwie
      const now = Date.now();
      if (!(AP.breakUntil > now) && !(AP.nextPatrolTime > now)) workFrom = AP.lastGoT && PAGE_T0 - AP.lastGoT < 30000 ? AP.lastGoT : PAGE_T0;
      later(rand(400, 800));
    }
  });
})();
