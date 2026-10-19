# الزتونة - El Zatoona 🌿

إضافة لجوجل كروم (**Manifest V3**) بتلخص المقالات وتفحص المنتجات بالذكاء الاصطناعي:
**5 محاولات مجانية كل يوم**، ونسخة **Pro** بدون حدود عبر Gumroad.

> **الوضع الحالي: Phase 4 — النسخة النهائية**
> تصميم Light أفقي (600×400)، ذكاء اصطناعي سحابي عبر Vercel (Gemini + Key Rotation)،
> نظام رصيد يومي، وشاشة Paywall مع تفعيل كود Gumroad.

---

## إزاي بيشتغل

```
Popup (600×400) ──extractContent()──▶ الصفحة (أمازون / نون / جوميا / مقال)
       │
       ├─✅ محاولة مجانية أو Pro ──POST──▶ vercel-backend/api/summarize
       │                                      │  مفاتيح Gemini (Env Vars)
       │                                      └─ 429؟ → المفتاح اللي بعده
       │◀────────────── { ok, answer } ◀──────┘
       └─❌ 0 محاولات ──▶ Paywall (Gumroad checkout + كود تفعيل)
```

| المرحلة | الحالة |
|---|---|
| Phase 1 — الواجهة + عداد الرصيد | ✅ |
| Phase 2 — سحب المحتوى (`chrome.scripting`) | ✅ |
| Phase 3 — الذكاء الاصطناعي | ✅ (اتغير في Phase 4) |
| Phase 4 — Vercel + الرصيد + Pro | ✅ |

---

## التثبيت المحلي على كروم

1. نزّل المشروع (أو `git clone`).
2. افتح `chrome://extensions` → شغّل **Developer mode**.
3. **Load unpacked** واختار فولدر المشروع (اللي فيه `manifest.json`).
4. ثبّت الإضافة (Pin) من أيقونة البازل 🧩.

### ربط الـ API

- الـ Backend في فولدر [`vercel-backend/`](vercel-backend/README.md) — ارفعه على Vercel
  وحط مفاتيح Gemini في `GEMINI_API_KEYS`.
- بعد النشر، غيّر `DEFAULT_API_URL` في `src/ai/ai.js` لرابط الـ deployment.
- الـ `host_permissions` في الـ manifest بتسمح بـ `https://*.vercel.app/*`.

### ربط Gumroad

الـ Constants موجودة في `src/ai/pro.js` → `CONFIG`:

```js
const CONFIG = Object.freeze({
  productId: '',            // Gumroad product id (اختياري لو الـ permalink مضبوط)
  productPermalink: 'el-zatoona',
  checkoutUrl: 'https://elzatoona.gumroad.com/l/el-zatoona',
});
```

- `checkoutUrl` = لينك زرار **اشترك الآن**.
- `productId` (أو `productPermalink`) بيستخدمه التحقق من الكود عبر
  [`api.gumroad.com/v2/licenses/verify`](https://app.gumroad.com/api#/licenses/verify).

---

## الرصيد و Pro

| الحالة | التخزين (`chrome.storage.sync`) |
|---|---|
| مجاني | `creditsLeft`, `creditsDate`, `creditsTotal` — 5 يومياً وبيتصفّر مع يوم جديد |
| Pro | `isPro: true`, `licenseKey`, `proSale` |

- **0 محاولات** → شاشة Paywall، ومفيش أي Call للـ API ولا سحب للصفحة.
- **الرصيد بيتخصم بعد نجاح الرد بس** — لو الـ API فشل، المحاولة بتفضل زي ما هي.
- **Pro**: مفيش خصم خالص، والسطر تحت بيبقى "✨ نسخة Pro — بدون حدود".

## التفاصيل

- **`src/ai/ai.js`** — `ZatoonaAI.buildPrompt()` + `ZatoonaAI.summarize()` (fetch للـ API، Timeout 45s،
  وترجمة الردود: `out_of_quota` / `offline` / `timeout` / `server_error`).
- **`src/ai/pro.js`** — `ZatoonaPro.verify(key)` عبر Gumroad، مع رفض المفاتيح المستردة
  (`refunded` / `chargebacked`) والمفاتيح اللي وصلت للحد الأقصى.
- **`src/popup/popup.js`** — كشف نوع الصفحة، السحب، الرصيد، الـ Paywall والتفعيل.
- **التصميم** — Light theme (أبيض/رمادي فاتح) ولون الزيتوني `#5f7a1f` للتمييز،
  Pulse animation بدل الـ spinner، وFade-in ناعم للنتيجة.

## الاختبار

```powershell
npm install
npm test                                    # كشف الصفحات (21) + backend (7) + فلو AI (منتج/0 رصيد/Pro)
node .qa/ai-flow.mjs zero                   # Paywall من غير أي API call
node .qa/ai-flow.mjs licenseOk              # تفعيل كود → isPro
node .qa/ai-flow.mjs shots                  # سكرين شوتات .qa/shots/p4-*.png
cd vercel-backend; npm test                 # اختبارات Key Rotation
```

## هيكل المشروع

```
manifest.json                  # MV3 — activeTab + storage + scripting
src/popup/                     # popup.html / popup.css / popup.js (600×400 Light)
src/ai/ai.js                   # عميل الـ API (prompt + fetch)
src/ai/pro.js                  # تحقق Gumroad
src/content/extract.js         # سحب محتوى المقال/المنتج
vercel-backend/                # Serverless Function + tests + README
assets/                        # اللوجو والأيقونات
.qa/                           # أدوات الاختبار والسكرين شوتات
```
