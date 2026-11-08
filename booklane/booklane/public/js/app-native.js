/* The Availvo phone app.
   The iPhone and Android apps show this same dashboard, and this file is what makes it behave like an
   app there. In an ordinary browser it does nothing at all.

   - Notifications: asks once after login, registers the phone with the server, opens the right
     screen when one is tapped, and forgets the phone on logout or account deletion.
   - Links that leave the dashboard (booking pages, help, other sites) open in the phone's own
     browser sheet instead of replacing the app.
   - Connecting Google or Outlook happens in that browser sheet too, already logged in, because
     Google refuses sign-in inside an app.
   - Links shared from Share & embed use the phone's share sheet.
   - Android's back button goes back, then leaves the app. */
(function () {
  'use strict';
  const bridge = !!(window.androidBridge || (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge));
  window.AvailvoApp = { native: false };
  if (!bridge) return;

  const s = document.createElement('script');
  s.src = '/static/js/vendor/capacitor.js';
  s.onload = start;
  document.head.appendChild(s);

  function start() {
    const Cap = window.Capacitor;
    if (!Cap || !Cap.registerPlugin || !Cap.isNativePlatform()) return;
    const platform = Cap.getPlatform();
    const has = (n) => Cap.isPluginAvailable(n);
    const P = {};
    // The trial build passed around for testing has no Firebase file, and asking for a token there
    // would fail, so it leaves notifications out (its user agent says NoPush).
    const noPush = / NoPush\b/.test(navigator.userAgent);
    for (const n of ['App', 'Browser', 'PushNotifications', 'Share', 'SplashScreen', 'StatusBar']) if (has(n) && !(noPush && n === 'PushNotifications')) P[n] = Cap.registerPlugin(n);
    const A = window.A;
    const TOKEN_KEY = 'availvo.pushToken';
    const ASKED_KEY = 'availvo.pushAsked';
    const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

    document.documentElement.classList.add('in-app', `in-app-${platform}`);
    const app = window.AvailvoApp = { native: true, platform, trial: noPush };

    // ------------------------------------------------------------ notifications
    let listening = false;
    async function sendToken(token) {
      store.set(TOKEN_KEY, token);
      let version = '';
      try { version = P.App ? (await P.App.getInfo()).version : ''; } catch (e) { /* optional */ }
      try { await A.api('POST', '/push/devices', { platform, token, app_version: version, device_name: platform === 'ios' ? 'iPhone' : 'Android phone' }); } catch (e) { /* logged out: sent again after login */ }
    }
    function listen() {
      if (listening || !P.PushNotifications) return;
      listening = true;
      P.PushNotifications.addListener('registration', (t) => sendToken(t.value));
      P.PushNotifications.addListener('registrationError', (e) => console.warn('[push] registration failed', e && e.error));
      // Tapped a notification: go to the screen it is about.
      P.PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
        const url = a && a.notification && a.notification.data && a.notification.data.url;
        if (url && /^\/app(#|$|\/)/.test(url)) { if (location.pathname === '/app' && url.startsWith('/app#')) location.hash = url.slice(4); else location.href = url; }
      });
      // A notification while the app is open: show it as a toast instead of the system banner.
      P.PushNotifications.addListener('pushNotificationReceived', (n) => { if (A && A.toast) A.toast([n.title, n.body].filter(Boolean).join(': ')); });
    }

    /** Ask for permission (only when `ask`), then register. Resolves to the permission state. */
    app.enablePush = async function enablePush(ask) {
      if (!P.PushNotifications) return 'unavailable';
      listen();
      let perm = await P.PushNotifications.checkPermissions();
      if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
        if (!ask) return perm.receive;
        store.set(ASKED_KEY, '1');
        perm = await P.PushNotifications.requestPermissions();
      }
      if (perm.receive !== 'granted') return perm.receive;
      await P.PushNotifications.register();
      return 'granted';
    };

    /** On logout or account deletion: this phone stops getting that person's notifications. */
    app.forgetDevice = async function forgetDevice() {
      const token = store.get(TOKEN_KEY);
      if (token) { try { await A.api('POST', '/push/devices/remove', { token }); } catch (e) { /* session may already be gone */ } }
    };

    // After each login: register quietly if allowed, and ask once if it never has been.
    let lastUser = null;
    setInterval(() => {
      const uid = A && A.me && A.me.user && A.me.user.id;
      if (!uid || uid === lastUser) { if (!uid) lastUser = null; return; }
      lastUser = uid;
      app.enablePush(!store.get(ASKED_KEY)).catch(() => {});
    }, 1000);

    // ------------------------------------------------------------ links and the browser sheet
    const openBrowser = (url) => (P.Browser ? P.Browser.open({ url, presentationStyle: 'popover' }) : (location.href = url));

    async function openLoggedIn(path) {
      try {
        const r = await A.api('POST', '/auth/handoff', { next: path });
        await openBrowser(r.url);
      } catch (e) { A.toast(e.message, true); }
    }

    document.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      const share = e.target.closest('[data-copy]');
      if (share && P.Share && /^https?:\/\//.test(share.dataset.copy || '')) {
        e.preventDefault(); e.stopImmediatePropagation();
        P.Share.share({ url: share.dataset.copy, dialogTitle: 'Share link' }).catch(() => A.copy(share.dataset.copy));
        return;
      }
      const a = e.target.closest('a[href]');
      if (!a) return;
      let url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch (x) { return; }
      if (url.protocol === 'mailto:' || url.protocol === 'tel:' || url.protocol === 'sms:') return; // the system handles these
      if (!/^https?:$/.test(url.protocol)) return;
      const same = url.origin === location.origin;
      if (same && url.pathname.startsWith('/api/')) return; // exports and downloads need this session
      // Calendar sign-in, in the real browser, already logged in.
      if (same && url.pathname.startsWith('/oauth/')) { e.preventDefault(); openLoggedIn(url.pathname + url.search); return; }
      // Anything that is not part of the dashboard opens in the browser sheet.
      if (!same || a.target === '_blank' || !url.pathname.startsWith('/app')) { e.preventDefault(); openBrowser(url.href); }
    }, true);

    window.open = (u) => { if (u) openBrowser(new URL(u, location.href).href); return null; };

    // Coming back from the browser sheet (a calendar just connected): refresh what is on screen.
    if (P.Browser) P.Browser.addListener('browserFinished', async () => { try { A.me = await A.api('GET', '/auth/me'); A.render(); } catch (e) { /* logged out */ } });
    if (P.App) {
      P.App.addListener('resume', async () => { if (A.me) { try { A.me = await A.api('GET', '/auth/me'); } catch (e) { /* session ended: the next call shows login */ } } });
      P.App.addListener('backButton', (ev) => {
        const menu = document.querySelector('.sidebar.open');
        if (menu) { menu.classList.remove('open'); return; }
        if (ev && ev.canGoBack) history.back(); else P.App.exitApp();
      });
    }

    // Logging out forgets this phone first, while the session can still say whose it is.
    document.addEventListener('click', async (e) => {
      if (!e.target.closest('[data-logout]')) return;
      e.stopImmediatePropagation(); e.preventDefault();
      await app.forgetDevice();
      try { await A.api('POST', '/auth/logout', {}); } catch (x) { /* already out */ }
      A.me = null; location.hash = '#/login';
    }, true);

    if (P.StatusBar) { P.StatusBar.setStyle({ style: 'DARK' }).catch(() => {}); }
    if (P.SplashScreen) P.SplashScreen.hide().catch(() => {});
  }
})();
