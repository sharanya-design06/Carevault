# Health-Care-DataWarehouse
## Shared data (team setup)

By default all data lives in each browser's localStorage/IndexedDB, so nothing one person creates is visible to teammates
(nothing is written to files, so Git is not involved; `.gitignore` only excludes `.firebase/`). To share data:

1. Enable Firestore and Cloud Storage in Firebase project `care-vault-project`.
2. Put `apiKey`, `storageBucket` and `enabled: true` in `public/assets/js/remote-config.js`.
3. `npx firebase-tools deploy --only firestore:rules,storage` (rules in `firestore.rules`/`storage.rules`).

Records are stored per collection in Firestore (`carevault/<collection>`), report PDFs in Storage (`reports/<id>`).
Concurrent saves merge by record id; other users' changes arrive within ~15 s or on tab focus. The bundled rules are
open (demo only): add Firebase Auth and tighten them before real patient data. Each Firestore doc is limited to 1 MB.

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

- Run locally: `npx firebase-tools emulators:start --only hosting` (or `npx serve public`)
- Deploy (Firebase project `care-vault-project`, set in `.firebaserc`): `npx firebase-tools login`, then `npx firebase-tools deploy --only hosting`
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

Pages: Login, Dashboard, Hospital list/register/details/manage, User Management,
Global Audit Logs (filter + CSV export), System Configuration, and the invitation
password-setup page (`#/setup-password?token=…`).

Hospital Admin console (`/hospital-admin/`): Dashboard, Hospital Profile (contact fields only), Staff list/search,
Create Staff Account (activation invitation; staff set their own password), Staff Details (edit, suspend,
reactivate, resend invite, force reset) and Hospital Audit Logs. All views are scoped to the admin's hospital.

PCC console (`/pcc/`): Dashboard, Register New Patient (generates a unique HRID, optional patient account
invitation when an email is given), Patient List/search, Patient Details (registration info only),
Create Doctor / Nurse / Lab Technician / Pharmacist accounts (password-setup invitation), Staff List and
Deactivate Staff. PCC cannot create PCC/admin accounts, cannot touch other roles, and cannot reactivate
(Hospital Admin only). The Hospital Admin can create PCC accounts. Audit events record the HRID, not patient names.

Doctor console (`/doctor/`): Dashboard, Patient Search (HRID, or date of birth + name/phone), patient workspace with
Overview (allergies, current medications, risk indicators, latest AI summaries), Medical History, Health Timeline
(hospital + author provenance), Reports (PDF + AI summary), Disease Risk dashboard, Diagnosis Entry, Prescription
with allergy/interaction/duplicate checks (serious alerts need an override reason), Emergency Access (category +
reason, 30-minute grant, audited at both hospitals) and Access History. Patients are reachable only at the doctor's
own hospital or during emergency access; other hospitals' records appear only if marked shared (otherwise a hidden-record
count is shown).

Lab console (`/lab/`): Dashboard, Patient Search (own hospital), Upload Medical Report (PDF only, validated, max 10 MB,
SHA-256 recorded), Report Details with upload provenance, Uploaded Reports (mine / hospital) and AI Processing Result.
PDFs are kept in browser IndexedDB in this demo.

Pharmacist console (`/pharmacist/`): Dashboard, Patient Search (own hospital), Medication List, Allergy Profile,
Add Prescription/Medication with allergy, interaction and duplicate checks, a CRITICAL/Warning alert before
finalizing (override reason required for critical alerts) and Prescription History.

Nurse console (`/nurse/`): Dashboard, Patient Search, Basic Information (name, age, emergency contact, allergies),
Record Vitals (temperature, pulse, BP, respiratory rate, SpO2, weight, pain; range-validated, abnormal values flagged)
and Vital History. Vitals are append-only: an update creates a new entry referencing the earlier one.

Patient portal (`/patient/`): Dashboard, My Profile (contact details only), My HRID, Medical History, Health Timeline,
Medical Reports with AI summaries, Prescription History, Allergies, Access History (staff who accessed the record),
Emergency Access History, Consent Management (cross-hospital sharing is enforced for clinicians; the emergency
notification preference is stored only), Account Settings and Change Password. Patients get an account when PCC
registers them with an email (invitation link) and sign in on the same login page.

Caveats: AI report summaries (simple value extraction from PDF text) and risk scores (transparent rule-based
screening estimate) are simulated demos, not clinical tools. All access checks run in the browser and must be
enforced by a trusted backend (Firebase Auth, Firestore rules, Cloud Functions/Storage) before production.

**Before production:** `public/assets/js/store.js` is a demo data layer. Replace it with
Firebase Auth (custom claim `role=systemAdmin`), Firestore with security rules, and a
Cloud Function to email invitations; client-side checks are not a security boundary.

## Security rules: what is and is not enforced here

Enforced in this demo: salted PBKDF2 password hashes (old hashes upgrade at next login), no plain-text passwords, 5-failure lockout, single-use time-limited invitation and reset tokens, role and hospital scope taken from the stored account, append-only clinical records with linked amendments, emergency access that needs a reason and is always audited, PDF validation on upload, output escaping against XSS, a strict CSP, HSTS and other security headers (Firebase Hosting serves HTTPS).

Not possible in a static site, so it must move to the backend (Django/Firebase Auth + Firestore rules or Cloud Functions): server-side authentication and authorization, CSRF protection and secure server sessions/JWTs, SQL-injection prevention, database indexes on HRID, real email delivery, and tamper-proof audit storage. All data here sits in the browser's localStorage, so anyone with browser access can alter it.
