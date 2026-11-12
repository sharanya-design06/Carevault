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

- Prepare local AI assets once after cloning: `npm ci` then `npm run prepare:ai-assets`.
- Run locally: `npx firebase-tools emulators:start --only hosting` (or `npx serve public`). Firebase Hosting
  also prepares the assets automatically before deployment; install root dependencies with `npm ci` first.
- The optional local Python AI service and model setup are documented below.
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
(hospital + author provenance), Reports (PDF + AI summary), Disease Risk dashboard (transparent screening indicators
and optional local research-model assessment), Diagnosis Entry, Prescription
with allergy/interaction/duplicate checks (serious alerts need an override reason), Emergency Access (category +
reason, 30-minute grant, audited at both hospitals) and Access History. Patients are reachable only at the doctor's
own hospital or during emergency access; other hospitals' records appear only if marked shared (otherwise a hidden-record
count is shown).

Lab console (`/lab/`): Dashboard, Patient Search (own hospital), Upload Medical Report (PDF only, validated, max 10 MB,
SHA-256 recorded), Report Details with upload provenance, Uploaded Reports (mine / hospital) and AI Processing Result.
PDFs use the configured Firebase Storage when remote storage is enabled; otherwise they are kept in browser IndexedDB.

Pharmacist console (`/pharmacist/`): Dashboard, Patient Search (own hospital), Medication List, Allergy Profile,
Add Prescription/Medication with allergy, interaction and duplicate checks, a CRITICAL/Warning alert before
finalizing (override reason required for critical alerts) and Prescription History.

Nurse console (`/nurse/`): Dashboard, Patient Search, Basic Information (name, age, emergency contact, allergies),
Record Vitals (temperature, pulse, BP, respiratory rate, SpO2, weight, pain; range-validated, abnormal values flagged)
and Vital History. Vitals are append-only: an update creates a new entry referencing the earlier one.

Patient portal (`/patient/`): Dashboard, My Profile (contact details only), My HRID, Medical History, Health Timeline,
Medical Reports with automated summaries, Prescription History, Allergies, Access History (staff who accessed the record),
Emergency Access History, Consent Management (cross-hospital sharing is enforced for clinicians; the emergency
notification preference is stored only), Account Settings and Change Password. Patients get an account when PCC
registers them with an email (invitation link) and sign in on the same login page.

AI caveats: report summaries extract selectable PDF text and common lab values. The optional extractive TF-IDF
summarizer is fit on the repository's `mtsamples.csv` transcriptions; its `description` field is only a weak
reference for held-out ROUGE evaluation, not a clinician-reviewed summary. It does not interpret scans and is not
fine-tuned BioBERT/T5. Drug checks are a rule-based lookup using the bundled interaction dataset plus a few
severity-labelled examples; dataset provenance/licensing is unverified, most source rows have no severity, coverage
is incomplete, and no alert does not mean a combination is safe. The training pipeline compares Logistic Regression,
Random Forest, XGBoost and SVM on the repository's diabetes, heart and liver datasets, uses a stratified holdout and
nested training-only cross-validation, and reports precision, recall, F1, ROC-AUC and average precision. It treats documented
zero-valued Pima measurements as missing and maps the liver dataset's 1/2 label explicitly. Thresholds favor precision
subject to a minimum training-fold recall; holdout results are estimates from small datasets, not guaranteed
performance. The diabetes benchmark contains only women aged 21 or older; the cardiac cohort is small and historic,
and the liver data comes from an Indian cohort. Dataset provenance/fitness needs review; models are not clinically
validated or calibrated, no
hypertension model is provided, and a score is not a diagnosis. The transparent rule-based indicators remain separate
and are not model predictions. The synopsis's licensed DrugBank, Indiana Radiology reports/reference summaries, and
clinical validation data are not present. All features are prototypes, not clinical tools, and require clinician review.
Do not send real patient data to this service. The app's existing shared Firestore/Storage features can sync data
(including uploaded PDFs) to Firebase when enabled. All access checks run in the browser and must be enforced by a
trusted backend (Firebase Auth,
Firestore rules, Cloud Functions/Storage) before production.

Latest local benchmark run (fixed stratified 20% holdout; selected threshold and model chosen using training data only):

| Dataset/task | Selected model | Holdout accuracy | Precision | Recall | F1 | ROC-AUC |
|---|---|---:|---:|---:|---:|---:|
| Diabetes (154 test rows) | Logistic Regression | 0.7273 | 0.6579 | 0.4630 | 0.5435 | 0.8126 |
| Heart disease (61 test rows) | Logistic Regression | 0.7705 | 0.8800 | 0.6667 | 0.7586 | 0.8712 |
| Liver disease (117 test rows) | XGBoost | 0.6496 | 0.9038 | 0.5663 | 0.6963 | 0.7743 |
| Report summaries (974 grouped test examples) | TF-IDF extractive | — | — | — | ROUGE-1: 0.2908; ROUGE-2: 0.2202; ROUGE-L: 0.2657 | — |

These are reproducible prototype baselines, not evidence of high or clinically safe accuracy. In particular, diabetes
holdout precision is only 0.6579 and its recall is 0.4630; the summary scores are modest and use dataset descriptions
as weak references. The holdout samples are small and from the same source datasets, so real-world performance may be
lower. Drug-interaction data has no reliable labeled severity/ground-truth set here, so accuracy/precision cannot be
validly measured. Do not use any of these results to make care decisions.

## Optional local Python AI prototype

The Python service is intended only for local development. It serves the static app and its `/api/ai/` endpoints from
the same loopback origin so report uploads, drug checks, and the doctor research-model form can use it without sending
requests to a third-party AI provider. The static/Firebase-hosted app continues to use its browser fallbacks when the
local service is not running. Disease model artifacts are generated locally and are not committed.

From the repository root in PowerShell:

```powershell
python -m venv ai_service\.venv
.\ai_service\.venv\Scripts\Activate.ps1
python -m pip install -r ai_service\requirements.txt
python -m unittest discover -s ai_service\tests
python -m ai_service.train_models
python -m ai_service.train_summarizer
python -m uvicorn ai_service.app:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000` and sign in to use the app. Check service/model status at
`http://127.0.0.1:8000/api/ai/health` and endpoint schemas at `/docs`. Run training again after changing a dataset or
training code. The doctor assessment form requires all listed features, prefills only values available in the record,
and sends only those feature values (not the patient ID) to the loopback service. Training writes holdout metrics to
`ai_service\models\training-report.json`; summarizer training writes ROUGE evaluation to
`ai_service\models\summarizer-report.json`. Artifacts are intentionally ignored by Git and must be regenerated locally.

This local setup has no Firebase Auth verification, patient authorization, production privacy controls, or clinical
validation. Do not expose it on a network or deploy it for real health data. A production integration needs a trusted
authenticated backend, reviewed/licensed data, clinical governance, and independent validation. A model trained on
the included small benchmark datasets is not a substitute for those requirements.

**Before production:** `public/assets/js/store.js` is a demo data layer. Replace it with
Firebase Auth (custom claim `role=systemAdmin`), Firestore with security rules, and a
Cloud Function to email invitations; client-side checks are not a security boundary.

## Security rules: what is and is not enforced here

Enforced in this demo: salted PBKDF2 password hashes (old hashes upgrade at next login), no plain-text passwords, 5-failure lockout, single-use time-limited invitation and reset tokens, role and hospital scope taken from the stored account, append-only clinical records with linked amendments, emergency access that needs a reason and is always audited, PDF validation on upload, output escaping against XSS, a strict CSP, HSTS and other security headers (Firebase Hosting serves HTTPS).

Not possible in a static site, so it must move to the backend (Django/Firebase Auth + Firestore rules or Cloud Functions): server-side authentication and authorization, CSRF protection and secure server sessions/JWTs, SQL-injection prevention, database indexes on HRID, real email delivery, and tamper-proof audit storage. All data here sits in the browser's localStorage, so anyone with browser access can alter it.
