# Health-Care-DataWarehouse
## Isolated rules testing

`npm run test:rules` starts the Authentication, Firestore and Storage emulators on localhost for the
`demo-carevault-isolated` project, using the repository rules.
The tests use only synthetic data and require Java. They do not deploy anything.
They verify that every Firestore collection and Storage path denies direct client access, including the
legacy `/carevault` documents and `/reports` files that the old demo used.
Install dependencies in both the repository root and `functions/` before running
the tests (`npm install` in each directory).

The existing application still points at the configured live Firebase project;
the emulator command does not reconfigure Hosting or the application. Do not use
the current dashboard or repository rules for real patient data.

`functions/dashboard-identity.js` validates callable-verified Firebase claims
against the trusted `dashboardUsers/{uid}` record and rejects inactive or
inconsistent roles. Dashboard provisioning, patient registration, care
assignment, clinical records, patient notifications, and role-specific
Firebase-backed screens are implemented and covered by `npm run test:dashboard`.
Username-to-email lookups are limited to 10 requests per client IP per fixed
minute. Counters use a hashed IP key and expire through the Firestore TTL policy.
Reasoned cross-hospital access grants expire after 24 hours and notify the
patient in the dashboard and by email when an address is available; email
failure is logged and does not cancel the grant.
New clinical records are marked sensitive. Authorized reads of sensitive
records create a metadata-only audit entry under the patient's hospital;
PCCs, hospital admins, doctors, nurses, lab staff, and pharmacists can view
their own hospital's latest 100 entries. Cross-hospital reads are attributed
to the owning hospital, with the viewer hospital recorded; the audit view
excludes record contents.
The secure-report workspace can authorize dashboard identities through the
shared dashboard records, and cross-hospital access emails use the configured
SMTP secrets; failed delivery is logged without canceling a grant.

The Firebase-backed dashboards remain feature-gated: `firebaseLogin` is not
enabled in `public/assets/js/remote-config.js`. This keeps the legacy synthetic
demo available while migration and final browser verification continue. The
dashboard and secure-report functions have not been deployed; patient OTP is deferred.

### Staff two-step verification (TOTP)

`care-vault-project` is on Identity Platform with TOTP (authenticator app) MFA enabled; SMS MFA is not used.
The login page prompts for a code after the password for accounts that have enrolled, and walks staff with no
second factor through enrolment (the account's email must be verified; the invitation link does this).
The client calls the Identity Toolkit **v2** MFA endpoints (`/v2/accounts/mfaEnrollment:*`, `mfaSignIn:finalize`).
Enforcement is server-side: with `REQUIRE_STAFF_MFA=true` every callable except `getDashboardIdentity` rejects staff
(not patients) whose ID token lacks `sign_in_second_factor`. It is on for `care-vault-project` through the committed,
non-secret `functions/.env.care-vault-project`, so staff must enrol at their next sign-in; if an enrolment goes wrong,
an owner can remove the factor with the Admin SDK. The Auth emulator does not support TOTP, so the real flow can only be
checked against a live project with synthetic users.

### Patient one-time code sign-in

`#/otp` on the login page lets a patient sign in with a 6-digit code instead of a password. `requestPatientOtp` finds the
account by registered email, or by a phone number that matches exactly one patient with a login, and emails the code;
`verifyPatientOtp` checks it and returns a Firebase custom token for a PATIENT account only (staff never match). Codes
last 5 minutes, work once, allow 5 wrong guesses, have a 30-second resend cooldown and a per-IP throttle, are stored
only as a salted hash (`dashboardOtp`, expired by TTL), and the responses never reveal whether an account exists.
**The SMS gateway is a stub** (`smsGatewayStub` in `functions/dashboard-otp.js` logs a masked number and sends nothing);
delivery today is email. Custom tokens are signed by the Functions runtime service account, which needs
`roles/iam.serviceAccountTokenCreator` on itself (granted on `care-vault-project`).

### Session security

The client refreshes the ID token five minutes before expiry (`securetoken.googleapis.com`), signs a tab out after 15
idle minutes (staff) or 30 (patients), and signing out calls `revokeMySessions`, which revokes the refresh tokens and
sets `sessionsValidAfter` on the account so older ID tokens are refused at once, not at their hourly expiry. The server
also rejects sign-ins older than 12 hours (staff) or 24 hours (patients), measured from `auth_time`. Each sign-in sends
a random per-browser id; only its hash is stored in `dashboardDevices`, and the first sign-in from a new browser writes a
`new_device_sign_in` audit entry. The refresh token lives in `sessionStorage` for the tab.

### Billing clearance

The PCC dashboard's **Billing Clearance** tab (`listOpenEncounters`, `markEncounterBillingCleared`) lists the hospital's
open encounters with their discharge-signed and billing-cleared state. It is a placeholder for the billing module: it
records that an account is settled, not amounts. The encounter locks when both conditions are met, in either order.
The legacy public Firestore collection and Storage paths are closed: `firestore.rules` and `storage.rules`
deny all client access (deployed), so the old shared-demo sync no longer works and the demo runs from
browser storage only.
The emulator-only `.env.demo-carevault-isolated` file contains non-working
placeholders for the unrelated experimental AI service; do not use it as
configuration for a real deployment.

### Phase 1 backend additions

All of these run in Cloud Functions with the Admin SDK; clients have no direct database access.

- **Invitations** (`functions/dashboard-invitations.js`): `sendDashboardInvite` stores only a SHA-256 of a random token in
  `dashboardInvitations` (`expiresAt` 5 minutes after sending, `used` flag). `checkDashboardInvite` and
  `completeDashboardInvite` back `public/set-password/`; completion consumes the token transactionally before the
  password is set, so a link works once. A newer invitation supersedes older ones. The password passes through the
  function over TLS to the Admin SDK and is never stored or logged. Forgot Password still uses Firebase reset links.
  System Admins can resend a Firebase setup email for an active Hospital Admin from the Hospitals page. A failed
  delivery leaves the resend control available; resolve SMTP configuration before retrying. Legacy demo invitations
  do not provision Firebase accounts and cannot be used for Firebase sign-in.
  If a hospital is created but its first administrator cannot be created, the registration page keeps an
  administrator form for that hospital so the System Admin can retry without registering the hospital again.
- **Lookup and encounters** (`dashboard-lookup.js`): `findDashboardPatient` by HRID, QR payload, phone, ABHA number,
  hospital patient ID, or name + date of birth + gender, limited to the caller's hospital and audited by method only.
  `openDashboardEncounter` starts a new visit; clinical records and notes attach to the patient's open encounter.
  Patients registered before these fields existed have no lookup keys.
- **Notes** (`dashboard-notes.js`): drafts, versions (`dashboardNotes/{id}/versions`), signing, dated addenda
  (`addenda`), sub-type rules (operative: SURGEON, anesthesia: ANESTHETIST). An encounter closes and locks when a
  discharge summary is signed and billing is cleared; `markEncounterBillingCleared` is a PCC placeholder until the billing module exists.
- **Triage** (`dashboard-triage.js`): the server calculates BMI (WHO or Asia-Pacific cut-offs per hospital
  `bmiPolicy`); for patients under 18 the BMI is stored without a category because the BMI-for-age percentile tables are not
  included. Triage sets the encounter's queue priority; worklists sort by priority, Priority Care, then waiting time.
  The Priority Care reasons are visible only to the treating doctor and nurse.
- **Duplicates** (`dashboard-duplicates.js`, `dashboard-duplicate-detection.js`): a rule-based `rules-v1` scorer suggests
  matches within the same hospital at registration. A PCC rejects or merges; a merge retires the secondary record and
  links it to the primary, whose history reads through to both. No record is moved or rewritten.
- **Audit integrity** (`audit-guard.js`, `audit-anchor.js`): each `dashboardAudit` entry (not the separate `secureReportAudit`) is anchored in `auditAnchors` and logged with
  `auditMirror: true`. Edits and deletions are reversed and logged as `auditTamper: true`. `care-vault-project` routes both
  to the `carevault-audit` Cloud Logging bucket (asia-south1, 30-day retention) through the `carevault-audit-sink` sink
  (filter `jsonPayload.auditMirror=true OR jsonPayload.auditTamper=true`). The retention is **not locked**, so project
  owners could still shorten or delete the bucket. Locking is irreversible and is left to the owner:
  `gcloud logging buckets update carevault-audit --location=asia-south1 --locked --project=care-vault-project`
  (consider a longer `--retention-days` first, since a locked period cannot be shortened).

### Dashboard test commands

- `npm test`: unit tests.
- `npm run test:rules` and `npm run test:dashboard`: Firestore/Storage rules and dashboard callables on the
  emulators (`firebase.emulator.dashboard.json`, ports 19099/18080/19199/15001).
- `npm run test:e2e`: secure-report pipeline on the emulators (`firebase.emulator.json`).
- `npm run test:smoke`: runs `scripts/live-smoke.js` against the emulators.
- Live check with synthetic accounts only:
  `SYNTH_PASSWORD='<new strong password>' GOOGLE_APPLICATION_CREDENTIALS=<service-account JSON outside the repo> node scripts/live-smoke.js`.
  It creates a throwaway hospital pair and users in `care-vault-project`, calls the deployed callables over HTTPS and
  deletes what it created (`--keep` leaves the data). Never commit the key file or the password.
- Deploy dashboard callables selectively (`--only functions:<name>,...`). A bare `deploy --only functions` would try to
  delete live functions that are not in this repository (`manageAdminDeactivation`, `processSecureReportSummary`).

### Firebase login migration (test only)

When `firebaseLogin: true` is explicitly configured, the main login uses
Firebase email/password authentication and calls `getDashboardIdentity` before
routing to a role dashboard. The server requires matching active dashboard
records and custom claims; merely creating a Firebase Auth user is not enough.
The Firebase session is separate from the legacy demo session. It expires at
the ID token expiry (there is no automatic refresh), and sign-out clears the
local session but does not revoke a copied token. Password resets use Firebase's
email reset flow and its configured email action handler; the old demo reset
and mailbox links are unavailable in Firebase mode.

Do not enable the flag against the live project just to try this. A separate
test project needs its own web configuration, deployed dashboard functions,
trusted role provisioning and appropriate Hosting/CSP configuration. Some
existing report endpoints and invitation links still reference the live
project; review these before testing those features against another project.
The secure patient dashboard does not yet expose the embedded AI section.
This change has unit tests but has not been validated with a real test-project
browser sign-in or email delivery. `npm run test:dashboard` also exercises the
login and password reset against local Auth, Firestore and Functions emulators
with fictional accounts; no actual email is sent. Existing demo data and its
public access remain unchanged; use synthetic data only.

## Shared data (team setup)

By default all data lives in each browser's localStorage/IndexedDB, so nothing one person creates is visible to teammates
(nothing is written to files, so Git is not involved; `.gitignore` only excludes `.firebase/`). To share data:

1. Enable Firestore and Cloud Storage in Firebase project `care-vault-project`.
2. Put `apiKey`, `storageBucket` and `enabled: true` in `public/assets/js/remote-config.js`.
3. `npx firebase-tools deploy --only firestore:rules,storage` (rules in `firestore.rules`/`storage.rules`).

Records are stored per collection in Firestore (`carevault/<collection>`), report PDFs in Storage (`reports/<id>`).
Concurrent saves merge by record id; other users' changes arrive within ~15 s or on tab focus. The bundled rules are
closed to all clients since the dashboard migration, so this shared-sync mode no longer works against the live project.

## System Admin console

Static app in `public/` (no build step), ready for Firebase Hosting.

```
public/
  index.html            common login + invitation password-setup (#/setup-password?token=…)
  assets/               shared: css/styles.css, js/store.js (data layer), js/common.js, js/auth.js
  system-admin/         System Admin console  (/system-admin/)
  hospital-admin/       Hospital Admin console (/hospital-admin/)
  pcc/                  Patient Care Coordinator console (/pcc/)
  doctor/               Doctor console (/doctor/)
  lab/                  Lab Technician console (/lab/)
  pharmacist/           Pharmacist console (/pharmacist/)
  nurse/                Nurse console (/nurse/)
  patient/              Patient portal (/patient/)
```

After login the user is sent to their own folder; each console redirects back to the login page if the
session is missing or has the wrong role.

- Email invitations and password resets are sent by the `sendInvite` Cloud Function. Before deploying,
  configure the `SMTP_USER` and `SMTP_PASS` Firebase Functions secrets (the Gmail sender address and its
  app password), then deploy the function:

  ```
  npx firebase-tools functions:secrets:set SMTP_USER --project care-vault-project
  npx firebase-tools functions:secrets:set SMTP_PASS --project care-vault-project
  npx firebase-tools deploy --only functions --project care-vault-project
  ```

- Invitation delivery requires shared Firestore storage and the deployed Hosting `/api/sendInvite` rewrite.
  The account-creation screen waits for the email service to accept the message and reports delivery errors;
  if shared storage is unavailable, the locally created link may not work on another device. For email
  failures, check the `sendInvite` function logs, the Gmail app password and the recipient's spam folder.
  Deploy both Hosting and Functions after changing the invitation flow.
- Run locally: `npx firebase-tools emulators:start --only hosting` (or `npx serve public`)
- Deploy the latest UI (Firebase project `care-vault-project`, set in `.firebaserc`): `npx firebase-tools login`, then `npx firebase-tools deploy --only hosting --project care-vault-project`. This publishes the System Admin action buttons to Hosting.
- Demo logins (one shared login page, role decides the console; data lives in browser localStorage):
  - System Admin: `sysadmin@carevault.com` / `Admin@123`
  - Hospital Admin: `admin@stmary.example` / `Hospital@123`
  - PCC: `pcc@stmary.example` / `Hospital@123`
  - Doctor: `jwu@stmary.example` / `Hospital@123`
  - Lab Technician: `lab@stmary.example` / `Hospital@123`
  - Pharmacist: `pharm@stmary.example` / `Hospital@123`
  - Nurse: `npatel@stmary.example` / `Hospital@123`
  - Patient: `anna.rivera@example.com` / `Hospital@123` (HRID shown on her My HRID page, format `HDW-YYYYMMDD-XXXXXXXX`)
  - Sign in with a username or an email. Usernames: `sysadmin`, `smgh.admin`, `pcc`, `jwu`, `lab`, `pharm`, `npatel`, `anna.rivera`.
  - Forgot password: username + registered email gives a 30-minute single-use link. The demo has no email service, so the link appears on the "demo mailbox" page (`/#/outbox`).
  - Records are append-only. Doctors correct a record by adding a linked amendment on the History tab; the original stays unchanged.

Pages: Login, Dashboard, Hospital list/register/details/manage, System Admin management
(additional admins receive password-setup invitations; deactivation requires majority
approval from the other active admins), User Management,
Global Audit Logs (filter + CSV export), System Configuration, and the invitation
password-setup page (`#/setup-password?token=…`).

System Admin deactivation requests and votes use the app's shared data store. With shared
Firestore enabled, changes sync between browsers; otherwise they remain local to the current
browser. This is demo behavior, not a secure production authorization mechanism: the bundled
Firestore rules now deny all client access, so this sync is unavailable. Configure authenticated server-side authorization
before using this feature for real accounts.

Hospital Admin console (`/hospital-admin/`): Dashboard, Hospital Profile (contact fields only), Staff list/search,
Create Staff Account (activation invitation; staff set their own password), Staff Details (edit, suspend,
reactivate, resend invite, force reset) and Hospital Audit Logs. All views are scoped to the admin's hospital.

PCC console (`/pcc/`): Dashboard, Register New Patient (generates a unique HRID, optional patient account
invitation when an email is given), Patient List/search, Patient Details (registration info only),
Create Doctor / Nurse / Lab Technician / Pharmacist accounts (password-setup invitation), Staff List and
Deactivate Staff. PCC cannot create PCC/admin accounts, cannot touch other roles, and cannot reactivate
(Hospital Admin only). The Hospital Admin can create PCC accounts. Audit events record the HRID, not patient names.

Doctor console (`/doctor/`): Dashboard, Patient Search (HRID, or date of birth + name/phone), patient workspace with
Overview (allergies, current medications, risk indicators, latest report extracts), Medical History, Health Timeline
(hospital + author provenance), Reports (PDF + extract), Disease Risk dashboard, Diagnosis Entry, Prescription
with allergy/interaction/duplicate checks (serious alerts need an override reason), Emergency Access (category +
reason, 30-minute grant, audited at both hospitals) and Access History. Patients are reachable only at the doctor's
own hospital or during emergency access; other hospitals' records appear only if marked shared (otherwise a hidden-record
count is shown).

Lab console (`/lab/`): Dashboard, Patient Search (own hospital), Upload Medical Report (PDF only, validated, max 10 MB,
SHA-256 recorded), Report Details with upload provenance, Uploaded Reports (mine / hospital) and report extraction.
PDFs are kept in browser IndexedDB in this demo.

Pharmacist console (`/pharmacist/`): Dashboard, Patient Search (own hospital), Medication List, Allergy Profile,
Add Prescription/Medication with allergy, interaction and duplicate checks, a CRITICAL/Warning alert before
finalizing (override reason required for critical alerts) and Prescription History.

Nurse console (`/nurse/`): Dashboard, Patient Search, Basic Information (name, age, emergency contact, allergies),
Record Vitals (temperature, pulse, BP, respiratory rate, SpO2, weight, pain; range-validated, abnormal values flagged)
and Vital History. Vitals are append-only: an update creates a new entry referencing the earlier one.

Patient portal (`/patient/`): Dashboard, My Profile (contact details only), My HRID, Medical History, Health Timeline,
Medical Reports, Prescription History, Allergies, Access History (staff who accessed the record),
Emergency Access History, Consent Management (cross-hospital sharing is enforced for clinicians; the emergency
notification preference is stored only), Account Settings and Change Password. Patients get an account when PCC
registers them with an email (invitation link) and sign in on the same login page.

Caveats: Report extracts and risk scores (transparent rule-based screening estimate) are simulated demos,
not clinical tools. Report processing uses PDF.js locally in the browser to extract selected passages, with
page numbers, from selectable text including compressed PDFs. Each page without selectable text or containing
an image is also processed with locally bundled English OCR, including mixed text/image pages. Pages with no
readable text or with no OCR text are flagged for manual review. Reports over 100 pages are rejected rather
than silently truncated; split them into smaller PDFs. The preview displays at most 12 excerpts. Documents
containing the repository's explicit synthetic-fixture marker receive a citation-preserving extractive summary,
including structured lab values when a result, reference and flag are present. This is a deterministic software
demo, not a generative or clinically validated model, and no diagnosis is inferred. Other documents retain the
limited extract-only preview. OCR can misread numbers and units, and processing may omit or misorder content.
Always review the original PDF with a clinician. Invalid or password-protected PDFs fail processing;
lab users can use **Reprocess report** on the report details page, including for previously uploaded reports.
Reprocessing requires access to the stored PDF; locally stored files are only available in their original browser.
Processing runs in the uploading browser, not in Cloud Functions, and can be interrupted when the page closes.
Report summaries are withheld from the patient interface until clinician approval can be enforced by a trusted
backend. This legacy browser pipeline is not a security boundary.
Do not use real patient data. The separate experimental workspace described below is not production-ready.
The `extractReportPages` interface streams all extracted lines, labelled with page and source, to a caller;
the demo persists only the limited preview, not the full model input. No AI model is connected to this demo.
The separate secure-report workspace has an experimental private-model path, but it is not clinically validated.

### Secure report summaries (experimental, synthetic data only)

The secure-report pipeline lives in `functions/` and is deployed to `care-vault-project` (region `asia-south1`).
It is separate from the browser-only demo above and from the unfinished dashboard migration. Do not use real
patient data: it is not clinically validated, does not enforce MFA, has no malware scanning or monitoring, and the public demo
data and rules around it remain unsafe.

**Flow.** A lab technician or doctor uploads a PDF (max 10 MiB) → the `processSecureReport` Firestore trigger
extracts every page (max 100) with PDF.js and English OCR where needed and stores each page under
`secure-reports/extractions/{reportId}/{jobId}/{page}.json` → a doctor requests a summary
(`requestSecureReportSummary`) → the doctor reviews it against the cited lines and the original PDF and approves
or rejects that exact version (`reviewSecureReportSummary`) → the patient can read only an approved summary
(`getSecureReportSummary`). Other callables: `getSecureReportIdentity`, `getSecureReportStatus`,
`retrySecureReport`, `getSecureReportPage`, `getSecureReportOriginal`, `getSecureReportAiStatus`,
`getSecureReportAiConsent`, `setSecureReportAiConsent`.

**The summarizer is not a generative model.** `functions/report-summarizer.js` is a deterministic extractive
engine (`carevault-extractive`). Every statement is built only from text in the cited extracted lines (lab
results become "X is N unit (reference R), flagged F"; narrative findings are kept verbatim; dated entry runs are
grouped with every line cited; missing results are reported as gaps). It never infers a diagnosis or
reassurance. Each statement carries `{page, line, source: pdf|ocr, start, end}` UTF-16 citations. Input over
200,000 characters, no readable text, or more than 100 statements fails with no partial draft.

**Source verification.** `functions/summary-verification.js` re-reads the cited pages and flags missing or
invalid citations, numbers, units or dates that are not in the cited text, source numbers omitted from a
statement, and all OCR citations. Issues other than `ocr-source` block approval. A digest of the cited page
bytes is stored with the summary; any later change to the extraction invalidates the draft and any approval.
These are lexical checks, not clinical validation: **every statement still needs manual comparison with the
original report.**

**Access control (Admin SDK only; clients cannot write these documents).**

- `secureReportUsers/{authUid}`: `status: 'active'`, `role` (`doctor`, `lab` or `patient`), and `hospitalId` (staff)
  or `patientId` (patient).
- `secureReportPatients/{patientId}`: `status`, `authUid`, `shareWithOtherHospitals`, `aiProcessingConsent`.
- `secureReportCare/{staffUid}/patients/{patientId}`: `status: 'active'` and the staff `hospitalId`.

Staff need an active care relationship; reports from another hospital also need `shareWithOtherHospitals`. Only
doctors can generate or review summaries, and only while the patient's separate `aiProcessingConsent` is true.
Consent is rechecked on every summary read and again when a draft is committed; withdrawing it immediately blocks
doctors and the patient. Regenerating a summary clears any earlier review. Every read, generation and review writes
a `secureReportAudit` record (IDs, action, version, digest, counts; never report text). Categorized `incorrect`
and `not-useful` rejections also write `secureReportFeedback` (do not enter patient details in comments).
These dashboard-independent accounts do not use the `dashboardUsers` records.

**Synthetic accounts.** `scripts/provision-secure-report.js` (idempotent) creates a doctor, lab technician and
patient with a password you supply:

```
SECURE_REPORT_DEMO_PASSWORD='<new strong password>' GOOGLE_APPLICATION_CREDENTIALS=<credentials file> \
  node scripts/provision-secure-report.js care-vault-project
```

Defaults: `synthetic.doctor@`, `synthetic.lab@`, `synthetic.patient@carevault.example`, patient ID
`synthetic-patient-001`, hospital `synthetic-hospital-1`. The patient starts with AI consent off. Sign-in requires
Email/Password authentication to be enabled for the project.

**UI.** `public/secure-reports/` (script `public/assets/js/secure-reports.js`) signs in with the project API key and
calls the regional functions directly; it renders all text with `textContent`. The new page is live at
`/secure-reports/` and replaced the earlier page (its old `app.js` and `styles.css` were removed from Hosting).
It was published by rebuilding the exact live file set and changing only this page, so unreleased dashboard
work in `public/` was not deployed. The `/api/secureReport*` rewrites in `firebase.json` are no longer needed
by the page.

**Inside the Doctor and Patient dashboards (no second sign-in).** The dashboards' **AI Report Review** and
**AI Summaries** tabs embed `/secure-reports/?embed=doctor|patient`. The dashboard login is still the demo login,
which a server cannot trust, so at login `auth.js` also signs the same email and password into Firebase Auth
and keeps the ID token in `sessionStorage` (`carevault.secure-report-session.v1`). The embedded page uses that
token only if the dashboard session is active, its role matches the frame, and the token's email equals the
dashboard account's email; otherwise it shows a message and never a login form. The dashboard login is unaffected
when there is no matching Firebase account. Limits: the Firebase account must use the **same password** as the
dashboard account; the ID token lasts about an hour and is not refreshed (sign out and in again); the token is
readable by scripts on the same origin, like the existing Firebase dashboard session; and the link is cleared when
the login page is shown. An account also needs a secure-report access record, which an administrator adds with
`linkSecureReportAccount` in `scripts/provision-secure-report.js` (it never touches the password; staff need an
active care record for each patient's HRID, and patients start with AI consent off). A patient needs the report
ID from their clinician to open a summary. Linked in the live project for testing: patient Rekha Joshi
(`HDW-20261106-JSZE4X3N`) and doctor `nova.arvind.fhdts@gmail.com`, both at `hos_y6242s0cy5n6`.

**Synthetic fixtures.** `synthetic-reports/` holds seven fictional PDFs (laboratory, CT, discharge summary, MRI,
medication reconciliation, pathology, and a two-page long report). The long report is summarized completely as
two grouped timeline statements citing all 22 lines; it no longer tests a rejection limit.

**Tests.** `npm test` runs the unit tests, including `tests/report-summarizer.test.js` (all seven fixtures,
verification and tamper detection) and `tests/secure-report-ui.test.js`. `npm run test:e2e` runs
`tests/emulator-secure-reports/` against the Auth, Firestore, Storage and Functions emulators (needs Java). In this
environment the emulators were intermittently terminated by `SIGTERM` after about 20 seconds for an unidentified
reason; the first three emulator scenarios passed when the file was run directly, so rerun them on another machine
or in CI. The deployed functions were also smoke-tested live with synthetic accounts (sign-in, upload, extraction
trigger, consent gating, summary generation, approval, patient release, consent withdrawal).

**Deployment.** Deploy only the secure-report functions to avoid touching other functions:

```
npx firebase deploy --only functions:getSecureReportIdentity,functions:uploadSecureReport,functions:getSecureReportStatus,functions:retrySecureReport,functions:getSecureReportPage,functions:getSecureReportOriginal,functions:processSecureReport,functions:requestSecureReportSummary,functions:getSecureReportAiStatus,functions:getSecureReportSummary,functions:reviewSecureReportSummary,functions:getSecureReportAiConsent,functions:setSecureReportAiConsent --project care-vault-project
```

Originals and extractions are in the default Storage bucket under deny-all rules (Admin SDK only); do not deploy
the demo `storage.rules` as a replacement for production. Failed uploads or jobs can leave orphaned objects, so a
retention/cleanup policy is still required. The earlier model-based design deployed a Cloud Run inference service
and IAM bindings to this project; that service is not used by the current code and should be reviewed and removed.

PDF.js and English Tesseract OCR are bundled under `public/assets/vendor` for self-hosted use. To update them
after changing their pinned versions, run `npm install`, `npm run vendor:pdfjs` and `npm run vendor:ocr`,
then deploy Hosting, including its OCR-compatible Content Security Policy.
Run the automated tests with `npm test`.

**Before production:** `public/assets/js/store.js` is a demo data layer. Replace it with
Firebase Auth (custom claim `role=systemAdmin`), Firestore with security rules, and a
Cloud Function to email invitations; client-side checks are not a security boundary.

## Security rules: what is and is not enforced here

Enforced in this demo: salted PBKDF2 password hashes (old hashes upgrade at next login), no plain-text passwords, 5-failure lockout, single-use time-limited invitation and reset tokens, role and hospital scope taken from the stored account, append-only clinical records with linked amendments, emergency access that needs a reason and is always audited, PDF validation on upload, output escaping against XSS, a strict CSP, HSTS and other security headers (Firebase Hosting serves HTTPS).

Not possible in a static site, so it must move to the backend (Django/Firebase Auth + Firestore rules or Cloud Functions): server-side authentication and authorization, CSRF protection and secure server sessions/JWTs, SQL-injection prevention, database indexes on HRID, real email delivery, and tamper-proof audit storage. All data here sits in the browser's localStorage, so anyone with browser access can alter it.
