# 🚀 Deployment Guide - Health Report Feature

## Current Status

✅ **Code:** Complete and committed to Git  
⏳ **Firebase Auth:** Requires login  
📋 **Ready to Deploy:** Yes

---

## 🔐 Step 1: Authenticate with Firebase

### Option A: Interactive Login (Recommended)
```bash
cd C:\Users\shwet\Downloads\Carevault
firebase login
```

**What happens:**
1. Browser opens automatically
2. Sign in with your Google account (use the account that owns care-vault-project)
3. Authorize Firebase CLI
4. Browser confirms success
5. CLI shows "✓ Logged in as [your-email]"

### Option B: Use Existing Credentials
If you're already logged in:
```bash
firebase projects:list
```

This will show your projects. If `care-vault-project` appears, you're ready to deploy!

---

## 📦 Step 2: Deploy Functions

Once authenticated, run:

```bash
cd C:\Users\shwet\Downloads\Carevault

# Deploy only the new health report functions
firebase deploy --only functions:getPatientReport,functions:getPatientRisk,functions:getPatientAllergies

# OR deploy all functions
firebase deploy --only functions
```

**Expected output:**
```
✔ functions[getPatientReport]: Successful deploy
✔ functions[getPatientRisk]: Successful deploy  
✔ functions[getPatientAllergies]: Successful deploy

Deploy complete!

Project Console: https://console.firebase.google.com/project/care-vault-project/overview
Functions Dashboard: https://console.firebase.google.com/project/care-vault-project/functions
```

---

## 🌐 Step 3: Access Your Functions

After deployment, your functions are available at:

```
https://asia-south1-care-vault-project.cloudfunctions.net/getPatientReport
https://asia-south1-care-vault-project.cloudfunctions.net/getPatientRisk
https://asia-south1-care-vault-project.cloudfunctions.net/getPatientAllergies
```

Or through your web app at:
```
https://care-vault-project.web.app/patient  → Health Report tab
https://care-vault-project.web.app/doctor   → Patient → Disease Risk tab
```

---

## ✅ Step 4: Verify Deployment

### Test the API Endpoints

```bash
# Test health report endpoint
curl "https://asia-south1-care-vault-project.cloudfunctions.net/getPatientReport?patientId=patient-123"

# Test risk endpoint
curl "https://asia-south1-care-vault-project.cloudfunctions.net/getPatientRisk?patientId=patient-123"

# Test allergies endpoint
curl "https://asia-south1-care-vault-project.cloudfunctions.net/getPatientAllergies?patientId=patient-123"
```

### Expected Response
```json
{
  "reportMetadata": {...},
  "patientInformation": {...},
  "diseaseRiskAssessment": {...},
  "allergyAlerts": {...},
  "summaryReport": "...",
  "recommendations": [...]
}
```

### Check Firebase Console

1. Go to: https://console.firebase.google.com/project/care-vault-project/functions
2. Click on each function to see:
   - Deploy status ✓
   - Execution logs
   - Error messages (if any)
   - Performance metrics

---

## 📱 Step 5: Access the Feature

### For Patients:
1. Go to: https://care-vault-project.web.app
2. Login as patient (e.g., Anna Rivera)
3. Click **"Health Report"** in the left menu
4. View your comprehensive health assessment

### For Doctors:
1. Go to: https://care-vault-project.web.app
2. Login as doctor
3. Search for a patient (e.g., HRID)
4. Click **"Disease Risk"** tab
5. Click **"Load Full Report"** button
6. View comprehensive patient assessment

---

## 🔧 Troubleshooting

### "Could not load the default credentials"
**Solution:** Run `firebase login` to authenticate

### "Permission denied"
**Solution:** 
- Ensure your Google account has access to care-vault-project
- Contact project owner if needed
- Check IAM roles in Google Cloud Console

### "Function returned an error"
**Solution:**
- Check Firebase Console → Functions → Logs
- Verify patient ID is valid
- Check Firestore has patient data

### CORS errors in browser
**Solution:**
- Already configured in code
- Clear browser cache
- Check browser console for exact error

---

## 📊 Monitoring After Deployment

### View Logs
```bash
firebase functions:log --follow
```

### Check Status
```bash
firebase deploy:list
```

### View Detailed Metrics
Go to: https://console.firebase.google.com/project/care-vault-project/functions

---

## 🎯 What Gets Deployed

The deployment includes:

| Function | Purpose | Endpoint |
|----------|---------|----------|
| `getPatientReport` | Full health report | `/getPatientReport?patientId=X` |
| `getPatientRisk` | Disease risk scores | `/getPatientRisk?patientId=X` |
| `getPatientAllergies` | Allergy information | `/getPatientAllergies?patientId=X` |

**All functions:**
- Region: asia-south1
- Timeout: 60 seconds
- Memory: 256 MB
- CORS: Enabled for web app domains

---

## 📝 Before Deployment Checklist

- ✅ Firebase CLI installed (`firebase --version`)
- ✅ Authenticated with Firebase (`firebase login`)
- ✅ Project set to care-vault-project (`.firebaserc`)
- ✅ Functions code complete (`functions/patient-report.js`)
- ✅ Dependencies installed (`npm install` in functions/)
- ✅ No syntax errors (functions tested locally)
- ✅ All imports and exports correct
- ✅ Demo data included for testing

---

## 🚀 Quick Deploy Command

Once authenticated, one command deploys everything:

```bash
cd C:\Users\shwet\Downloads\Carevault && firebase deploy --only functions
```

---

## 📞 After Deployment Support

### View Real-Time Logs
```bash
firebase functions:log --follow
```

### Rollback if Needed
```bash
firebase deploy --only functions  # Re-deploy to rollback
```

### Update Functions
1. Edit `functions/patient-report.js`
2. Commit to git
3. Run `firebase deploy --only functions`

---

## ✨ Success Indicators

After deployment, you'll see:
- ✅ Green checkmarks next to function names in Firebase Console
- ✅ Functions accessible via HTTPS URLs
- ✅ Patient dashboard shows "Health Report" tab with data
- ✅ Doctor dashboard shows "Load Full Report" button that works
- ✅ No errors in Functions logs

---

## 🎉 You're Done!

The health report feature is live and available to all users!

**Next steps:**
1. Test with patient account
2. Test with doctor account
3. Monitor performance
4. Gather user feedback
5. Plan for real data integration

---

## 📚 Additional Resources

- **Firebase Console:** https://console.firebase.google.com
- **Functions Documentation:** https://firebase.google.com/docs/functions
- **Troubleshooting Guide:** See documentation in this repo
- **Code Reference:** `functions/patient-report.js`

