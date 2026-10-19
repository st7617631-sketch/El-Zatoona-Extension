/**
 * El Zatoona — Content extractor (Phase 2)
 * ---------------------------------------------------------------
 * This function is injected into the active tab by the popup via
 * `chrome.scripting.executeScript({ func: extractContent, args: [type] })`.
 *
 * IMPORTANT: it must be fully self-contained — no references to anything
 * outside its own body, because it is serialised and run in the page.
 *
 * @param {'article'|'product'} type
 * @returns {{type: string, url: string, title: string, site: string,
 *            data: object, text: string, stats: object}}
 */
function extractContent(type) {
  'use strict';

  const MAX_TEXT_CHARS = 15000; // keep the payload small for Gemini Nano
  const MAX_ITEMS = 12;

  /**
   * Per-site product selectors, ordered from most specific to most generic so
   * a site redesign only breaks one tier at a time.
   *
   * Declared BEFORE it is used (extractContent falls back to it below).
   */
  const PRODUCT_SELECTORS = {
    amazon: {
      name: ['#productTitle', '#title', 'h1#title', 'h1 span#productTitle', 'h1'],
      price: [
        '.priceToPay .a-offscreen',
        '#corePrice_feature_div .a-price .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
        '#priceblock_ourprice',
        '#priceblock_dealprice',
        '#price_inside_buybox',
        '.a-price .a-offscreen',
      ],
      oldPrice: ['.basisPrice .a-offscreen', '.a-text-price .a-offscreen', '#listPrice'],
      rating: ['#acrPopover [title]', '#acrPopover .a-icon-alt', '[data-hook="rating-out-of-text"]', 'span.a-icon-alt'],
      reviewsCount: ['#acrCustomerReviewText', '[data-hook="total-review-count"]'],
      // Most specific child elements FIRST — `collect` drops parents of
      // anything already captured.
      description: [
        '#feature-bullets li span.a-list-item',
        '#featurebullets_feature_div li span.a-list-item',
        '#feature-bullets li',
        '#productFactsDesktopExpander li',
        '#productDescription p',
        '#productDescription',
        '#aplus p',
      ],
      // Amazon mainly renders reviews on a separate (often sign-in) page, so
      // this tier is best-effort; the AI can still use rating + features.
      reviews: [
        '#reviewsMedley [data-hook="review-body"] span',
        '#reviewsMedley .review-text-content span',
        '[data-hook="review-body"] span',
        '[data-hook="review-body"]',
        '.review-text-content span',
        '.review-text-content',
      ],
    },
    noon: {
      name: ['h1', '[data-qa="product-name"]', '[class*="ProductName"]', '[class*="productName"]'],
      price: [
        '[data-qa="product-price"]',
        '[class*="priceNow"]',
        '[class*="Price"] [class*="priceNow"]',
        '[class*="ProductPrice"] ins',
        '[class*="price"]:not([class*="Old"]):not([class*="old"]):not([class*="Before"])',
      ],
      oldPrice: ['[class*="priceOld"]', 'del', 's'],
      rating: ['[data-qa="product-rating"]', '[class*="ratingValue"]', '[class*="rating"] [aria-label]'],
      reviewsCount: ['[data-qa="product-reviews-count"]', '[class*="reviewsCount"]'],
      description: [
        '[data-qa="product-description"] li',
        '[data-qa="product-description"] p',
        '[data-qa="product-description"]',
        '[class*="ProductDescription"] li',
        '#product-description li',
        '[class*="productDescription"] li',
      ],
      reviews: ['[class*="reviewBody"]', '[class*="review-body"]', '[data-qa*="review"] p'],
    },
    jumia: {
      name: ['h1.-fs20', 'h1.-m', 'h1[class*="-pv"]', 'h1'],
      price: ['.-fs24.-b.-ltr.-ta-', '.price-container .-b', '[data-price]', '.-fs24.-b'],
      oldPrice: ['.old-price', '.-old', 's'],
      rating: ['[class*="stars"]', '.stars._m._al'],
      reviewsCount: ['[href*="#reviews"]', '.rating-container a'],
      description: [
        'div.markup.-mvs li',
        'div.markup.-mvs p',
        'div.markup.-mvs',
        '[class*="markup"] li',
        '#description li',
        'div[data-cnstrc-item-description]',
      ],
      reviews: ['article.-pvs p', '[class*="review"] p'],
    },
    generic: {
      name: ['h1', '[itemprop="name"]', '[class*="product-title"]', '[class*="productTitle"]', '[class*="product-name"]'],
      price: ['[itemprop="price"]', '[class*="price"] [class*="current"]', '[class*="price"]', '[data-price]'],
      oldPrice: ['[itemprop="highPrice"]', 'del', 's', '[class*="old-price"]'],
      rating: ['[itemprop="ratingValue"]', '[class*="rating"] [aria-label]', '[class*="rating"]'],
      reviewsCount: ['[itemprop="reviewCount"]', '[class*="review-count"]', '[class*="reviews-count"]'],
      description: [
        '[itemprop="description"] li',
        '[itemprop="description"] p',
        '[itemprop="description"]',
        '#description li',
        '[class*="description"] li',
      ],
      reviews: ['[itemprop="reviewBody"]', '[class*="review-body"]', '[class*="reviewBody"]'],
    },
  };

  /* ----------------------------- helpers ----------------------------- */

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const q = (sel, root = document) => {
    try {
      return root.querySelector(sel);
    } catch {
      return null; // a browser that rejects the selector must not kill extraction
    }
  };
  const qa = (sel, root = document) => {
    try {
      return Array.from(root.querySelectorAll(sel));
    } catch {
      return [];
    }
  };

  const txt = (el) => (el ? clean(el.innerText || el.textContent) : '');

  /** First non-empty text among a list of selectors. */
  const firstText = (selectors, root = document) => {
    for (const sel of selectors) {
      const el = q(sel, root);
      const t = txt(el);
      if (t) return t;
    }
    return '';
  };

  /**
   * Collect unique, non-empty text values, capped.
   *
   * Walks most-specific selectors first and skips an element when one of its
   * descendants was already captured (otherwise a parent like
   * `#featurebullets_feature_div` swallows its own <li>s and the list items
   * are lost to the dedupe). Also skips a parent whose text is just the
   * children's text glued together.
   */
  const collect = (selectors, root = document, max = MAX_ITEMS) => {
    const out = [];
    const seen = new Set();
    const captured = [];

    const take = (el) => {
      const t = txt(el);
      if (!t || t.length < 2) return;
      const key = t.slice(0, 120);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
      captured.push(el);
    };

    for (const sel of selectors) {
      const matches = qa(sel, root);
      // A selector that matched nothing falls through to the next one.
      if (!matches.length) continue;

      for (const el of matches) {
        // Skip a parent whose children were already captured (it would just
        // glue them together, e.g. `.markup` swallowing its own <li>s).
        if (captured.some((node) => node !== el && el.contains(node))) continue;
        take(el);
        if (out.length >= max) return out;
      }

      // The most specific selectors that actually matched did their job —
      // the generic fallbacks below would only add noise.
      if (out.length) break;
    }
    return out;
  };

  /** hostname → "amazon" | "noon" | "jumia" | host */
  const siteOf = (hostname) => {
    const h = (hostname || '').toLowerCase();
    for (const brand of ['amazon', 'noon', 'jumia']) {
      if (h === brand || h.endsWith('.' + brand) || h.includes(brand + '.')) return brand;
    }
    return h.replace(/^www\./, '');
  };

  /* ------------------------- shared structure ------------------------ */

  const meta = (name) => {
    const el =
      q(`meta[property="${name}"]`) ||
      q(`meta[name="${name}"]`) ||
      q(`meta[itemprop="${name}"]`);
    return el ? clean(el.getAttribute('content')) : '';
  };

  const jsonLdBlocks = () =>
    qa('script[type="application/ld+json"]')
      .map((s) => {
        try {
          return JSON.parse(s.textContent);
        } catch {
          return null;
        }
      })
      .flatMap((v) => (Array.isArray(v) ? v : v && v['@graph'] ? v['@graph'] : [v]))
      .filter(Boolean);

  const ldProduct = () =>
    jsonLdBlocks().find((b) => {
      const t = b['@type'];
      return t === 'Product' || (Array.isArray(t) && t.includes('Product'));
    }) || null;

  const base = {
    url: location.href,
    title: clean(document.title),
    site: siteOf(location.hostname),
  };

  /* ============================== ARTICLE ============================ */

  function extractArticle() {
    // 1) Throw away everything that is almost never article content.
    const junk = [
      'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form',
      'nav', 'header', 'footer', 'aside', 'dialog', 'template',
      '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
      '[role="complementary"]', '[role="search"]', '[role="dialog"]',
      '[aria-hidden="true"]',
      '.ad', '.ads', '.advert', '.advertisement', '.adsbygoogle',
      '[class*="banner"]', '[class*="cookie"]', '[class*="newsletter"]',
      '[class*="subscribe"]', '[class*="popup"]', '[class*="modal"]',
      '[class*="sidebar"]', '[class*="social"]', '[class*="share"]',
      '[id*="comment"]', '[class*="comment"]', '[class*="related"]',
      '[class*="recommend"]', '[class*="promo"]', '[class*="sponsor"]',
    ].join(',');

    // 2) Candidates, best first: semantic containers → generic containers.
    const candidates = [
      'article',
      '[role="main"] article',
      'main article',
      'main',
      '[role="main"]',
      '[itemprop="articleBody"]',
      '#content',
      '.post-content',
      '.article-content',
      '.entry-content',
      '.post-body',
      '.markdown-body',
      '#mw-content-text', // Wikipedia / MediaWiki
      '.mw-parser-output', // Wikipedia / MediaWiki
      '#mw-content-text .mw-parser-output > p', // article prose, not tables/navboxes
      'body',
    ];

    /** Score a root by how much readable text it holds. */
    const score = (root) => {
      const clone = root.cloneNode(true);
      qa(junk, clone).forEach((n) => n.remove());
      const blocks = qa('h1, h2, h3, p, li, blockquote', clone);
      let chars = 0;
      for (const b of blocks) chars += txt(b).length;
      return { root: clone, chars, blocks: blocks.length };
    };

    let best = null;
    for (const sel of candidates) {
      for (const el of qa(sel)) {
        const s = score(el);
        // Prefer the container with the most content; break ties by order.
        if (!best || s.chars > best.chars) best = { ...s, sel };
      }
      // A semantic container with real content is good enough — stop early.
      if (best && best.chars > 400 && sel !== 'body') break;
    }

    // Title sources in order of trust: the article's own H1, a real page H1
    // (not one sitting in nav/header), then <title>.
    const realH1 = qa('h1').find((el) => !el.closest('header, nav, aside, footer'));
    const pageTitle =
      txt(q('article h1')) ||
      txt(realH1) ||
      firstText(['[itemprop="headline"]']) ||
      base.title;

    if (!best) {
      const bodyText = clean(document.body ? document.body.innerText : '');
      return {
        ...base,
        data: {
          container: 'body(innerText)',
          heading: pageTitle,
          headings: [],
          paragraphs: [],
          author: '',
          publishedAt: '',
        },
        text: (pageTitle ? pageTitle + '\n\n' : '') + bodyText,
        stats: { chars: bodyText.length, paragraphs: 0, headings: 0 },
      };
    }

    const root = best.root;

    // 3) Pull headings + paragraphs, in document order, without duplicates.
    const headings = [];
    const paragraphs = [];
    const seen = new Set();

    for (const el of qa('h1, h2, h3, p, li, blockquote', root)) {
      const t = txt(el);
      if (t.length < 2) continue;
      const key = t.slice(0, 100);
      if (seen.has(key)) continue;

      const tag = el.tagName.toLowerCase();
      const heading = tag.startsWith('h') && t.length <= 200;

      // Keep the title once, however many times the page repeats it
      // (Wikipedia: <title>, the <h1>, and the infobox caption).
      if (t === pageTitle) {
        continue;
      }
      seen.add(key);

      if (heading) headings.push(t);
      else if (t.length >= 15) paragraphs.push(t); // short li/p are menus/labels
    }

    const author =
      firstText(['[rel="author"]', '[itemprop="author"]', '.author', '.byline', '.post-author']) ||
      meta('author') ||
      meta('article:author');

    const publishedAt =
      meta('article:published_time') ||
      meta('datePublished') ||
      (q('time[datetime]') ? q('time[datetime]').getAttribute('datetime') : '');

    // Reading order: its own H1 first, then the body paragraphs, then section
    // headings. Headings-last keeps the prose readable when a long article is
    // cut at MAX_TEXT_CHARS (a Wikipedia headings box can alone be 4k chars).
    const h1Block = headings.filter((h) => h !== pageTitle);
    const parts = [];
    if (pageTitle) parts.push(pageTitle);
    parts.push(paragraphs.join('\n\n'));
    if (h1Block.length) parts.push(`\n## الأقسام\n${h1Block.join('\n')}`);
    const text = parts.filter(Boolean).join('\n\n').slice(0, MAX_TEXT_CHARS);

    return {
      ...base,
      data: {
        container: best.sel,
        heading: pageTitle,
        headings: headings.slice(0, 20),
        paragraphs,
        author,
        publishedAt,
      },
      text,
      stats: { chars: text.length, paragraphs: paragraphs.length, headings: headings.length },
    };
  }

  /* ============================== PRODUCT ============================ */

  function extractProduct() {
    const sels = PRODUCT_SELECTORS[base.site] || PRODUCT_SELECTORS.generic;
    const ld = ldProduct();
    const ldOffer = ld && (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers);
    const ldRating = ld && ld.aggregateRating ? ld.aggregateRating : null;

    const siteName = firstText(sels.name);
    const name = siteName || (ld && clean(ld.name)) || meta('og:title') || base.title;

    // Page selectors win over JSON-LD: on sale, JSON-LD often carries the
    // list price while the page shows the discounted one.
    let price = firstText(sels.price);
    if (!price) price = meta('product:price:amount') || meta('og:price:amount');
    if (!price && ldOffer && ldOffer.price) {
      price = clean(String(ldOffer.price)) + (ldOffer.priceCurrency ? ' ' + ldOffer.priceCurrency : '');
    }

    const oldPrice = firstText(sels.oldPrice);

    let rating = firstText(sels.rating);
    if (!rating && ldRating && ldRating.ratingValue) rating = String(ldRating.ratingValue);
    if (!rating) rating = meta('og:rating') || '';

    let reviewsCount = firstText(sels.reviewsCount);
    if (!reviewsCount && ldRating && ldRating.reviewCount) reviewsCount = String(ldRating.reviewCount);

    const description = collect(sels.description, document, 10);
    if (!description.length && ld && ld.description) {
      const d = clean(String(ld.description));
      if (d) description.push(d.slice(0, 600));
    }

    const reviews = collect(sels.reviews, document, 8);

    const availability =
      (ldOffer && (ldOffer.availability || '').toString().split('/').pop()) ||
      firstText(['#availability', '[class*="stock"]', '[data-qa="product-stock"]']);

    const ldBrand = ld ? (typeof ld.brand === 'object' ? clean(ld.brand && ld.brand.name) : clean(ld.brand)) : '';
    const brand =
      ldBrand ||
      firstText(['#bylineInfo', '[data-qa="product-brand"]']) ||
      meta('product:brand');

    // Human-readable block, ready for the AI in Phase 3.
    const lines = [];
    if (name) lines.push(`اسم المنتج: ${name}`);
    if (base.site) lines.push(`الموقع: ${base.site}`);
    if (brand) lines.push(`الماركة: ${brand}`);
    if (price) lines.push(`السعر الحالي: ${price}`);
    if (oldPrice) lines.push(`السعر قبل الخصم: ${oldPrice}`);
    if (rating) lines.push(`التقييم: ${rating}`);
    if (reviewsCount) lines.push(`عدد التقييمات: ${reviewsCount}`);
    if (availability) lines.push(`التوفر: ${availability}`);
    if (description.length) lines.push(`\nالوصف / أهم المميزات:\n- ${description.join('\n- ')}`);
    if (reviews.length) lines.push(`\nمقتطفات من تقييمات العملاء:\n- ${reviews.join('\n- ')}`);

    const text = lines.join('\n').slice(0, MAX_TEXT_CHARS);

    return {
      ...base,
      data: { name, brand, price, oldPrice, rating, reviewsCount, availability, description, reviews, source: ld ? 'selectors+jsonld' : 'selectors' },
      text,
      stats: { chars: text.length, features: description.length, reviews: reviews.length },
    };
  }

  /* ------------------------------- run ------------------------------- */

  try {
    return type === 'product' ? extractProduct() : extractArticle();
  } catch (err) {
    console.error('[El Zatoona] extractContent failed:', err);
    return {
      ...base,
      error: String((err && err.message) || err),
      data: {},
      text: '',
      stats: { chars: 0 },
    };
  }
}
