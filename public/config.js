/**
 * PFT-AST · Frontend Configuration  v5.0
 * ══════════════════════════════════════════════════════
 *
 * STEP 1 — Deploy /backend to Railway (or HuggingFace Spaces).
 *           Copy the public URL.
 *
 * STEP 2 — Paste the URL below:
 *
 *   window.BACKEND_URL = 'https://your-app.up.railway.app';
 *
 *   (leave empty '' for local dev — same-origin requests will work)
 *
 * STEP 3 — Deploy /frontend to Vercel.
 *
 * ══════════════════════════════════════════════════════
 *
 * TIP: You can also set BACKEND_URL via a Vercel Environment Variable
 * and inject it at build time so you never have to edit this file.
 * Add a Vercel env var  NEXT_PUBLIC_BACKEND_URL (or use a build script
 * that replaces the placeholder below).
 */

window.BACKEND_URL = ''https://rajeshragi-final.hf.space';   // <- paste your Railway / HuggingFace URL here

/**
 * MODEL LOADING POLL
 * The frontend will automatically poll /api/status every 5s until the
 * model is ready, then show a toast and enable the Analyze button.
 * No action needed here — this is handled by app.js.
 */
