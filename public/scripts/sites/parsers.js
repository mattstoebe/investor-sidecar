/**
 * Pure parsing helpers shared by the site adapters. No DOM, no chrome.* -- so
 * test/site-parsers.test.ts can load this exact file in a vm sandbox and exercise
 * the real implementation rather than a hand-copied mirror that drifts.
 *
 * Loaded as a plain content script (see manifest content_scripts), so it publishes
 * itself on a global rather than using ES exports.
 */
var SidecarParsers = (function () {
  /**
   * Redfin: the property id is the final all-digits path segment, whatever scheme
   * precedes it. Verified live -- /home/<id>, /for-sale/<id> and /unit-C4/home/<id>
   * all appear on one results page.
   */
  function redfinPropertyId(pathname) {
    if (!pathname) return null;
    return pathname.match(/\/(\d+)\/?$/)?.[1] ?? null;
  }

  /**
   * Zillow: /homedetails/<slug>/<zpid>_zpid/. The trailing segment is "<digits>_zpid",
   * so Redfin's all-digits rule finds nothing here.
   */
  function zillowPropertyId(pathname) {
    if (!pathname) return null;
    return pathname.match(/\/(\d+)_zpid/)?.[1] ?? null;
  }

  /**
   * Parses a combined beds/baths/sqft string. Zillow's detail page renders it
   * unpunctuated ("3beds2baths1,400sqft"); Redfin's card stats are spaced
   * ("3 beds 2 baths 1,400 sq ft"). One tolerant parser covers both.
   * Missing pieces come back null rather than a sentinel string.
   */
  function parseBedBathSqft(text) {
    const s = String(text ?? '');
    // Covers "3beds", "3 beds", "3 bd", "3 bds" -- Redfin and Zillow each use several
    // of these depending on surface (detail header vs card vs table row).
    //
    // The trailing guard is a negative lookahead, not \b: in Zillow's unpunctuated
    // "3beds2baths1,400sqft" the character after "beds" is a digit, so \b fails there.
    // (?![a-z]) still rejects longer words like "bedroom" / "bathroom".
    //
    // The leading guard exists because textContent glues adjacent elements together: a
    // Zillow card reads "$750,0002 bds3 ba", and a bare ([\d.]+) happily took the price's
    // trailing zeros, reporting 2 beds as "0002" and $569,999/3bd as "9993". Every card on
    // the results page was affected. separatedText below is the actual fix; this guard makes
    // the parser fail to null rather than return a confident wrong number if it ever sees
    // glued text again.
    const beds = s.match(/(?<![\d.,])([\d.]+)\s*(?:bd|bed)s?(?![a-z])/i)?.[1] ?? null;
    const baths = s.match(/(?<![\d.,])([\d.]+)\s*(?:ba|bath)s?(?![a-z])/i)?.[1] ?? null;
    const sqft = s.match(/(?<![\d.,])([\d,]+)\s*(?:sq\s?ft|sqft|square\s?feet)/i)?.[1] ?? null;
    return {
      beds,
      baths,
      sqft: sqft ? sqft.replace(/,/g, '') : null
    };
  }

  /**
   * An element's text with a space between every text node.
   *
   * element.textContent concatenates with no separator, so sibling elements run into each
   * other: Zillow's card price and bed count arrive as "$750,0002 bds". Splitting on text
   * nodes restores the boundary the layout implies. Values that are genuinely unpunctuated
   * within a single text node -- Zillow's detail "3beds2baths1,400sqft" -- are untouched,
   * which is why parseBedBathSqft still has to tolerate both shapes.
   */
  function separatedText(root) {
    if (!root) return '';
    const parts = [];
    const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue?.trim();
      if (text) parts.push(text);
    }
    return parts.join(' ');
  }

  /**
   * A dollar amount from a value we already know is a money field (e.g. a table cell
   * whose label said "HOA Dues", so the value itself is just "$145/month"). Use
   * parseHoa instead when scanning text that must prove it's about HOA.
   */
  function parseMoneyAmount(text) {
    const n = firstNumber(text);
    if (n === null) return null;
    const value = Number(n);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Pulls a monthly HOA fee out of a block of text. Returns null when there isn't
   * one -- which is the common case and must not be guessed at.
   *
   * The amount has to sit immediately next to the label. An earlier version used
   * /HOA[^$\d]*\$?([\d,]+)/ as a fallback, and because [^$\d]* is unbounded it
   * would match the "Community & HOA" section heading that Zillow puts on nearly
   * every listing, skip ~150 characters of unrelated text, and latch onto the first
   * digits it found -- reporting an $820,000/month HOA on a house whose facts
   * section literally read "HOA Services included: None". Wildly overstating
   * expenses is worse than reporting nothing, so every pattern here is anchored.
   */
  function parseHoa(text) {
    const s = String(text ?? '');
    const toNumber = (raw) => {
      const n = Number(String(raw).replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    // "$250 HOA", "$250/mo HOA", "$250 monthly HOA" -- amount directly before the label.
    const before = s.match(/\$\s?([\d,]+)\s*(?:\/\s*mo\w*)?\s*(?:monthly\s+)?HOA/i);
    if (before) return toNumber(before[1]);

    // "HOA fee: $250", "HOA dues $250", "HOA: $250". Requires the $ sigil and allows
    // at most a few spaces, so a bare heading can't reach a distant number.
    const afterWithSigil = s.match(/HOA(?:\s*(?:fee|due|dues|assessment)s?)?\s*[:\-]?\s{0,3}\$\s?([\d,]+)/i);
    if (afterWithSigil) return toNumber(afterWithSigil[1]);

    // Unsigiled but explicitly labelled and punctuated: "HOA fee: 250". The fee word
    // plus the colon is what makes this safe -- a heading alone won't match.
    const labelled = s.match(/HOA\s*(?:fee|due|dues|assessment)s?\s*[:\-]\s{0,3}([\d,]+)/i);
    if (labelled) return toNumber(labelled[1]);

    return null;
  }

  /**
   * A dollar amount from a comp-search card or detail page: `"$2,100/mo"`, `"$369,500"`,
   * a bare `"425000"` (Redfin's detail-page stats have no $ sign), or `"$--"` (Zillow's
   * non-disclosure-state sold price). Returns null for the last of those -- there is no
   * honest number to report -- and otherwise `{ amount, monthly, approximate }`.
   *
   * `approximate` is true for an apartment complex's "from" price ("$1,200+/mo",
   * "$2,158+Fees may apply"): a "+" immediately after the digits, before any unit
   * suffix. Those are not one unit's rent and the caller rejects them for rent comps.
   *
   * `monthly` deliberately has no trailing word-boundary check. Zillow's card price
   * glues the next line straight on with no separator -- "$1,843/moFees may apply",
   * verified live -- so "mo" is immediately followed by a letter, not whitespace or
   * end-of-string. A `\bmo\b`-style match silently returned false there, which broke
   * the one thing that reads a genuine (non-"+") Zillow rental card as a rental at all.
   *
   * Abbreviated prices ("$1.10M", "$950K", verified live on a sold-search card) are
   * checked first: the plain-digits branch below stops at the decimal point, so
   * "$1.10M" would otherwise read as "$1" -- off by six orders of magnitude, and
   * exactly the kind of confidently-wrong number this module exists to avoid.
   * parseMoney in src/analysis.ts handles the same shape for the same reason; kept as
   * a second implementation because this file has no import graph to share one from.
   */
  function parseCompAmount(text) {
    const s = String(text ?? '');
    if (/\$\s*--/.test(s)) return null;

    const abbreviated = s.match(/\$?\s?([\d.,]+)\s*([MK])\b/i);
    if (abbreviated) {
      const base = Number(abbreviated[1].replace(/,/g, ''));
      if (!Number.isFinite(base) || base <= 0) return null;
      const afterAbbreviated = s.slice(abbreviated.index + abbreviated[0].length);
      return {
        amount: abbreviated[2].toUpperCase() === 'M' ? base * 1_000_000 : base * 1_000,
        monthly: /(?:\/\s*mo|per\s+month)/i.test(s),
        approximate: afterAbbreviated.startsWith('+')
      };
    }

    const match = s.match(/\$?\s?([\d,]+)/);
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const afterDigits = s.slice(match.index + match[0].length);
    return {
      amount,
      monthly: /(?:\/\s*mo|per\s+month)/i.test(s),
      approximate: afterDigits.startsWith('+')
    };
  }

  /** First number in a string, commas stripped. Used for stat cells with unit suffixes. */
  function firstNumber(text) {
    const m = String(text ?? '').match(/[\d,]+(?:\.\d+)?/);
    if (!m) return null;
    const n = m[0].replace(/,/g, '');
    return n === '' ? null : n;
  }

  /**
   * True when an element is actually rendered. Both sites hide parts of their action
   * bars responsively rather than removing them, so an injection target that merely
   * *exists* isn't good enough -- injecting into a display:none container puts the
   * button nowhere the user can click it.
   *
   * Note this is only meaningful in a real layout; jsdom reports zero-size for
   * everything, so callers must tolerate a null result there.
   */
  function isRendered(el) {
    if (!el || el.nodeType !== 1) return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    if (typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }

  /**
   * First candidate that is actually rendered; falls back to the first that merely
   * exists. The fallback matters under jsdom (no layout) and for containers that are
   * momentarily zero-size mid-render.
   */
  function firstUsable(candidates) {
    const present = candidates.filter(Boolean);
    return present.find(isRendered) ?? present[0] ?? null;
  }

  /** Resolves a possibly-relative href against an origin. Returns null when unusable. */
  function absoluteUrl(href, origin) {
    if (!href) return null;
    try {
      return new URL(href, origin).href;
    } catch {
      return null;
    }
  }

  /** The pathname of a possibly-relative href, for id extraction. */
  function pathnameOf(href, origin) {
    if (!href) return null;
    try {
      return new URL(href, origin).pathname;
    } catch {
      return href;
    }
  }

  return {
    redfinPropertyId,
    zillowPropertyId,
    parseBedBathSqft,
    separatedText,
    parseHoa,
    parseMoneyAmount,
    parseCompAmount,
    firstNumber,
    isRendered,
    firstUsable,
    absoluteUrl,
    pathnameOf
  };
})();

// Make the module usable from Node (tests) as well as as a content script.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SidecarParsers;
}
