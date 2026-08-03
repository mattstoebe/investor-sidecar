/**
 * Site-agnostic driver. Picks an adapter by hostname and runs the same injection,
 * click and save flow for every supported site. All per-site selectors live in
 * scripts/sites/<site>.js -- nothing here should reference Redfin or Zillow markup.
 */
const LOG_PREFIX = '[Investor Sidecar]';
const OBSERVER_OPTIONS = { childList: true, subtree: true };
/** Bump when shipping a change that needs to be confirmed as loaded in the browser. */
const SIDECAR_BUILD = '2026-08-03.1';

const ADAPTERS = [RedfinAdapter, ZillowAdapter, HomesAdapter];
const site = ADAPTERS.find(a => a.matchesHost(window.location.hostname)) ?? null;

function ensureCalculatorStyles() {
  if (document.getElementById('calculator-styles')) return;

  const style = document.createElement('style');
  style.id = 'calculator-styles';
  style.dataset.sidecar = '1';
  // Content-script globals live in an isolated world and can't be read from the page,
  // so the injected stylesheet carries the build marker used to confirm what's loaded.
  style.dataset.sidecarBuild = SIDECAR_BUILD;
  style.textContent = `
      .bp-CalculatorExtension {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        cursor: pointer;
        pointer-events: auto !important;
        position: relative;
        /* Zillow's results cards are covered by a stretched link. Without a stacking
           order of our own it wins the hit test and the click never reaches us. */
        z-index: 2;
      }
      .bp-CalculatorExtension .bp-SvgIcon { display: block; }
      .bp-CalculatorExtension[data-state="working"] { opacity: 0.55; }
      .bp-CalculatorExtension[data-state="saved"] { color: #1E6E52; }
      .bp-CalculatorExtension[data-state="error"] { color: #A6402C; }
      .bp-CalculatorExtension[data-state="saved"] svg,
      .bp-CalculatorExtension[data-state="error"] svg { fill: currentColor; }

      /* Two self-contained variants, for sites whose own button classes we can't borrow
         (Zillow's are hashed styled-components names that change per deploy).
         Both are borderless: the old pill outline read as a black circle that sat out of
         alignment with the plain icons either site puts in its action rows.

         Sized explicitly and pinned against flex growth: in Zillow's mobile layout
         the button lands in a chip row that stretched it to 171x46. */
      .sidecar-Button--icon,
      .sidecar-Button--action {
        box-sizing: border-box;
        flex: 0 0 auto !important;
        align-self: center !important;
        width: auto !important;
        max-width: max-content;
        height: 30px;
        min-height: 0;
        border: 0;
        background: transparent;
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 1;
        white-space: nowrap;
      }
      /* Icon-only, for result cards: matches the ink of the "..." and heart it sits beside. */
      .sidecar-Button--icon {
        padding: 0 4px;
        color: #2A2A33;
      }
      /* Icon + label, for detail action bars. Navy reads as an action rather than as
         another of the page's neutral controls. */
      .sidecar-Button--action {
        padding: 0 6px;
        color: #153E75;
      }
      .sidecar-Button--icon svg,
      .sidecar-Button--action svg { width: 18px; height: 18px; flex: 0 0 auto; }
      .sidecar-ActionWrapper {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        /* No left margin: the wrapper is no longer always last in the action row. */
        margin: 0 8px 0 0;
        /* It may be an <li> in the site's own action list. */
        list-style: none;
      }

      /* Comp mode: same button, a distinct accent so "Add as comp" reads as a different
         action from Analyze without a wider layout change. Excluded on saved/error --
         those states have their own semantic colors (green/red) and, at equal
         selector specificity, whichever rule is declared later in this sheet would
         otherwise win regardless of which one is more important to see right now. */
      .bp-CalculatorExtension[data-sidecar-comp="1"]:not([data-state="saved"], [data-state="error"]) {
        color: #6D28D9;
      }
      .bp-CalculatorExtension[data-sidecar-comp="1"]:not([data-state="saved"], [data-state="error"]) svg {
        fill: currentColor;
      }

      /* Homes.com's map popup groups its native controls at the top right, unlike
         ordinary results-card actions. Position this map-only calculator in that
         same cluster instead of leaving it alone above the price. */
      .click-card-container .sidecar-MapPopupCalculator {
        position: absolute;
        top: 12px;
        right: 112px;
        z-index: 2;
      }

      /* The session banner. A small fixed pill in a page corner, not a full-width bar:
         an earlier version spanned the top of the viewport and sat on top of Redfin's
         own sticky filter row, blocking it entirely -- confirmed live. A corner pill is
         far less likely to collide with a site's own chrome, at the cost of being a
         little easier to overlook; Done still being the only way to dismiss it (see
         ensureCompBanner) is what keeps that acceptable. */
      #sidecar-comp-banner {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        max-width: min(360px, calc(100vw - 24px));
        border-radius: 8px;
        background: #1E1B4B;
        color: #fff;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.4;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      }
      #sidecar-comp-banner-done {
        flex: 0 0 auto;
        border: 1px solid rgba(255, 255, 255, 0.4);
        background: transparent;
        color: #fff;
        border-radius: 4px;
        padding: 4px 12px;
        font-size: 13px;
        cursor: pointer;
      }
      #sidecar-comp-banner-done:hover { background: rgba(255, 255, 255, 0.12); }

      .bp-CalculatorExtension__flash {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 50%;
        transform: translateX(-50%);
        background: #14171C;
        color: #fff;
        font-size: 12px;
        line-height: 1.35;
        padding: 5px 8px;
        border-radius: 4px;
        white-space: normal;
        width: max-content;
        max-width: 220px;
        z-index: 2147483647;
        pointer-events: none;
      }

      .sidecar-MapPin {
        position: absolute;
        width: 40px;
        height: 54px;
        padding: 0;
        border: 0;
        background: transparent;
        transform: translate(-50%, -100%);
        transform-origin: 50% 100%;
        filter: drop-shadow(0 3px 5px rgba(0, 0, 0, .55));
        cursor: pointer;
        pointer-events: auto;
        z-index: 900;
        overflow: visible;
      }
      .sidecar-MapPin::after {
        content: "";
        position: absolute;
        left: 50%;
        bottom: -2px;
        width: 12px;
        height: 5px;
        margin-left: -6px;
        border-radius: 50%;
        background: rgba(255, 20, 147, .65);
        animation: sidecar-pin-pulse 1.8s ease-out infinite;
      }
      .sidecar-MapPin:hover,
      .sidecar-MapPin:focus-visible,
      .sidecar-MapPin.sidecar-MapPin--active {
        transform: translate(-50%, -100%) scale(1.15);
        outline: none;
        z-index: 950;
      }
      @keyframes sidecar-pin-pulse {
        from { transform: scale(.6); opacity: .65; }
        to { transform: scale(2.6); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .sidecar-MapPin::after { animation: none; }
      }
    `;
  document.head.appendChild(style);
}

/**
 * Reports the outcome of a click on the button itself. Failures used to go to a
 * console nobody had open, making a dead button indistinguishable from a working one.
 */
function setCalculatorState(wrapper, state, message) {
  if (!wrapper) return;
  wrapper.dataset.state = state;
  wrapper.setAttribute('title', message || (state === 'saved' ? 'Added to Investor Sidecar' : 'Analyze with Investor Sidecar'));

  wrapper.querySelector('.bp-CalculatorExtension__flash')?.remove();
  clearTimeout(wrapper._sidecarFlashTimer);

  if (state === 'saved' || state === 'error') {
    const flash = document.createElement('span');
    flash.dataset.sidecar = '1';
    flash.className = 'bp-CalculatorExtension__flash';
    flash.textContent = message || (state === 'saved' ? 'Added' : 'Could not read this listing');
    wrapper.appendChild(flash);
    wrapper._sidecarFlashTimer = setTimeout(() => {
      flash.remove();
      wrapper.dataset.state = 'idle';
    }, state === 'error' ? 4000 : 1800);
  }
}

const CALCULATOR_ICON = `
    <svg class="bp-SvgIcon share calculator bp-SvgIcon__size--medium" viewBox="0 0 24 24" aria-hidden="true">
        <path fill-rule="evenodd" clip-rule="evenodd" d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 14h-2v-2h2v2zm0-4h-2v-2h2v2zm-4 4h-2v-2h2v2zm0-4h-2v-2h2v2zm-4 4H6v-2h2v2zm0-4H6v-2h2v2zm10-6H6V5h12v2z"></path>
    </svg>
`;

/** Marks the button as ours and carries the capture handler. */
const BUTTON_SELECTOR = '.bp-CalculatorExtension';

const consumeEvent = (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
};

/** Runs the button's capture, drawing the outcome on the button rather than logging it. */
async function activateButton(button) {
  if (button.dataset.busy === 'true') return;

  button.dataset.busy = 'true';
  setCalculatorState(button, 'working');
  try {
    const outcome = await button._sidecarCapture?.();
    if (outcome && outcome.ok === false) {
      setCalculatorState(button, 'error', outcome.reason);
    } else {
      // Comp mode passes its own message ("Added as a comp") -- "Added to Investor
      // Sidecar" would be wrong there, since nothing new joined the house list.
      setCalculatorState(button, 'saved', outcome?.message || 'Added to Investor Sidecar');
    }
  } catch (error) {
    setCalculatorState(button, 'error', error?.message || 'Something went wrong');
  } finally {
    button.dataset.busy = 'false';
  }
}

/**
 * Swallows every interaction that lands on one of our buttons, before the page sees it.
 *
 * These listeners are on `window`, the first node in the capture path, and content.js is
 * loaded at document_start. Zillow routes a card from its own window-capture listener;
 * listening on document was already too late -- Zillow had called history.pushState()
 * before our preventDefault ran, so the house was saved and then annoyingly opened.
 *
 * pointerup is in the list because Pointer Events fire ahead of their compatibility mouse
 * events, so a router listening for pointerup navigates before a mouseup handler could
 * stop it. touchstart/touchend need passive:false explicitly -- Chrome makes
 * document-level touch listeners passive by default, which silently no-ops preventDefault.
 */
let interceptorsInstalled = false;

function installButtonInterceptors() {
  if (interceptorsInstalled) return;
  interceptorsInstalled = true;

  const ourButton = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    return target.closest(BUTTON_SELECTOR);
  };

  window.addEventListener('click', (e) => {
    const button = ourButton(e);
    if (!button) return;
    consumeEvent(e);
    activateButton(button);
  }, true);

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick']) {
    window.addEventListener(type, (e) => {
      if (ourButton(e)) consumeEvent(e);
    }, true);
  }

  for (const type of ['touchstart', 'touchend']) {
    window.addEventListener(type, (e) => {
      if (ourButton(e)) consumeEvent(e);
    }, { capture: true, passive: false });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const button = ourButton(e);
    if (!button) return;
    consumeEvent(e);
    activateButton(button);
  }, true);
}

// Install before either site's application has a chance to register its delegated card
// router. The handler is inert until a Sidecar button exists, so doing this at
// document_start has no effect on ordinary page interactions.
installButtonInterceptors();

/**
 * Builds the button. `clickHandler` returns { ok, reason } so the outcome can be
 * drawn on the button rather than logged. Activation is handled by the window-level
 * interceptors above; the handler is stashed on the element for them to find.
 *
 * `ariaLabel` and `comp` exist for comp mode: a distinct accessible name ("Add as comp
 * for 8109 Ferndale Dr") and a marker attribute the injected stylesheet colors
 * differently, so a comp-mode button reads as a different action from Analyze without
 * touching the injection/dedupe machinery that places it.
 */
function createCalculatorElement(clickHandler, { className, label, ariaLabel, comp } = {}) {
  ensureCalculatorStyles();
  installButtonInterceptors();

  const wrapper = document.createElement('div');
  wrapper.dataset.sidecar = '1';
  wrapper.className = className || 'bp-CalculatorExtension';
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('tabindex', '0');
  wrapper.setAttribute('aria-label', ariaLabel || 'Analyze with Investor Sidecar');
  if (comp) wrapper.dataset.sidecarComp = '1';
  wrapper.innerHTML = CALCULATOR_ICON;
  wrapper._sidecarCapture = clickHandler;

  if (label) {
    const labelSpan = document.createElement('span');
    labelSpan.dataset.sidecar = '1';
    labelSpan.textContent = label;
    wrapper.appendChild(labelSpan);
  }

  return wrapper;
}

/**
 * Whether a scraped property id is usable as storage identity.
 *
 * 'N/A' and null are both rejected: a non-numeric id used to be stored anyway and every
 * such house collided on one key, silently discarding all but the first.
 *
 * The digits-only rule is the default, not the law. Redfin and Zillow ids are bare digits,
 * but Homes.com keys are alphanumeric ("vff9j5680b68l"), so an adapter may declare its own
 * validator and only the site that needs it opts in -- widening the rule globally would
 * quietly drop the protection for the two sites that do satisfy it.
 *
 * Deliberately one function called from all three gates (here, buildComp, and
 * isCompEligibleCard). They were three separate copies of the same regex, which is how the
 * comp path silently refused every Homes.com card while ordinary Analyze accepted it.
 */
function propertyIdIsUsable(propertyID) {
  return typeof site?.isValidPropertyId === 'function'
    ? Boolean(site.isValidPropertyId(propertyID))
    : /^\d+$/.test(String(propertyID ?? ''));
}

const StorageManager = {
  async saveHouse(houseData) {
    if (!propertyIdIsUsable(houseData?.propertyID)) {
      return { ok: false, reason: "Couldn't identify this listing. Open the listing page and try there." };
    }
    try {
      const response = await chrome.runtime.sendMessage({ action: 'addHouse', house: houseData });
      if (!response?.ok) {
        return { ok: false, reason: response?.reason || 'Extension did not confirm the save.' };
      }
      return { ok: true, added: response.added };
    } catch (error) {
      return { ok: false, reason: `Couldn't save: ${error?.message || 'extension not responding'}` };
    }
  }
};

const handleCapture = async (extract, missingDataReason) => {
  try {
    const houseData = extract();
    if (!houseData) {
      return { ok: false, reason: missingDataReason };
    }
    return await StorageManager.saveHouse(houseData);
  } catch (error) {
    return { ok: false, reason: error?.message || 'Something went wrong saving this house.' };
  }
};

/**
 * Comp mode. See docs/comp-workflow.md §3 for the design this implements.
 *
 * Whether *this* tab is in comp mode -- and for which house and kind -- is decided by
 * the worker, not this script: only the worker can tell one tab from another. `compSession`
 * mirrors the worker's answer and is refreshed at init and on chrome.storage.onChanged;
 * every reader below reads this live variable at call time, not a value captured when a
 * button was created, so a session that starts or ends *after* a button was injected is
 * still respected -- injected identity (label, color) may lag a beat, but click routing
 * never does.
 */
let compSession = null;

/** The short form of the subject's address, for a button's accessible name and the banner. */
function compSubjectStreet() {
  return compSession?.subject?.address?.split(',')[0]?.trim() || 'this house';
}

function compCardAriaLabel() {
  return `Add as comp for ${compSubjectStreet()}`;
}

/** "$425,000" as-is; a bare "425000" (Redfin's detail-page stats carry no $ sign) gets one. */
function displayCompPrice(price) {
  const s = String(price ?? '').trim();
  if (!s) return null;
  if (s.startsWith('$')) return s;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? `$${n.toLocaleString()}` : s;
}

/**
 * Turns extracted listing data -- plus, for a results-page card, its compFacts -- into a
 * Comp for the active session, or a reason the click can't proceed. The single place the
 * non-disclosure and "from price" rules live, so card and detail-page capture agree.
 *
 * `facts` is null for a detail page (there is no separate compFacts method for one --
 * extractFromDetailPage's own `price` field already carries whatever the header shows,
 * which is the true sold price even where the equivalent card only had last-list) and
 * for the Redfin table-view extra, which has no card element to re-query.
 */
function buildComp(houseData, facts, session) {
  if (!houseData) return { ok: false, reason: "Couldn't read this listing's details." };
  if (!propertyIdIsUsable(houseData.propertyID)) {
    // Not "open the listing page and try there" -- that's the ordinary-Analyze advice,
    // and in comp mode it's actively wrong: navigating in is what a session doesn't
    // reliably survive (see docs/comp-workflow.md's known limitations).
    return { ok: false, reason: "Couldn't identify this listing from its card." };
  }
  const parsed = SidecarParsers.parseCompAmount(facts ? facts.amountText : houseData.price);
  if (!parsed) {
    return {
      ok: false,
      reason: session.kind === 'sold'
        ? 'No sold price shown. Try Redfin, or open the listing.'
        : "Couldn't read this listing's price."
    };
  }
  // A "from" price (a multi-unit complex's "starting at" listing) is not one unit's
  // rent -- reject on the "+" marker alone. This used to also block any Redfin URL
  // containing "/apartment/" outright, which turned out too broad: it rejected
  // legitimate single-unit apartment listings along with the multi-listing ones, and
  // "+" is the actual signal (both sites' recorded fixtures agree a "starting at"
  // price carries it) -- the URL says the building has apartments, not that this
  // specific price is aggregated.
  if (session.kind === 'rent' && parsed.approximate) {
    return { ok: false, reason: 'This looks like a "from" price, not one unit\'s rent.' };
  }

  // The session's kind has to match what the page is actually showing. Both sites let the
  // user flip For Sale / Sold / For Rent from the results page itself, and doing so does
  // not end the session -- so a sold session can end up looking at rental cards. Reported
  // live. Silently accepting one stores a monthly rent as a sale price (or, worse, a
  // $369,500 sale price as a monthly rent), which then drives ARV or cash flow.
  if (session.kind === 'sold' && parsed.monthly) {
    return { ok: false, reason: "That's a rental price. This session is collecting sold comps." };
  }
  // Only enforced when a card's own price text is in hand: a Zillow *detail* page's price
  // comes from ld+json as a clean number carrying no "/mo" at all (see
  // ZillowAdapter.isRentalDetailPage), so requiring the suffix there would reject every
  // legitimate rent comp added from a listing page.
  if (session.kind === 'rent' && facts && !parsed.monthly) {
    return { ok: false, reason: "That's not a rental price. This session is collecting rent comps." };
  }

  const capturedStatus = session.kind === 'rent'
    ? 'rental'
    : listingStatus({ detail: !facts, houseData, facts });
  const amountLabel = session.kind === 'rent'
    ? 'rent'
    : capturedStatus === 'active'
      ? 'list'
      // Redfin's sold cards say "Last list price" in every non-disclosure state (recon:
      // zip 78745, TX); label honestly rather than implying a sold price that never rendered.
      : (site.id === 'redfin'
        ? (/sold/i.test(facts?.priceLabel || '') ? 'sold' : 'last-list')
        : 'sold');

  const soldDate = session.kind === 'sold'
    ? facts?.soldDateText?.match(/SOLD ([A-Z]{3} \d+, \d{4})/i)?.[1] ?? null
    : null;

  return {
    ok: true,
    comp: {
      source: site.id,
      propertyID: houseData.propertyID,
      kind: session.kind,
      address: houseData.address,
      amount: parsed.amount,
      amountLabel,
      ...(session.kind === 'sold'
        ? { listingStatus: capturedStatus === 'active' ? 'active' : 'sold' }
        : {}),
      beds: houseData.beds,
      baths: houseData.baths,
      sqft: houseData.sqft,
      url: houseData.url,
      soldDate,
      capturedAt: Date.now()
    }
  };
}

/**
 * A lighter version of buildComp's early checks, run before injecting a button on a
 * results-page card so a listing already known to be disqualified -- chiefly an
 * apartment complex's "from" price -- shows no button at all, rather than a purple one
 * that can only ever error on click. Real search pages populate a thin zip/beds/baths
 * filter with these under a "here are some other apartments nearby" fallback section
 * when the exact filter has few or no results; a working-looking button there that
 * always fails read as the extension being broken, not the listing being unsuitable.
 *
 * Detail pages and the Redfin table-view extra have no card to pre-check here, so they
 * still rely on buildComp's own gate at click time -- this is strictly a subset of that
 * gate, applied earlier, not a replacement for it.
 */
function isCompEligibleCard(cardEl, kind) {
  const houseData = site.extractFromCard(cardEl);
  if (!houseData || !propertyIdIsUsable(houseData.propertyID)) return false;

  const facts = site.compFacts?.(cardEl);
  const parsed = SidecarParsers.parseCompAmount(facts?.amountText ?? houseData.price);
  // A button that can only fail is misleading. This covers "Price on request" and
  // non-disclosure "$--" cards; opening a detail page may expose a usable amount later.
  if (!parsed) return false;

  if (kind === 'rent' && parsed.approximate) return false;
  // Kind mismatch, same case buildComp guards: the user flipped the site's own
  // For Sale / Sold / For Rent toggle without leaving the session. Withholding the
  // button entirely beats a purple one that can only ever refuse.
  if (kind === 'sold' && parsed.monthly) return false;
  if (kind === 'rent' && !parsed.monthly) return false;
  return true;
}

/**
 * Whether a listing's own price reads as a monthly rent ("$4,500/mo") rather than a
 * purchase price ("$425,000"). The ordinary (non-comp) Analyze flow feeds a house's
 * price straight into the buy-and-hold/flip/BRRRR purchase-price calculator, so
 * capturing a rental listing there produces a nonsensical "$4,500 house" -- a mistake
 * that was unreachable before comp mode existed to send anyone to a rentals search at
 * all. Both sites' card price text preserves the "/mo" suffix (verified in
 * docs/comp-workflow.md's recon), so this needs no new selector.
 *
 * Comp mode is unaffected by this check: capturing a rental's price is exactly the
 * point there, and buildComp already validates it on comp mode's own terms.
 */
function looksLikeRentalPrice(priceText) {
  return SidecarParsers.parseCompAmount(priceText)?.monthly === true;
}

/**
 * The listing state is a domain fact, not a side effect of the current comp session.
 * Adapters may provide a stronger site-specific verdict; the shared fallback handles
 * the signals common to all three card implementations.
 */
function listingStatus({ cardEl = null, detail = false, houseData = null, facts = null } = {}) {
  const adapterStatus = detail
    ? site.listingStatusFromDetail?.()
    : site.listingStatusFromCard?.(cardEl);
  if (['active', 'sold', 'rental', 'unknown'].includes(adapterStatus)) return adapterStatus;

  if (detail && site.isRentalDetailPage?.()) return 'rental';
  const price = facts?.amountText ?? houseData?.price;
  if (looksLikeRentalPrice(price)) return 'rental';

  const pageUrl = `${window.location.pathname}${window.location.search}`;
  if (!detail && /(?:recently[_-]sold|include=sold|sold-\d+mo)/i.test(pageUrl)) return 'sold';
  if (!detail && /(?:for[_-]rent|\/rentals?(?:\/|$)|rent-homes)/i.test(pageUrl)) return 'rental';

  const evidence = [
    facts?.priceLabel,
    facts?.soldDateText,
    cardEl ? SidecarParsers.separatedText(cardEl) : null,
    detail
      ? Array.from(document.querySelectorAll(
          '[data-testid*="status"], [data-rf-test-name*="status"], '
          + '.ListingStatusBannerSection, .status-pill, [class*="listing-status"]'
        )).slice(0, 12).map((el) => SidecarParsers.separatedText(el)).join(' ')
      : null
  ].filter(Boolean).join(' ');
  if (/\b(?:sold|last list price)\b/i.test(evidence)) return 'sold';

  return houseData ? 'active' : 'unknown';
}

/**
 * The single policy every injection surface follows. A sale-comp hunt starts on sold
 * results but deliberately accepts active listings too; their amount is labelled as a
 * list price when captured.
 */
function actionForListing(status, session) {
  if (!session) return status === 'active' ? 'analyze' : 'none';
  if (session.kind === 'rent') return status === 'rental' ? 'rent-comp' : 'none';
  return status === 'active' || status === 'sold' ? 'sale-comp' : 'none';
}

/**
 * `extract`/`factsFn` mirror handleCapture's `extract`: zero-argument functions run at
 * click time, not closed over eagerly, so a click always reads the DOM as it is then.
 */
function handleCompCapture(extract, factsFn) {
  return async () => {
    // Read fresh, not a value captured when this closure was built -- the whole point
    // of routing through the live variable. See the comment above `compSession`.
    const session = compSession;
    if (!session) return { ok: false, reason: 'Comp session ended. Reload the page to try again.' };
    try {
      const built = buildComp(extract(), factsFn ? factsFn() : null, session);
      if (!built.ok) return built;

      const response = await chrome.runtime.sendMessage({
        action: 'addComp', targetKey: session.targetKey, comp: built.comp
      });
      if (!response?.ok) {
        return { ok: false, reason: response?.reason || 'Extension did not confirm the save.' };
      }
      if (response.added === false) {
        return { ok: false, reason: response.reason || 'Already added' };
      }
      return { ok: true, message: 'Added as a comp' };
    } catch (error) {
      return { ok: false, reason: error?.message || 'Something went wrong saving this comp.' };
    }
  };
}

/** Builds or updates the always-visible "what am I comping against" strip. The banner is
 *  the stand-in for a map pin (see docs/comp-workflow.md §5); Done is deliberately the
 *  only way to dismiss it, because a separate close-X would leave the tab in comp mode
 *  with no visible indication that every "Analyze"-looking click still adds a comp. */
function ensureCompBanner() {
  let banner = document.getElementById('sidecar-comp-banner');
  if (!compSession) {
    banner?.remove();
    return;
  }

  const { subject, kind } = compSession;
  const factsText = [subject?.beds && `${subject.beds}bd`, subject?.baths && `${subject.baths}ba`]
    .filter(Boolean).join('/');
  const sqftText = subject?.sqft && Number(subject.sqft) > 0
    ? `${Number(subject.sqft).toLocaleString()} sqft`
    : null;

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'sidecar-comp-banner';
    banner.dataset.sidecar = '1';
    document.body.appendChild(banner);
  }
  banner.innerHTML = '';

  const text = document.createElement('span');
  text.dataset.sidecar = '1';
  text.textContent = [
    `Adding ${kind === 'sold' ? 'sale' : 'rent'} comps for ${compSubjectStreet()}`,
    displayCompPrice(subject?.price),
    factsText || null,
    sqftText
  ].filter(Boolean).join(' — ');
  banner.appendChild(text);

  const done = document.createElement('button');
  done.type = 'button';
  done.dataset.sidecar = '1';
  done.id = 'sidecar-comp-banner-done';
  done.textContent = 'Done';
  done.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'endCompSession' }, () => { void chrome.runtime.lastError; });
  });
  banner.appendChild(done);
}

/**
 * Removes every injected button so the next processPage() pass rebuilds them with the
 * identity (label, color, click routing) the current session implies. Buttons carry
 * their handler at creation time, so this is how a session change -- start, Done,
 * replacement -- reaches buttons injected before it happened. Precedent: processPage's
 * own stale-card sweep on navigation does the same "remove and let the next pass
 * reinject" move for the same reason.
 */
function sweepInjectedButtons() {
  document.querySelectorAll('.bp-CalculatorExtension').forEach(removeInjectedButton);
  lastCleanedUrl = null;
}

/** Asks the worker whether this tab is in comp mode. Only the worker can answer that --
 *  it compares sender.tab.id against the session's tracked tabIds (which grows to cover
 *  a tab opened from one already in it -- see background.js's tabs.onCreated listener),
 *  and a content script has no other reliable way to learn its own tab id. */
async function refreshCompSession() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ action: 'getCompSession' });
  } catch {
    response = null;
  }
  applyCompSession(response?.session ?? null);
}

/** Apply a session received either from the worker query or its post-navigation handoff.
 * The direct handoff closes the last timing hole on very fast result pages: content scripts
 * are ready at document_start, but their UI work must still wait until a body exists. */
function applyCompSession(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(compSession);
  compSession = next;
  if (changed) {
    sweepInjectedButtons();
    if (document.body) {
      ensureCompBanner();
      processPage();
    }
  }
}

/**
 * `insertAfter` places us next to a specific sibling; `position: 'prepend'` puts us first
 * in the container. Prepending matters where the container overflows: Redfin's detail
 * action row scrolls its own content at narrow widths, so an appended button ended up
 * past the right edge of the page with no way to reach it.
 */
function injectInto({ container, insertAfter, position }, button) {
  if (!container || container.querySelector('.bp-CalculatorExtension')) return false;
  if (insertAfter && insertAfter.parentElement === container) {
    container.insertBefore(button, insertAfter.nextSibling);
  } else if (position === 'prepend') {
    container.insertBefore(button, container.firstChild);
  } else {
    container.appendChild(button);
  }
  return true;
}

function ensureCalculatorOnCard(cardEl) {
  // Do not cache a rejection. Zillow reuses a card element while replacing its loading
  // skeleton with the real link and price; permanently remembering the early "no link"
  // verdict is what made some valid individual rentals never receive a comp button.
  if (!site.isInjectableCard(cardEl)) return;

  const houseData = site.extractFromCard(cardEl);
  const facts = site.compFacts?.(cardEl) ?? null;
  const status = listingStatus({ cardEl, houseData, facts });
  const action = actionForListing(status, compSession);
  if (action === 'none') return;
  if (compSession && !isCompEligibleCard(cardEl, compSession.kind)) return;

  const target = site.cardInjectionTarget(cardEl);
  if (!target?.container || target.container.querySelector('.bp-CalculatorExtension')) return;

  const button = compSession
    ? createCalculatorElement(
        handleCompCapture(() => site.extractFromCard(cardEl), () => site.compFacts?.(cardEl)),
        { className: site.cardButtonClassName, ariaLabel: compCardAriaLabel(), comp: true }
      )
    : createCalculatorElement(
        () => handleCapture(() => site.extractFromCard(cardEl), "Couldn't read this listing's details."),
        { className: site.cardButtonClassName }
      );
  injectInto(target, button);
}

/** Removes one of our buttons along with the wrapper we added around it, if any. */
function removeInjectedButton(button) {
  const wrapper = button.closest('.sidecar-ActionWrapper, .HomeControlButtonWrapper');
  (wrapper && wrapper.querySelectorAll('.bp-CalculatorExtension').length === 1 ? wrapper : button).remove();
}

function ensureCalculatorOnDetailPage(houseData) {
  houseData ??= site.extractFromDetailPage();
  const target = site.detailInjectionTarget();
  if (!target?.container) return;
  const { container } = target;

  // Exactly one button, and it must be in the *current* target. Responsive layout
  // moves that target -- Zillow swaps its desktop action bar for a mobile one, Redfin
  // drops the pill bar entirely -- and injecting into the new target without clearing
  // the old one left a duplicate behind on every swap. Dragging the panel divider
  // sweeps through those breakpoints repeatedly, so they accumulated.
  let existing = null;
  for (const button of document.querySelectorAll('.bp-CalculatorExtension')) {
    if (!existing && container.contains(button)) {
      existing = button;
    } else {
      removeInjectedButton(button);
    }
  }
  if (existing) return;

  const status = listingStatus({ detail: true, houseData });
  if (actionForListing(status, compSession) === 'none') return;

  // Matches the container's own item type. Zillow's action bar is a <ul> whose items are
  // <li>, and a <div> dropped in there doesn't participate in the row layout -- the button
  // stacked underneath Save instead of sitting beside it.
  const isList = container.tagName === 'UL' || container.tagName === 'OL';
  const wrapper = document.createElement(isList ? 'li' : 'div');
  wrapper.dataset.sidecar = '1';
  wrapper.className = site.detailWrapperClassName || '';
  const button = compSession
    ? createCalculatorElement(
        // No compFacts here: extractFromDetailPage's own `price` already carries
        // whatever the header shows, which is the true sold price even where the
        // equivalent card only had last-list (docs/comp-workflow.md §3).
        handleCompCapture(() => site.extractFromDetailPage(), null),
        { className: site.detailButtonClassName, label: 'Add as comp', ariaLabel: compCardAriaLabel(), comp: true }
      )
    : createCalculatorElement(
        () => handleCapture(() => site.extractFromDetailPage(), "Couldn't read this listing's details."),
        { className: site.detailButtonClassName, label: 'Analyze' }
      );
  wrapper.appendChild(button);
  // The wrapper carries our class, not the button, so injectInto's own dedupe check
  // (which looks for the button class inside the container) still applies to it.
  injectInto(target, wrapper);
}

let lastDetailEnrichmentSignature = null;
let detailEnrichmentInFlight = null;

function enrichTrackedHouseFromDetail(houseData) {
  if (!houseData?.propertyID || !houseData.details) return;
  const signature = `${window.location.href}\u0000${JSON.stringify(houseData)}`;
  if (signature === lastDetailEnrichmentSignature || signature === detailEnrichmentInFlight) return;

  detailEnrichmentInFlight = signature;
  chrome.runtime.sendMessage({ action: 'enrichHouseFromPage', house: houseData }, (response) => {
    void chrome.runtime.lastError;
    if (response?.ok) lastDetailEnrichmentSignature = signature;
    if (detailEnrichmentInFlight === signature) detailEnrichmentInFlight = null;
  });
}

/** Guards the stale-card sweep so it runs once per page, not once per mutation batch. */
let lastCleanedUrl = null;

const processPage = () => {
  if (!site) return;
  scheduleMapReconcile();
  backfillVisibleMapCoordinates();

  // Detail pages get exactly one Analyze button in the header, and deliberately no
  // buttons on the "similar homes" cards below -- clicking one of those would add a
  // different property than the one being viewed.
  if (site.isDetailPage()) {
    // Both sites are SPAs: navigating from a results page to a listing leaves the
    // previous view's cards (and our buttons in them) in the DOM. Observed live on
    // Zillow with 8 stale card buttons on a detail page. Remove them, or clicking one
    // silently captures a property other than the one on screen.
    //
    // Once per URL, not once per pass: this mutates the DOM, and doing it on every
    // observer firing turned a resize into a remove/re-add storm.
    if (lastCleanedUrl !== window.location.href) {
      for (const card of site.findCardElements()) {
        card.querySelectorAll('.bp-CalculatorExtension').forEach(b => b.remove());
      }
      lastCleanedUrl = window.location.href;
    }
    const houseData = site.extractFromDetailPage();
    enrichTrackedHouseFromDetail(houseData);
    ensureCalculatorOnDetailPage(houseData);
    return;
  }

  site.findCardElements().forEach(ensureCalculatorOnCard);

  for (const extra of site.extraInjectionTargets()) {
    if (extra.container.querySelector('.bp-CalculatorExtension')) continue;
    const houseData = extra.extract();
    const facts = extra.compFacts?.() ?? null;
    const status = extra.listingStatus?.() ?? listingStatus({ houseData, facts });
    if (actionForListing(status, compSession) === 'none') continue;
    if (compSession && extra.isCompEligible?.(compSession.kind) === false) continue;
    const button = compSession
      ? createCalculatorElement(
          handleCompCapture(extra.extract, extra.compFacts),
          { className: extra.className || site.cardButtonClassName, ariaLabel: compCardAriaLabel(), comp: true }
        )
      : createCalculatorElement(
          () => handleCapture(extra.extract, extra.missingDataReason),
          { className: extra.className || site.cardButtonClassName }
        );
    injectInto(extra, button);
  }
};

// The normal storage/query path remains the source of truth. This is a targeted second
// delivery path from the worker after a freshly-created comp tab finishes navigating, so
// a fast Homes.com result page cannot be stranded outside its just-created session.
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === 'setCompSession') {
    applyCompSession(request.session ?? null);
    sendResponse?.({ ok: true });
    return;
  }
  if (request?.action === 'highlightMapHouse' || request?.action === 'focusMapHouse') {
    activeMapHouseKey = typeof request.key === 'string' ? request.key : null;
    applyActiveMapHouse();
    const pin = [...document.querySelectorAll(MAP_PIN_SELECTOR)]
      .find((candidate) => candidate.dataset.sidecarHouseKey === activeMapHouseKey);
    if (request.action === 'focusMapHouse' && pin instanceof HTMLElement) {
      pin.focus({ preventScroll: true });
    }
    sendResponse?.({ ok: true, visible: Boolean(pin) });
  }
});

/**
 * True for nodes we injected ourselves. Every such node carries data-sidecar, so this
 * is a single property read.
 *
 * It used to call node.closest('.bp-CalculatorExtension'), which walks up the tree for
 * every added and removed node. This function runs inside the MutationObserver
 * callback, which fires synchronously on the site's own DOM churn -- during a resize
 * that is thousands of nodes, and the tree walks landed directly in the page's resize
 * path, slowing the site's own relayout.
 */
function isOurNode(node) {
  return node.nodeType === 1 && node.dataset?.sidecar === '1';
}

/**
 * Map pins (docs/map-linking.md Option 3): puts our own marker on the site's live map
 * for every saved house with real coordinates -- regardless of which site captured it,
 * since the projection only needs a lat/lon and the site's own current map. Deliberately
 * never pans or zooms the site's own map; a house whose projected point falls outside
 * the visible map container simply gets no pin (see reconcileMapPins below), which is
 * the "N of M houses shown on this map" the panel surfaces rather than a forced move.
 *
 * Off entirely for a page whose adapter cannot currently build a projection.
 */
const MAP_PIN_SELECTOR = '[data-sidecar-pin="1"]';
const NATIVE_MAP_PIN_SELECTOR = '[data-sidecar-native-pin="1"]';

/** Mirrors house-storage.js's houseKey(). Duplicated, not imported: content scripts run
 *  as plain scripts, not ES modules, so they can't import the background worker's module.
 *  Keep this in sync with house-storage.js if that format ever changes. */
function mapHouseKey(house) {
  return `${house?.source || 'redfin'}:${house?.propertyID}`;
}

function hasMapCoords(house) {
  return Number.isFinite(house?.latitude) && Number.isFinite(house?.longitude);
}

let mapVisibilityState = { defaultVisible: false, exceptions: new Set() };
let storedHousesForMap = [];
const pendingMapGeoBackfills = new Set();
let mapReconcileTimer = null;
let mapProjectionRetryTimer = null;
let mapProjectionRetryAttempts = 0;
let mapObserver = null;
let mapObserverContainer = null;
let lastReportedMapStatus = null;
let activeMapHouseKey = null;

function mapHouseIsVisible(house) {
  const excepted = mapVisibilityState.exceptions.has(mapHouseKey(house));
  return excepted ? !mapVisibilityState.defaultVisible : mapVisibilityState.defaultVisible;
}

function sweepMapPins() {
  document.querySelectorAll(MAP_PIN_SELECTOR).forEach((el) => el.remove());
  document.querySelectorAll(NATIVE_MAP_PIN_SELECTOR).forEach((el) => {
    delete el.dataset.sidecarNativePin;
    delete el.dataset.sidecarHouseKey;
  });
}

function reportMapStatus(shown, total, missing = 0) {
  if (lastReportedMapStatus && lastReportedMapStatus.shown === shown
      && lastReportedMapStatus.total === total && lastReportedMapStatus.missing === missing) {
    return;
  }
  lastReportedMapStatus = { shown, total, missing };
  chrome.runtime.sendMessage(
    { action: 'mapPinStatus', shown, total, missing },
    () => { void chrome.runtime.lastError; }
  );
}

function applyActiveMapHouse() {
  document.querySelectorAll(MAP_PIN_SELECTOR).forEach((pin) => {
    pin.classList.toggle(
      'sidecar-MapPin--active',
      Boolean(activeMapHouseKey) && pin.dataset.sidecarHouseKey === activeMapHouseKey
    );
  });
}

function createMapPinElement(house, point) {
  const pin = document.createElement('div');
  pin.dataset.sidecar = '1';
  pin.dataset.sidecarPin = '1';
  pin.dataset.sidecarHouseKey = mapHouseKey(house);
  pin.className = 'sidecar-MapPin';
  pin.setAttribute('role', 'button');
  pin.setAttribute('tabindex', '0');
  pin.setAttribute('aria-label', `Show ${house.address || 'this house'} in Investor Sidecar`);
  pin.title = house.address || 'Saved house';
  pin.innerHTML = `
    <svg viewBox="0 0 24 34" width="40" height="54" aria-hidden="true">
      <path d="M12 1.5C6.5 1.5 2 6 2 11.5c0 7.5 10 21 10 21s10-13.5 10-21C22 6 17.5 1.5 12 1.5z"
        fill="#FF1493" stroke="#fff" stroke-width="2.2"/>
      <circle cx="12" cy="11.5" r="4.2" fill="#fff"/>
    </svg>`;
  pin.style.left = `${point.x}px`;
  pin.style.top = `${point.y}px`;
  return pin;
}

/**
 * Watches the site's own map-pin container for changes (a pan or zoom rewrites every
 * native pin's position) and schedules a reconcile in response, the same debounced
 * pattern the button-injection observer below uses. Own-mutation filtering mirrors
 * isOurNode's use in that observer: without it, moving our own pins would retrigger
 * this observer, which would move them again, forever.
 */
function ensureMapObserver(container) {
  if (mapObserver && mapObserverContainer === container) return;
  mapObserver?.disconnect();
  mapObserver = null;
  mapObserverContainer = container;
  if (!container) return;

  mapObserver = new MutationObserver((records) => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.type === 'attributes') {
        if (!isOurNode(record.target)) return scheduleMapReconcile();
        continue;
      }
      const added = record.addedNodes;
      for (let j = 0; j < added.length; j++) {
        if (!isOurNode(added[j])) return scheduleMapReconcile();
      }
      const removed = record.removedNodes;
      for (let j = 0; j < removed.length; j++) {
        if (!isOurNode(removed[j])) return scheduleMapReconcile();
      }
    }
  });
  mapObserver.observe(container, { attributes: true, attributeFilter: ['style'], childList: true, subtree: true });
}

function scheduleMapReconcile() {
  clearTimeout(mapProjectionRetryTimer);
  mapProjectionRetryTimer = null;
  mapProjectionRetryAttempts = 0;
  clearTimeout(mapReconcileTimer);
  mapReconcileTimer = setTimeout(reconcileMapPins, 80);
}

function scheduleMapProjectionRetry() {
  if (mapProjectionRetryTimer || mapProjectionRetryAttempts >= 20) return;
  const delay = Math.min(150 + mapProjectionRetryAttempts * 50, 500);
  mapProjectionRetryTimer = setTimeout(() => {
    mapProjectionRetryTimer = null;
    mapProjectionRetryAttempts += 1;
    reconcileMapPins();
  }, delay);
}

function stopMapProjectionRetry() {
  clearTimeout(mapProjectionRetryTimer);
  mapProjectionRetryTimer = null;
  mapProjectionRetryAttempts = 0;
}

/**
 * The one function that decides what's on the map. Rebuilds the projection, then adds,
 * moves or removes pins to match exactly the set of saved houses whose projected point
 * currently falls inside the map container's own visible rect -- a margin allows a pin
 * anchored near the edge to stay rather than flicker out a few px early.
 */
function reconcileMapPins() {
  const visibleHouses = storedHousesForMap.filter(mapHouseIsVisible);
  if (visibleHouses.length === 0 || typeof site?.buildMapProjection !== 'function') {
    stopMapProjectionRetry();
    sweepMapPins();
    ensureMapObserver(null);
    reportMapStatus(0, 0);
    return;
  }

  const candidates = visibleHouses.filter(hasMapCoords);
  const missing = visibleHouses.filter((house) => !hasMapCoords(house)).length;
  const projection = site.buildMapProjection();
  ensureMapObserver(typeof site.mapPinContainer === 'function' ? site.mapPinContainer() : null);

  if (!projection) {
    sweepMapPins();
    reportMapStatus(0, candidates.length, missing);
    scheduleMapProjectionRetry();
    return;
  }
  ensureCalculatorStyles();

  const container = projection.container;
  const host = projection.host || container;
  // Marker containers are coordinate-space origins and can have zero height. Only their
  // screen origin is meaningful; visibility is clipped against the adapter's real map pane.
  const origin = container.getBoundingClientRect();
  const clip = projection.clip || origin;
  const hostOrigin = host.getBoundingClientRect();
  const anchor = projection.anchor || { dx: 0, dy: 0 };
  const margin = 24;

  const placed = new Map();
  for (const house of candidates) {
    const projected = site.projectPoint(projection, house.latitude, house.longitude);
    if (!projected) continue;
    const point = { x: projected.x + anchor.dx, y: projected.y + anchor.dy };
    const screenX = origin.left + point.x;
    const screenY = origin.top + point.y;
    if (screenX < clip.left - margin || screenX > clip.right + margin
        || screenY < clip.top - margin || screenY > clip.bottom + margin) {
      continue;
    }
    const renderPoint = host === container
      ? point
      : { x: screenX - hostOrigin.left, y: screenY - hostOrigin.top };
    placed.set(mapHouseKey(house), { house, point: renderPoint });
  }

  document.querySelectorAll(NATIVE_MAP_PIN_SELECTOR).forEach((el) => {
    delete el.dataset.sidecarNativePin;
    delete el.dataset.sidecarHouseKey;
  });
  if (typeof site.nativeMapPinForHouse === 'function') {
    for (const [key, { house }] of placed) {
      const nativePin = site.nativeMapPinForHouse(house);
      if (!nativePin) continue;
      nativePin.dataset.sidecarNativePin = '1';
      nativePin.dataset.sidecarHouseKey = key;
    }
  }

  const existing = new Map();
  document.querySelectorAll(MAP_PIN_SELECTOR).forEach((el) => existing.set(el.dataset.sidecarHouseKey, el));

  for (const [key, el] of existing) {
    if (!placed.has(key)) el.remove();
  }
  for (const [key, { house, point }] of placed) {
    const el = existing.get(key);
    if (el) {
      el.style.left = `${point.x}px`;
      el.style.top = `${point.y}px`;
    } else {
      host.appendChild(createMapPinElement(house, point));
    }
  }

  applyActiveMapHouse();
  reportMapStatus(placed.size, candidates.length, missing);
  if (placed.size === 0 && candidates.length > 0) {
    scheduleMapProjectionRetry();
  } else {
    stopMapProjectionRetry();
  }
}

async function refreshMapVisibility() {
  try {
    const result = await chrome.storage.local.get(['mapVisibility', 'showHousesOnMap']);
    const stored = result.mapVisibility;
    mapVisibilityState = {
      defaultVisible: typeof stored?.defaultVisible === 'boolean'
        ? stored.defaultVisible
        : Boolean(result.showHousesOnMap),
      exceptions: new Set(Array.isArray(stored?.exceptions)
        ? stored.exceptions.filter((key) => typeof key === 'string')
        : [])
    };
  } catch {
    mapVisibilityState = { defaultVisible: false, exceptions: new Set() };
  }
  scheduleMapReconcile();
  backfillVisibleMapCoordinates();
}

async function refreshStoredHousesForMap() {
  try {
    const result = await chrome.storage.local.get('storedHouses');
    storedHousesForMap = Array.isArray(result.storedHouses) ? result.storedHouses : [];
  } catch {
    storedHousesForMap = [];
  }
  scheduleMapReconcile();
  backfillVisibleMapCoordinates();
}

function backfillVisibleMapCoordinates() {
  if (!site || typeof site.extractFromCard !== 'function') return;
  const missing = new Set(
    storedHousesForMap
      .filter((house) => house?.source === site.id && !hasMapCoords(house))
      .map(mapHouseKey)
  );
  if (missing.size === 0) return;

  const candidates = site.isDetailPage() && typeof site.extractFromDetailPage === 'function'
    ? [site.extractFromDetailPage()].filter(Boolean)
    : site.findCardElements().map((card) => {
      try {
        return site.extractFromCard(card);
      } catch {
        return null;
      }
    }).filter(Boolean);

  for (const house of candidates) {
    const key = mapHouseKey(house);
    if (!missing.has(key) || !hasMapCoords(house) || pendingMapGeoBackfills.has(key)) continue;
    pendingMapGeoBackfills.add(key);
    chrome.runtime.sendMessage({ action: 'addHouse', house }, () => {
      void chrome.runtime.lastError;
      pendingMapGeoBackfills.delete(key);
    });
  }
}

/**
 * Swallows clicks on our own pins before the site's own map click handling sees them --
 * same rationale and same document-level capture-phase approach as
 * installButtonInterceptors above (see its comment for why capture-phase specifically).
 */
let mapPinInterceptorsInstalled = false;

function installMapPinInterceptors() {
  if (mapPinInterceptorsInstalled) return;
  mapPinInterceptorsInstalled = true;

  const sidecarPin = (e) => {
    const target = e.target;
    return target instanceof Element
      ? target.closest(`${MAP_PIN_SELECTOR}, ${NATIVE_MAP_PIN_SELECTOR}`)
      : null;
  };

  const activate = (pin) => {
    activeMapHouseKey = pin.dataset.sidecarHouseKey || null;
    applyActiveMapHouse();
    chrome.runtime.sendMessage(
      { action: 'mapPinClicked', key: pin.dataset.sidecarHouseKey },
      () => { void chrome.runtime.lastError; }
    );
  };

  document.addEventListener('click', (e) => {
    const pin = sidecarPin(e);
    if (!pin) return;
    if (pin.matches(MAP_PIN_SELECTOR)) consumeEvent(e);
    activate(pin);
  }, true);

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
    document.addEventListener(type, (e) => {
      const pin = sidecarPin(e);
      if (pin?.matches(MAP_PIN_SELECTOR)) consumeEvent(e);
    }, true);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const pin = sidecarPin(e);
    if (!pin) return;
    if (pin.matches(MAP_PIN_SELECTOR)) consumeEvent(e);
    activate(pin);
  }, true);
}

const init = () => {
  if (!site) return;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', init, { once: true });
    return;
  }

  let debounceTimer = null;
  let idleHandle = null;
  let resizeSettleTimer = null;
  let resizing = false;
  let observer = null;

  const run = () => {
    // Yield to the browser: during a resize the main thread is busy laying the page
    // out, and our work is never urgent enough to compete with painting.
    if (typeof requestIdleCallback === 'function') {
      cancelIdleCallback?.(idleHandle);
      idleHandle = requestIdleCallback(() => processPage(), { timeout: 500 });
    } else {
      processPage();
    }
  };

  const scheduleProcess = () => {
    // While a resize is in flight, don't inject at all -- injecting mid-resize both
    // competes with layout and feeds the observer more mutations. One pass after it
    // settles is enough.
    if (resizing) return;
    clearTimeout(debounceTimer);
    // Trailing edge, not a leading-edge throttle: the old version's first call always
    // landed inside its own cooldown window and no-opped, and it dropped whichever
    // mutation arrived last -- usually the batch where the results list finishes
    // rendering.
    debounceTimer = setTimeout(run, 150);
  };

  processPage();

  // Kept in a variable so it can be disconnected while the viewport is changing.
  observer = new MutationObserver((records) => {
    // This runs synchronously on the site's own DOM churn, so it stays allocation-free:
    // indexed loops rather than spreading NodeLists into arrays.
    //
    // Our own injection also mutates the DOM, which the observer reports back to us,
    // scheduling another pass that injects again. Batches describing only our own nodes
    // are not news, and ignoring them breaks that feedback loop.
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const added = record.addedNodes;
      for (let j = 0; j < added.length; j++) {
        if (!isOurNode(added[j])) return scheduleProcess();
      }
      const removed = record.removedNodes;
      for (let j = 0; j < removed.length; j++) {
        if (!isOurNode(removed[j])) return scheduleProcess();
      }
    }
  });
  observer.observe(document.body, OBSERVER_OPTIONS);

  window.addEventListener('resize', () => {
    // Detach completely for the duration of the resize. Even a cheap observer callback
    // runs on the site's churn while it relayouts, and dragging the side panel divider
    // produces a continuous stream of that. Contributing nothing is the only way to be
    // certain we aren't slowing the site's own resize.
    if (!resizing) {
      resizing = true;
      observer?.disconnect();
      clearTimeout(debounceTimer);
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle);
    }
    clearTimeout(resizeSettleTimer);
    resizeSettleTimer = setTimeout(() => {
      resizing = false;
      observer?.observe(document.body, OBSERVER_OPTIONS);
      // Responsive layout swaps can move or drop the action bar entirely (Zillow
      // switches to a mobile bar at narrow widths), so re-check once it's stable.
      scheduleProcess();
    }, 250);
  }, { passive: true });

  // Both sites are SPAs; ordinary in-app navigation is covered by the DOM mutations
  // it causes, this catches browser back/forward.
  window.addEventListener('popstate', scheduleProcess);

  // Browsers throttle layout in background tabs, and every supported map needs real
  // dimensions before it can project a saved coordinate. Reconcile as soon as a
  // cold-opened tab becomes visible instead of waiting for the site's next mutation.
  const reconcileVisibleMap = () => {
    if (document.visibilityState === 'visible') scheduleMapReconcile();
  };
  window.addEventListener('pageshow', scheduleMapReconcile);
  window.addEventListener('focus', scheduleMapReconcile);
  document.addEventListener('visibilitychange', reconcileVisibleMap);

  // Comp mode. Only the worker can tell this tab apart from an ordinary one, so this
  // tab asks on load and again whenever the session key changes -- a Done click, the
  // session's tab closing, or a fresh session replacing it, all of which the worker
  // expresses as one write to the same storage key.
  refreshCompSession();

  // Map pins. Both the toggle and the house list are read directly from storage rather
  // than messaged in, and kept fresh the same reactive way compSession is: on load and
  // on every relevant storage.onChanged.
  installMapPinInterceptors();
  refreshMapVisibility();
  refreshStoredHousesForMap();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('compSession' in changes) refreshCompSession();
    if ('mapVisibility' in changes || 'showHousesOnMap' in changes) refreshMapVisibility();
    if ('storedHouses' in changes) refreshStoredHousesForMap();
  });

  window.__investorSidecarLogView = () => {
    console.group(LOG_PREFIX, 'diagnostics');
    console.log('site adapter:', site.id);
    console.log(site.diagnostics());
    console.log('injected buttons:', document.querySelectorAll('.bp-CalculatorExtension').length);
    console.log('comp session:', compSession);
    console.log('map pins: visibility =', mapVisibilityState, ', last status =', lastReportedMapStatus);
    console.groupEnd();
  };
};

init();
