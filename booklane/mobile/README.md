# Availvo phone app

Capacitor 8 shell for iPhone and Android (`co.availvo.app`). It opens https://app.availvo.co/app; the
dashboard's `public/js/app-native.js` (served by the main app) switches on the native parts:
notifications, share sheet, browser sheet for calendar sign-in, Android back button.

- `capacitor.config.json` - app id, server URL, offline page (`www/offline.html`)
- `ios/`, `android/` - native projects (iOS uses Swift Package Manager, no CocoaPods)
- `assets/` + `design/` - icon and splash sources; `npm run assets` regenerates every size
- `store/` - store listings, screenshots and **SUBMISSION-GUIDE.md**
- Builds run on Codemagic from `/codemagic.yaml` in the repo root

After changing plugins or config: `npm install && npx cap sync`.
