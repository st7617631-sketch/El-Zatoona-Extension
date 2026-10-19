/**
 * El Zatoona — Pro licence check (Phase 4)
 * ---------------------------------------------------------------
 * A Gumroad "Pro" product sells a licence key. The extension verifies the key
 * with Gumroad's public API:
 *
 *   POST https://api.gumroad.com/v2/licenses/verify
 *        product_id=…&license_key=…&increment_uses_count=false
 *
 * On success we only store `isPro: true` + the key in chrome.storage.sync —
 * no server of ours is involved, everything stays on the user's machine.
 *
 * Configuration lives in manifest.json → `gumroad`:
 *   { "productId": "…", "productPermalink": "…", "checkoutUrl": "…" }
 * Either productId or productPermalink is enough for the verify call;
 * checkoutUrl is the buy link opened by the "اشترك الآن" button.
 *
 * Loaded in popup.html BEFORE popup.js → single global: `ZatoonaPro`.
 * No DOM access at load time (the QA scripts load it too).
 */

'use strict';

/* eslint-disable no-var */
var ZatoonaPro = (function () {
  const VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';

  /** Fallbacks, used when manifest.json has no `gumroad` block (or throws). */
  const FALLBACK = Object.freeze({
    productId: '',
    productPermalink: 'el-zatoona',
    checkoutUrl: 'https://elzatoona.gumroad.com/l/el-zatoona',
  });

  const STATUS = Object.freeze({
    VALID: 'valid',
    INVALID: 'invalid',
    REFUNDED: 'refunded',
    NOT_CONFIGURED: 'not_configured',
    NETWORK: 'network',
  });

  /** Reads the `gumroad` block from the extension manifest. */
  function config() {
    let fromManifest = {};
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
        fromManifest = chrome.runtime.getManifest().gumroad || {};
      }
    } catch {
      fromManifest = {};
    }
    return {
      productId: String(fromManifest.productId || FALLBACK.productId).trim(),
      productPermalink: String(fromManifest.productPermalink || FALLBACK.productPermalink).trim(),
      checkoutUrl: String(fromManifest.checkoutUrl || FALLBACK.checkoutUrl).trim(),
    };
  }

  /** Sale returned by Gumroad (`use` = number of devices the key was used on). */
  function limitReached(sale, maxUses) {
    if (!maxUses || maxUses <= 0) return false;
    const used = Number(sale && (sale.uses ?? sale.use)) || 0;
    return used >= maxUses;
  }

  /**
   * Verifies a licence key with Gumroad.
   *
   * @param {string} licenseKey
   * @returns {Promise<{status: string, sale?: object, message?: string}>}
   */
  async function verify(licenseKey) {
    const key = String(licenseKey || '').trim();
    if (!key) return { status: STATUS.INVALID, message: 'empty key' };

    const { productId, productPermalink } = config();
    if (!productId && !productPermalink) return { status: STATUS.NOT_CONFIGURED };
    // The QA harness has no network: it sets `ZATOONA_GUMROAD_STUB` instead.
    if (globalThis.ZATOONA_GUMROAD_STUB) return globalThis.ZATOONA_GUMROAD_STUB(key);

    const form = new URLSearchParams({ license_key: key, increment_uses_count: 'false' });
    if (productId) form.set('product_id', productId);
    else form.set('product_permalink', productPermalink);

    let response;
    try {
      response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch {
      return { status: STATUS.NETWORK };
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok || !data || data.success !== true || !data.purchase) {
      return { status: STATUS.INVALID, message: (data && data.message) || `HTTP ${response.status}` };
    }

    const { purchase } = data;
    if (purchase.refunded || purchase.chargebacked || purchase.subscription_cancelled_at) {
      return { status: STATUS.REFUNDED };
    }

    const maxUses = Number(purchase.product && purchase.product.max_licenses) || 0;
    if (limitReached(purchase, maxUses)) return { status: STATUS.INVALID, message: 'license limit reached' };

    return {
      status: STATUS.VALID,
      sale: {
        email: purchase.email || '',
        productName: purchase.product_name || '',
        saleId: purchase.sale_id || '',
        verifiedAt: new Date().toISOString(),
      },
    };
  }

  return Object.freeze({ STATUS, VERIFY_URL, config, verify });
})();
