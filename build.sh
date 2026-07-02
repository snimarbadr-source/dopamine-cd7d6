#!/bin/bash
# ============================================================
#  build.sh — يُنفَّذ تلقائياً على Vercel عند كل deploy
#  يستبدل المتغيرات المؤقتة بالقيم الحقيقية من Environment Variables
# ============================================================

echo "🔧 Injecting Firebase environment variables..."

sed -i \
  -e "s|__VITE_FIREBASE_API_KEY__|${VITE_FIREBASE_API_KEY}|g" \
  -e "s|__VITE_FIREBASE_AUTH_DOMAIN__|${VITE_FIREBASE_AUTH_DOMAIN}|g" \
  -e "s|__VITE_FIREBASE_PROJECT_ID__|${VITE_FIREBASE_PROJECT_ID}|g" \
  -e "s|__VITE_FIREBASE_STORAGE_BUCKET__|${VITE_FIREBASE_STORAGE_BUCKET}|g" \
  -e "s|__VITE_FIREBASE_MESSAGING_SENDER_ID__|${VITE_FIREBASE_MESSAGING_SENDER_ID}|g" \
  -e "s|__VITE_FIREBASE_APP_ID__|${VITE_FIREBASE_APP_ID}|g" \
  js/firebase-config.js

echo "✅ Firebase config injected successfully."
