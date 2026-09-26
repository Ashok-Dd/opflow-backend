# Deploying the OPflow API on Render (test server)

One Render **web service** runs the API and the background jobs together. It uses the Supabase database you
already have, which has every migration applied.

The server runs in **demo mode**: a staging server before the real accounts exist. The stand-ins are:

| Real service | Demo stand-in |
|---|---|
| Firebase phone login | The **demo code** from `DEMO_OTP_CODE`. Any phone number, but only that code works. |
| Razorpay | Stand-in Checkout (no real money). |
| Resend / MSG91 / FCM | Messages are written to the log. |
| R2 | Files on the server's disk. Doctor photos are lost when the server restarts. |

The server refuses demo mode when `APP_ENV=production`.

## 1. The code on GitHub

The backend is its own repository: https://github.com/Ashok-Dd/opflow-backend (the `backend` folder is its root,
with `render.yaml` at the top). Secrets are never in it: `.env`, `.env.render` and the Firebase key file are ignored.

## 2. Create the service from the blueprint

Render → **New → Blueprint** → connect GitHub → pick **opflow-backend**. Render reads `render.yaml` and creates
`opflow-api`:
- **Region:** Singapore.
- **Plan:** Starter. It stays awake, so bookings and background jobs keep running. The free plan sleeps after
  15 minutes, and the first request then takes about a minute.

Render asks for the secret values. Copy each one from **`backend/.env.render`** on your computer:

| Key | From `backend/.env.render` |
|---|---|
| `DATABASE_URL` | the `opflow_api` login (never the `postgres` one: the server refuses it) |
| `JWT_ACCESS_PRIVATE_KEY_B64`, `JWT_ACCESS_PUBLIC_KEY_B64` | token signing keys |
| `PASSWORD_PEPPER`, `DATA_ENCRYPTION_KEY` | keep a safe copy: losing them resets every password |
| `DEMO_OTP_CODE` | required in demo mode (a fallback test code) |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY_B64` | push notifications |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay **test** mode |

Patient login uses SMS codes (`PHONE_LOGIN=sms`). Until the MSG91 OTP template is set, no SMS is sent and the app
shows the code on its code screen (test server only).

The database certificate (`DB_SSL_CA_B64`) is already in `render.yaml`.

When the deploy finishes, open `https://opflow-api.onrender.com/ready`. It must show `"database": {"ok": true}`.
Every push to `main` deploys again automatically (changes to `docs/` or `migrations/` alone do not).

## 3. Doctors and the admin

The Supabase database has no doctors yet. Choose one:
- **Demo data** (the app's 5 hospitals and 10 doctors, easy to hide later with `--remove`): on your computer, in
  `backend/`, run `npm run seed:demo`.
- **Real doctors:** create the admin (`npm run admin:create -- --email you@… --name "…"`), then add doctors from the
  admin site.

Both use `backend/.env`, which points at Supabase.

## 4. Point the app at it

```bash
cd app
flutter build apk --release --dart-define=BACKEND=api --dart-define=API_BASE_URL=https://opflow-api.onrender.com
```

Patients log in with any mobile number and the `DEMO_OTP_CODE`. The demo doctor (after step 3's demo data) is
OPD-10234 / demo1234.

## Optional: push notifications and Razorpay test mode on the test server

Demo mode keeps the demo login code. Adding these in Render → opflow-api → Environment turns on the real service:
- **Push (Android + iPhone):** `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY_B64`, the same
  values as in `backend/.env`.
- **Razorpay test mode:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`. In the Razorpay
  dashboard, set the webhook to `https://opflow-api.onrender.com/v1/webhooks/razorpay`.

## Later: going live

- Set up the real accounts: Firebase, Razorpay (and Route), R2, Resend, MSG91.
- Put their keys in Render.
- Set `DEMO_MODE=false`, and `APP_ENV=production` for the live server.

The server refuses to start while any required key is missing, and tells you which.
