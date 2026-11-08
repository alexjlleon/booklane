# Getting Availvo into the App Store and Google Play

Prepared Nov 8, 2026. Everything that can be done without your accounts is done. What is left needs you to sign up, pay, or click "Submit", in this order.

## What is already done
- **The app.** `booklane/mobile` is a Capacitor 8 app (bundle ID `co.availvo.app`) that opens the Availvo dashboard at app.availvo.co, with: push notifications, the iOS/Android share sheet for booking links, calendar sign-in in the phone's own browser sheet (Google blocks sign-in inside apps), the Android back button, an offline screen, icon and splash screen. iPhone only (no iPad, so no iPad screenshots needed), portrait.
- **The server** (live): notifications to iPhone (Apple APNs) and Android (Firebase), sent for new / moved / cancelled / passed-on calls (to the host), contract requests and customer text replies (to people on those alert lists). Each person can switch kinds off on **Account**. **Delete my account** on Account (both stores require it), and a public page at https://app.availvo.co/delete-account (Google requires it). Privacy policy updated for the app.
- **Review login**: a button on **Companies** makes a made-up company ("Bright Oak Studio") with calls and leads for the reviewers.
- **Cloud builds**: `codemagic.yaml` in the repo root builds the iPhone app and uploads it to TestFlight, and builds the Android bundle. No Mac needed.
- **Store text and graphics**: `app-store-listing.md`, `google-play-listing.md`, and `screenshots/`.
- **Android upload keystore**: sent to you in the chat (`availvo-upload.keystore` + its passwords). Keep both somewhere safe.

## Step 1. D-U-N-S number for Weddings Unlimited LLC (free, start today)
Apple and Google both require it for a company account, and it can take up to 5 business days.
1. Go to https://developer.apple.com/enroll/duns-lookup/ and search for Weddings Unlimited LLC, 7676 Hillmont St, Houston, TX 77040.
2. If it is found, write the 9-digit number down. If not, submit the request on that same page. Dun & Bradstreet emails you.

Use the legal name exactly as on the Texas filing, and the same address everywhere (Apple, Google, Microsoft already has it).

## Step 2. Apple Developer Program ($99 a year)
1. https://developer.apple.com/programs/enroll/ → sign in with an Apple ID for the business (making one with alex@weddingsunlimited.com is cleanest) → **Enroll as an organization**.
2. Legal entity: Weddings Unlimited LLC, the D-U-N-S number, website https://weddingsunlimited.com, work email alex@weddingsunlimited.com.
3. Apple calls to verify, then you pay. Usually 1 to 3 days after the D-U-N-S is live.

## Step 3. Google Play Console ($25 once)
1. https://play.google.com/console/signup → **Organization**. Same legal name, D-U-N-S, address and phone.
2. Complete identity verification (Google asks for the D-U-N-S and may ask for a document). Organization accounts can publish straight to production; personal accounts would need 12 testers for 14 days first.

## Step 4. Apple: app ID, notification key, App Store Connect
1. https://developer.apple.com/account/resources/identifiers → **+** → App IDs → App → Description "Availvo", Bundle ID **explicit** `co.availvo.app` → tick **Push Notifications** → Register.
2. Keys → **+** → name "Availvo push" → tick **Apple Push Notifications service (APNs)** → Register → **Download** the `AuthKey_XXXXXXXXXX.p8` (one download only). Note the **Key ID**, and your **Team ID** (Membership details).
3. In Availvo (app.availvo.co, logged in as you) → Settings → Integrations → **Phone app notifications**: paste Apple key ID, Apple team ID, and the whole .p8 file (open it in Notepad). Leave the bundle ID blank. Save, then **Check connection**.
4. https://appstoreconnect.apple.com → Apps → **+** New App: iOS, name **Availvo**, English (U.S.), bundle ID co.availvo.app, SKU `availvo-ios-1`, Full access.
5. Users and Access → Integrations → **App Store Connect API** → Team Keys → **+** → name "Codemagic", access **App Manager** → download the `.p8` (one download only) and note the **Issuer ID** and **Key ID**.

## Step 5. Firebase (Android notifications, free)
1. https://console.firebase.google.com → Add project "Availvo" (Google Analytics off).
2. Add app → Android → package name `co.availvo.app`, nickname Availvo → **Download google-services.json**. Skip the SDK steps (already in the app).
3. Project settings → **Service accounts** → **Generate new private key** → a .json downloads.
4. Availvo → Integrations → Phone app notifications → paste that whole .json into **Firebase service account JSON** → Save → Check connection.

## Step 6. Codemagic (cloud builds; free tier is 500 macOS minutes a month)
1. https://codemagic.io → sign up with GitHub → add the repository **alexjlleon/booklane**. It finds `codemagic.yaml` by itself.
2. Team settings → **Team integrations** → Developer Portal / App Store Connect → Connect → name it exactly **Availvo ASC** → Issuer ID, Key ID and the "Codemagic" .p8 from Step 4.5.
3. Team settings → **Code signing identities**:
   - iOS certificates → **Generate certificate** → Apple Distribution, using Availvo ASC. (Codemagic keeps it.)
   - iOS provisioning profiles → **Fetch profiles** → pick the App Store profile for co.availvo.app (Codemagic creates it if missing; it must be created after Step 4.1 so it includes push).
   - Android keystores → **Upload** `availvo-upload.keystore`, reference name **availvo_upload**, with the passwords from the readme.
4. App settings → **Environment variables**:
   - group **firebase**: `GOOGLE_SERVICES_JSON`, secure, value = the google-services.json file in base64. On Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\google-services.json")) | Set-Clipboard`, then paste.
   - group **google_play**: `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`, secure. Leave it as `{}` for the first build; fill it in at Step 9.5.
5. Start builds: **Start new build** → workflow **Availvo iPhone** and again for **Availvo Android**. (Or push a git tag `ios-v1.0.0` / `android-v1.0.0`.)
   - iPhone: about 15 minutes, then it appears in App Store Connect → TestFlight. Apple emails when it has processed.
   - Android: download the `.aab` from the build's Artifacts.

## Step 7. Try it on your own phones
1. iPhone: install **TestFlight** from the App Store; you are an internal tester automatically. Open Availvo, log in, allow notifications.
2. Account → Phone notifications should list your iPhone. Press **Send a test notification**.
3. Book a call on one of your pages from another device and watch the notification arrive. Tap it.
4. Try Calendars → Connect Google Calendar (opens a browser sheet already logged in).
5. Android: Play Console → Testing → **Internal testing** → upload the `.aab` → add your Google account as a tester → open the opt-in link on the phone and install.

## Step 8. Make the review login
On app.availvo.co → Menu → **Companies** → **Make the review login**. Copy the email and password. Do this right before submitting; pressing it again changes the password.

## Step 9. Submit
**Apple** (everything to paste is in `app-store-listing.md`):
1. App Store Connect → Availvo → App Information, Pricing (Free), App Privacy (answers in the file; also publish the privacy policy URL there).
2. Version 1.0.0: screenshots (`screenshots/iphone-6.9-*.png`), promotional text, description, keywords, URLs, **Build** (pick the TestFlight build), App Review Information (login + notes), age rating.
3. **Add for Review** → **Submit**. Review usually takes 1 to 3 days.

**Google** (everything is in `google-play-listing.md`):
1. Play Console → Create app → fill **App content** (privacy policy, ads, app access with the review login, content rating, target audience, data safety, account deletion).
2. **Main store listing**: text, icon, feature graphic, screenshots.
3. **Production** → Create release → add the same `.aab` (or promote the internal one) → release notes "First release." → **Send for review**. First reviews take a few days, sometimes up to a week.
4. Play Console → Setup → **API access** → create a service account with Release manager permission → paste its JSON key into Codemagic's `GCLOUD_SERVICE_ACCOUNT_CREDENTIALS`. From then on, Android builds upload to internal testing by themselves.

## After launch
- **Most changes need no new app.** The app shows the live dashboard, so anything pushed to `main` is in the app straight away. A new store build is only needed when the native shell changes (new plugin, icon, permissions).
- **To release a new native version**: raise `versionName` in `android/app/build.gradle` and `MARKETING_VERSION` in the Xcode project, run both Codemagic workflows, submit as above. Build numbers go up automatically.
- **Changing anything on the Google OAuth consent screen** still needs a new Google verification (unchanged by this work; the app uses the same web sign-in).

## If Apple pushes back
- *4.2 Minimum functionality ("just a website")*: reply that the app is the operational tool for business accounts, with native push notifications for bookings and customer replies, notification actions that open the call, the native share sheet, and the system browser for calendar sign-in, and that the notifications cannot be delivered by the website. Offer the demo steps from the review notes.
- *5.1.1(v) account deletion*: Menu → Account → Delete your account.
- *2.1 can't log in*: make a fresh review login (Step 8) and reply with it.
