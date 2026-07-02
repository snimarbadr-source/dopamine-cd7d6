# Dopamine — نظام إدارة مهام الموظفين v7

https://github.com/snimarbadr-source/dopamine-cd7d6

## 🚀 خطوات النشر على Vercel

### 1. Environment Variables
| المتغير | القيمة |
|---|---|
| VITE_FIREBASE_API_KEY | من Firebase Console |
| VITE_FIREBASE_AUTH_DOMAIN | project.firebaseapp.com |
| VITE_FIREBASE_PROJECT_ID | project-id |
| VITE_FIREBASE_STORAGE_BUCKET | project.appspot.com |
| VITE_FIREBASE_MESSAGING_SENDER_ID | رقم |
| VITE_FIREBASE_APP_ID | 1:xxx:web:xxx |

### 2. Build Settings
| الحقل | القيمة |
|---|---|
| Build Command | bash build.sh |
| Output Directory | . |
| Install Command | (فارغ) |

### 3. Firebase Console
- Authentication → Sign-in method → فعّل Email/Password
- Firestore → Rules:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if request.auth != null; }
  }
}
```

## 🔐 بيانات المسؤول
- الاسم: 122#
- الرقم الوطني: 122#

## ✅ لا حاجة لـ Firebase Storage أو خطة Blaze المدفوعة
الصور تُخزَّن كـ Base64 مضغوط داخل Firestore مباشرة.

## 📋 الميزات الكاملة v7
- تسجيل دخول/خروج/إنشاء حساب + نسيان كلمة المرور
- مهام جديدة بخطوات واضحة + اختيار الصنف بكروت مرئية
- رفع صور بالضغط أو السحب أو لصق Ctrl+V
- ضغط تلقائي للصور + علامة مائية
- إيقاف مؤقت + إكمال مهمة لاحقاً مع تتبع وقت الغياب
- إرسال مهمة لموظف محدد مع إشعار فوري
- لوحة تنبيهات (جرس) تعرض آخر 3 إشعارات مع صور المهمة وأزرار قبول/رفض
- تنبيهات مركزية جميلة بدل رسائل المتصفح
- معاينة الصور بالتكبير (Lightbox)
- مقارنة صور قبل/بعد بشريط السحب
- لوحة إدارة كاملة مع إحصائيات لحظية
- صفحة الموظفين مع إدارة كاملة (إرسال/صلاحية/حذف)
- صلاحية مزدوجة (موظف + مسؤول)
- صفحة المتابعة: سجل كامل لكل نشاط
- ترقيم الصفحات (50 عنصر/صفحة) في كل القوائم
- تصميم متجاوب على كل الشاشات (جوال/تابلت/كمبيوتر)
- شعار الموقع في تبويب المتصفح (Favicon)
