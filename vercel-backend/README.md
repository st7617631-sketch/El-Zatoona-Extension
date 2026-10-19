# الزتونة — Backend (Vercel Serverless)

واجهة الـ API اللي الإضافة بتكلمها. مفتاح واحد بس من Gemini مش كفاية، فالكود
بيقرا **أكتر من مفتاح** من الـ Environment Variables وبيعمل **Key Rotation**
لواحد أوتوماتيك لما المفتاح اللي قبله يرجع `429` (الرصيد خلص).

```
POST /api/summarize
body:   { "type": "article" | "product", "text": "…", "title": "…" }
200:    { "ok": true, "answer": "…", "model": "gemini-2.5-flash-lite", "keyIndex": 0 }
429:    { "ok": false, "error": "all_keys_exhausted" }   ← كل المفاتيح خلصت
5xx:    { "ok": false, "error": "gemini_failed", "message": "…" }
```

## 1) متغيرات البيئة (على Vercel)

| المتغير | إجباري | الوصف |
|---|---|---|
| `GEMINI_API_KEYS` | ✅ | كل مفاتيح Gemini مفصولة بفاصلة (أو سطر جديد، أو JSON array) |
| `GEMINI_API_KEY` | ❌ | مفتاح واحد بديل لو حابب |
| `GEMINI_MODEL` | ❌ | افتراضي `gemini-2.5-flash-lite` (ممكن `gemini-2.5-flash`) |
| `ALLOWED_ORIGIN` | ❌ | قائمة CORS مسموحة، افتراضي `*` |

شكل `GEMINI_API_KEYS`:

```
AIzaSy…key1,AIzaSy…key2,AIzaSy…key3
```

## 2) النشر

```powershell
cd vercel-backend
npx vercel login
npx vercel            # أول مرة: اربط المشروع
npx vercel --prod     # نشر للإنتاج
```

أو من لوحة Vercel: **Add New → Project → Import** الفولدر ده (Root Directory =
`vercel-backend` لو المشروع كله مرفوع في نفس الريبو).

بعد النشر هتاخد رابط زي `https://el-zatoona.vercel.app/api/summarize`.

## 3) ربط الإضافة بالرابط

الرابط موجود في ملف واحد بس: `src/ai/ai.js` →

```js
const DEFAULT_API_URL = 'https://el-zatoona.vercel.app/api/summarize';
```

غيّره لرابط مشروعك، واتأكد إن الـ `host_permissions` في `manifest.json` بتسمح
للنطاق (`https://*.vercel.app/*` شغال لأي مشروع على Vercel).

## 4) منطق الـ Key Rotation

| رد Gemini | السلوك |
|---|---|
| `200` | بيرجع الإجابة |
| `429` (رصيد/حصة خلصت) | المفتاح اللي بعده فوراً |
| `401` / `403` (مفتاح غلط أو محظور) | المفتاح اللي بعده فوراً |
| `500` / `502` / `503` / `504` أو Timeout | المفتاح اللي بعده فوراً |
| `400` (طلب غلط من الإضافة) | مبيستهلكش باقي المفاتيح، بيرجع 400 |

لو كل المفاتيح فشلت → `429` مع `error: "all_keys_exhausted"`، والإضافة بتظهر
رسالة "الخدمة عليها ضغط دلوقتي" **من غير** ما تخصم محاولة من اليوزر.

## 5) الاختبار

```powershell
cd vercel-backend
npm test        # 7 حالات: أول مفتاح، 429 → rotation، كل المفاتيح، 403، JSON array، الـ prompt، مدخلات غلط
```

```powershell
# تجربة محلية
copy .env.example .env   # وحط مفاتيحك
npx vercel dev
```

## هيكل الفولدر

```
vercel-backend/
  api/summarize.js        # الـ Serverless Function (Node.js، بدون dependencies)
  test/summarize.test.js  # اختبارات الـ rotation (fetch متزيّف)
  vercel.json             # maxDuration 30s
  .env.example            # شكل المتغيرات
```
