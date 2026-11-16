# Releasing Mellerick Field privately on iPhone

**For:** Justin. **Written:** 16 November 2026. **Goal:** move staff from
TestFlight to a proper App Store install that only Mellerick staff can get.

There are two private routes. Plan A is the one to aim for; Plan B is the
fallback if Apple Business Manager is slow or awkward.

| | Plan A: Custom app (Apple Business Manager) | Plan B: Unlisted app |
|---|---|---|
| Who can find it | Only your organisation, through Apple Business Manager | Anyone with the direct link; never in search |
| How staff install | A redeem link or code you send each person (or your phone-management system, if you ever get one) | You send them the App Store link |
| Extra account needed | Apple Business Manager (free, needs the D-U-N-S number) | None |
| Can be undone | **No.** Once released as a custom app it can never become public | Yes, Apple can change it later |

Either way the app still goes through App Review, and everyone still signs in
with the Mellerick account the office gives them. The sign-in is the real
lock; the store route only decides who can download it.

---

## What is already done (no action)

- Builds run on Expo (EAS) from GitHub: **Actions → Build phone app → Run
  workflow → ios**. Each one goes to TestFlight by itself. Build 33 shipped on
  16 November 2026.
- Apple Developer account (team 864FRPRM47) and the App Store Connect app
  record (app ID 6806677435, bundle `au.com.mellerick.field`) exist.
- Signing certificates, the push key and the App Store Connect key are stored
  on Expo. Nothing more is needed on that side for a custom or unlisted app:
  it is the same App Store build, only the distribution setting differs.
- Build numbers count up by themselves; the version is 1.0.0.
- iPhone only (no iPad), so no iPad screenshots are needed.
- Encryption answer (exempt, standard HTTPS only) is built into the app, so
  App Store Connect will not ask the export question on every build.
- Every permission prompt explains why it is needed; the privacy manifest
  Apple requires is in the app.
- The app has **Privacy policy** and **Delete account** links on the sign-in
  screen, at the bottom of My Jobs, and on the office More screen. They open
  the web pages below. (These links reach phones from the next build.)
- Public pages on the web app:
  - Privacy policy: `https://mellerick-app.vercel.app/privacy`
  - Account deletion: `https://mellerick-app.vercel.app/delete-account`

Open both in a private browser window once to check they load without signing
in.

---

## Step 1: Start the next build

This picks up the privacy links and the clearer permission wording.

1. GitHub → the `mellerick` repository → **Actions** → **Build phone app**.
2. **Run workflow** → Which phones: **ios** → **Run workflow**.
3. Wait for the green tick (about 30–60 minutes). The build appears in App
   Store Connect → **Apps** → **Mellerick Field** → **TestFlight** soon after.
4. Install it from TestFlight and check: sign-in screen shows "Privacy policy ·
   Delete account", and both open.

## Step 2: Make a reviewer account

Apple's reviewer needs to sign in as a technician who has an open job, or they
will see an empty screen and reject the app.

1. Web app → **Staff** → **Invite** a technician with a mailbox you can read,
   for example `appreview@mellerick.com`. Name it "App Review".
2. Open the invite email, set a password. Write the email and password down
   for Step 5.
3. Give this account the QA job: open job **#834 "QA FIXTURE — do not
   invoice, do not delete"** → Schedule → add the App Review technician to the
   crew (today or a few days ahead). Leave the existing test technician on it
   too; the automated phone tests need them.
4. Check #834's site has a map pin (the job page warns if it does not). If it
   has none, the location permission prompt never appears for the reviewer.
5. Sign in on a phone as App Review and confirm #834 shows in My Jobs.

**Please decide:** technicians can search and open any job (Search tab). So
the reviewer could look up real customers' names and addresses. If that is
not acceptable, tell the developer before submitting; a reviewer-only
restriction can be added.

## Step 3: Record a short video of auto clock-in (recommended)

Apple questions apps that use location "Always". The reviewer is overseas and
will never arrive at the job site, so show them.

1. On a phone with a fresh install, screen-record: sign in → the "Mellerick
   Field uses your location…" screen → **Continue** → allow location → later
   allow **Always** → drive to (or arrive at) a job site → the job shows
   clocked on without tapping anything.
2. Upload it somewhere a link can be opened without signing in (an unlisted
   YouTube video, or a Google Drive / OneDrive link set to "anyone with the
   link"). Keep the link for Step 5.

## Step 4: Screenshots

App Store Connect → **Apps** → **Mellerick Field** → **Distribution** tab →
the 1.0 version under **iOS App** → **Previews and Screenshots**.

- Upload 3–5 iPhone screenshots in the **6.9" Display** slot (1320 × 2868
  pixels, portrait). An iPhone 15/16 Pro Max screenshot is exactly that size.
  Apple shrinks them for smaller iPhones.
- Use the App Review account so no real customer names, addresses or dollar
  figures are visible. Suggested: My Jobs, a job's Overview, the Time tab,
  Photos.

## Step 5: Fill in the version page

Same page as Step 4 (Distribution → the 1.0 version):

| Field | What to enter |
|---|---|
| Promotional text, Description, Keywords | From the listing copy in OneDrive (`DevOps/Mellerick Plumbing/Apple/`) |
| Support URL | `https://mellerick-app.vercel.app/privacy` (it has the contact email), or mellerick.com's contact page |
| Marketing URL | Leave blank |
| Copyright | `2026 Mellerick Pty Ltd` |
| Build | **Add Build** → pick the build from Step 1 |
| App Review Information → Sign-in required | Tick it; enter the App Review email and password from Step 2 |
| App Review Information → Contact | Your name, phone and email |
| App Review Information → Notes | Paste the text below, with your video link |
| App Store Version Release | **Manually release this version** |

Notes for the reviewer (paste, then fill in the link):

> Mellerick Field is an internal tool for staff of Mellerick Pty Ltd, a
> plumbing business in Victoria, Australia. Accounts are created by our office;
> there is no sign-up. The demo account is a technician with one test job
> (#834). Location "Always" is used only to clock technicians on and off
> automatically when they arrive at or leave a job site, and to record travel
> time between sites, for payroll. It runs only for technicians with an open
> job, during working hours or while clocked on. An explanation screen is
> shown before the system prompt. Because the job site is in Australia, the
> automatic clock-on cannot be seen from your location; this video shows it:
> <VIDEO LINK>. Technicians can also clock on by hand on the job's Time tab.
> Microphone and speech recognition are used only to dictate job notes.
> Account deletion: Privacy policy and Delete account links are on the sign-in
> screen and in the app; deletion requests go to the office.

Then, in the left sidebar under **General**:

- **App Information**: Category **Business**; Content Rights: does not contain
  third-party content. Age Rating → **Edit** → answer **None / No** to every
  question → result 4+.
- **App Privacy** → Privacy Policy URL: `https://mellerick-app.vercel.app/privacy`.
  Data collection → **Yes**, then tick, each as **linked to the user**, **not
  used for tracking**, purpose **App Functionality**:
  - Contact Info: **Name**, **Email Address**
  - Location: **Precise Location**
  - User Content: **Photos or Videos**, **Audio Data**, **Other User Content**
  - Identifiers: **User ID**
  - Diagnostics: **Crash Data**, **not linked** to the user (only if crash
    reporting / Sentry is switched on; otherwise leave Diagnostics out)

  Then **Publish**.
- **Pricing and Availability** → Price: **Free (0)**. The distribution choice
  on this page is Step 7 (Plan A) or stays Public (Plan B).

---

## Plan A: Custom app through Apple Business Manager

### Step 6: Enrol Mellerick in Apple Business Manager (free, allow 1–2 weeks)

1. Go to **business.apple.com** → **Enroll now**.
2. Organisation: **MELLERICK PTY LTD**, D-U-N-S **758246453**, address 405
   Doctors Gully Road, Nutfield VIC 3099 — exactly as Dun & Bradstreet has it.
   Website mellerick.com, business phone.
3. Verification contact: someone Apple can phone who can confirm you may sign
   up the business (you).
4. Your sign-in for Apple Business Manager must be an email that is **not**
   already an Apple ID, for example `abm@mellerick.com`. Apple creates a new
   managed account for it.
5. Apple phones or emails to verify. When approved you get an email; sign in at
   business.apple.com.

### Step 7: Find the Organisation ID and add it in App Store Connect

1. In **business.apple.com**: click your name (bottom left) → **Preferences**
   → **Enrollment Information**. Copy the **Organization ID** (a long number).
2. In **appstoreconnect.apple.com** → **Apps** → **Mellerick Field** →
   **Distribution** tab → **Pricing and Availability** (left sidebar).
3. Under **App Distribution Methods**, choose **Private**.
4. **Add Organization** → paste the Organization ID and type "Mellerick Pty
   Ltd" → **Add** → **Save**.

Read before you save: **this is permanent for this app.** A custom app can
never be made public later. That suits a staff-only app.

### Step 8: Submit for review

1. Back on the 1.0 version page → **Add for Review** → **Submit for Review**.
2. Review usually takes 1–3 days. If Apple asks a question, it appears in
   App Store Connect → **App Review** and by email; reply there.
3. When the status is **Pending Developer Release**, press **Release This
   Version**.

### Step 9: Give the app to staff

1. In **business.apple.com** → **Apps and Books** (left sidebar) → search
   **Mellerick Field** (it shows under **Custom Apps**).
2. Choose your location, **Licence type: Redeemable Codes**, quantity = number
   of staff plus a few spare (they are free) → **Get**.
3. After a few minutes, **Download** the codes (a spreadsheet). Each row is a
   link.
4. Send each person one link by text or email. They open it on their iPhone,
   sign in with their own Apple ID if asked, and the App Store installs
   Mellerick Field. Then they sign in with their Mellerick account as usual.
5. Their TestFlight copy is replaced by the App Store copy. Data waiting to
   sync is kept, but ask them to open the old app once on signal first so
   nothing is queued.

A used code cannot be taken back. When someone leaves, deactivate them on the
web Staff page; the app then refuses to sign them in.

### Updates afterwards

Each new build: run the GitHub workflow, then in App Store Connect create a
new version (**+** next to iOS App), pick the build, **Submit for Review**,
then release. Staff get it as a normal App Store update. TestFlight keeps
working alongside for testing.

---

## Plan B: Unlisted app (fallback)

Use this if Apple Business Manager enrolment stalls.

1. Do Steps 1–5. In **Pricing and Availability**, leave distribution on
   **Public**, and make sure the version is set to **Manually release this
   version** so it does not appear in search before Apple makes it unlisted.
2. **Submit for Review.**
3. Request unlisted distribution: **developer.apple.com** → **Contact Us** →
   search "unlisted" → **Unlisted App Distribution request**. App Apple ID:
   **6806677435**. Reason: internal app for our own employees; accounts are
   issued by the office.
4. When Apple confirms (by email) the app is unlisted, press **Release This
   Version** in App Store Connect.
5. Send staff the link `https://apps.apple.com/app/id6806677435`.

---

## What changes if you go custom after something was reviewed publicly

- **TestFlight builds do not count.** TestFlight review is separate; using
  TestFlight so far does not stop you choosing Private.
- **Never press "Release" on a Public version** if you still want Plan A.
  Once an app has been live on the public App Store it cannot become a custom
  app. The only way back would be a new app record with a new bundle ID, which
  staff would have to install as a separate app.
- **If a version was approved as Public but not released:** change
  distribution to Private (Step 7) and submit again. Expect a fresh review.
- **If you start Plan B and then want Plan A:** the same rule applies — while
  nothing has been released, switch to Private and resubmit; once released
  (even unlisted), stay on Plan B.

## If Apple rejects it

| Apple says | What to do |
|---|---|
| 2.1 "We could not sign in" / "no content" | Check the App Review account still works and #834 is open and assigned to it |
| 2.5.4 / 5.1.5 background location not justified | Reply with the video link and the notes text; point out the explanation screen |
| 3.2 "intended for a specific organisation" | That is a request to use Plan A or B, which you are |
| 5.1.1(v) account deletion | Reply: accounts are created by our office, there is no sign-up; Delete account link in the app explains how to ask |

## Who does what

| Step | Who |
|---|---|
| 1, build | Anyone with GitHub access |
| 2–5, App Store Connect content | Justin |
| 6–7, Apple Business Manager | Justin (the Account Holder on the Apple Developer account) |
| 8–9, submit, release, send codes | Justin |
| Reviewer-data restriction, if wanted | Developer |
