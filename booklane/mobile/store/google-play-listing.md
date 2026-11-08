# Availvo: Google Play Console answers

## Create app
| Field | Value |
|---|---|
| App name (30) | Availvo: Bookings & Leads |
| Default language | English (United States) |
| App or game | App |
| Free or paid | Free |
| Package name | co.availvo.app (set by the first upload) |

## Main store listing
**Short description (80)**
Get notified when customers book. Manage calls, leads and your team on the go.

**Full description**
Availvo is the phone app for businesses that take bookings on Availvo. It puts your calls, leads and team in your pocket.

KNOW THE MOMENT SOMEONE BOOKS
Get a notification when a customer books, reschedules or cancels a call with you, when a teammate passes you a call, when someone asks for a contract, and when a customer texts back. Tap it to open that call or lead.

YOUR DAY AT A GLANCE
See every upcoming call for you or your whole team, with the customer's answers, phone number and notes. Reschedule, cancel, or pass a call to a teammate who is free at that time.

FOLLOW UP ON EVERY LEAD
Availvo saves people who start a booking form and leave before finishing. Call, text or email them in one tap, and mark how each call went (booked, not booked yet, or no-show) so the right follow-up messages go out.

SHARE YOUR BOOKING LINK ANYWHERE
Send a booking page to a customer from the share sheet, by text, email or any app.

RUN YOUR TEAM
Team performance shows calls held, show rate and bookings per person. Round robin, priorities and levels decide who gets each call.

Availvo works with Google Calendar and Outlook so customers are only offered times you are free, and new bookings land on your calendar.

You need an Availvo account to use the app. Create one free at app.availvo.co or in the app.

**Graphics** (all in `store/screenshots/`)
- App icon: `google-play-icon-512.png`
- Feature graphic: `google-play-feature-graphic-1024x500.png`
- Phone screenshots: the five `android-phone-*.png`, in number order

**Category:** Business. **Tags:** Scheduling, Business management, Productivity.
**Contact:** email alex@weddingsunlimited.com, phone +1 832-208-4525, website https://availvo.co
**Privacy policy:** https://app.availvo.co/privacy

## App content (Policy > App content)
| Section | Answer |
|---|---|
| Privacy policy | https://app.availvo.co/privacy |
| Ads | No, the app does not contain ads |
| App access | All or some functionality is restricted. Add instructions: name "Demo company", email and password from the Companies screen's "Make the review login" (see the guide), notes: "Log in with these. The account opens a sample company with calls and leads." |
| Content rating | Questionnaire category: "All other app types". Answer No to every question (no violence, sex, language, drugs, gambling; users can interact? **No**: customers book through web pages, there is no chat or user-to-user content in the app; shares location? No; digital purchases? No). Expected rating: Everyone / PEGI 3. |
| Target audience | 18 and over only. Not designed for children. |
| News app | No |
| COVID-19 contact tracing | No |
| Data safety | See below |
| Government app | No |
| Financial features | My app doesn't provide any financial features |
| Health | No health features |
| Account deletion | Users can create an account in the app: Yes. Delete account URL: **https://app.availvo.co/delete-account**. In-app: Menu > Account > Delete your account. Data deleted: everything listed on that page. |

## Data safety
- Does your app collect or share any of the required user data types? **Yes**
- Is all user data encrypted in transit? **Yes**
- Do you provide a way for users to request that their data is deleted? **Yes** (in the app, and at the URL above)

Data **collected** (none of it is **shared**: the companies that host, email and deliver notifications act as our service providers, which Google does not count as sharing). None is optional unless noted, none is processed ephemerally.

| Data type | Purposes |
|---|---|
| Personal info > Name | App functionality, Account management |
| Personal info > Email address | App functionality, Account management |
| Personal info > Phone number (optional) | App functionality |
| Personal info > Address (optional; customers' addresses for in-person calls) | App functionality |
| Personal info > Other info (answers customers give on booking forms) | App functionality |
| Device or other IDs (notification token) | App functionality |

Not collected: location, financial info, health, messages, photos/videos, audio, files, calendar events (only busy/free times are read, on the server, and not stored), contacts, app activity, web browsing, app info and performance.

## Release
1. Testing > Internal testing: create a release, upload the first `.aab` by hand (Codemagic's artifact), add yourself as a tester, roll out. Check notifications on a real phone.
2. Production: create a release with the same build, roll out to 100%, send for review.

New **organization** developer accounts can go straight to production. A **personal** account would first need 12 testers in closed testing for 14 days, which is why the guide says to register as an organization.
