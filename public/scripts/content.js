/**
 * Site-agnostic driver. Picks an adapter by hostname and runs the same injection,
 * click and save flow for every supported site. All per-site selectors live in
 * scripts/sites/<site>.js -- nothing here should reference Redfin or Zillow markup.
 */
const LOG_PREFIX = '[Investor Sidecar]';
const OBSERVER_OPTIONS = { childList: true, subtree: true };
/** Bump when shipping a change that needs to be confirmed as loaded in the browser. */
const SIDECAR_BUILD = '2026-07-26.1';

const ADAPTERS = [RedfinAdapter, ZillowAdapter];
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
      setCalculatorState(button, 'saved', 'Added to Investor Sidecar');
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
 * These listeners are on `document`, not on the button. That distinction is the whole
 * point: a capture-phase listener on the button itself is at the *end* of the capture
 * path, so every ancestor's capture handler -- including the router Zillow hangs off its
 * results cards -- has already run by the time it fires. Clicking Analyze on Zillow
 * therefore opened the listing as well as capturing it. Redfin only ever behaved because
 * its adapter deliberately targets the action row Redfin has already excluded from card
 * navigation, not because the old wiring worked.
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

  document.addEventListener('click', (e) => {
    const button = ourButton(e);
    if (!button) return;
    consumeEvent(e);
    activateButton(button);
  }, true);

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'auxclick', 'dblclick']) {
    document.addEventListener(type, (e) => {
      if (ourButton(e)) consumeEvent(e);
    }, true);
  }

  for (const type of ['touchstart', 'touchend']) {
    document.addEventListener(type, (e) => {
      if (ourButton(e)) consumeEvent(e);
    }, { capture: true, passive: false });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const button = ourButton(e);
    if (!button) return;
    consumeEvent(e);
    activateButton(button);
  }, true);
}

/**
 * Builds the button. `clickHandler` returns { ok, reason } so the outcome can be
 * drawn on the button rather than logged. Activation is handled by the document-level
 * interceptors above; the handler is stashed on the element for them to find.
 */
function createCalculatorElement(clickHandler, { className, label } = {}) {
  ensureCalculatorStyles();
  installButtonInterceptors();

  const wrapper = document.createElement('div');
  wrapper.dataset.sidecar = '1';
  wrapper.className = className || 'bp-CalculatorExtension';
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('tabindex', '0');
  wrapper.setAttribute('aria-label', 'Analyze with Investor Sidecar');
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

const StorageManager = {
  async saveHouse(houseData) {
    // 'N/A' and null are both rejected here: a non-numeric id used to be stored anyway
    // and every such house collided on one key, silently discarding all but the first.
    if (!/^\d+$/.test(String(houseData?.propertyID ?? ''))) {
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

// Cards permanently ruled out (ads, cards with no listing link). That status doesn't
// change once determined, so this is a pure perf skip -- unlike the old
// data-calculator-added attribute, which also skipped cards whose button a React
// re-render had wiped, so those never got one back.
const nonInjectableCards = new WeakSet();

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
  if (nonInjectableCards.has(cardEl)) return;
  if (!site.isInjectableCard(cardEl)) {
    nonInjectableCards.add(cardEl);
    return;
  }

  const target = site.cardInjectionTarget(cardEl);
  if (!target?.container || target.container.querySelector('.bp-CalculatorExtension')) return;

  const button = createCalculatorElement(
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

function ensureCalculatorOnDetailPage() {
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

  // Matches the container's own item type. Zillow's action bar is a <ul> whose items are
  // <li>, and a <div> dropped in there doesn't participate in the row layout -- the button
  // stacked underneath Save instead of sitting beside it.
  const isList = container.tagName === 'UL' || container.tagName === 'OL';
  const wrapper = document.createElement(isList ? 'li' : 'div');
  wrapper.dataset.sidecar = '1';
  wrapper.className = site.detailWrapperClassName || '';
  const button = createCalculatorElement(
    () => handleCapture(() => site.extractFromDetailPage(), "Couldn't read this listing's details."),
    { className: site.detailButtonClassName, label: 'Analyze' }
  );
  wrapper.appendChild(button);
  // The wrapper carries our class, not the button, so injectInto's own dedupe check
  // (which looks for the button class inside the container) still applies to it.
  injectInto(target, wrapper);
}

/** Guards the stale-card sweep so it runs once per page, not once per mutation batch. */
let lastCleanedUrl = null;

const processPage = () => {
  if (!site) return;

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
    ensureCalculatorOnDetailPage();
    return;
  }

  site.findCardElements().forEach(ensureCalculatorOnCard);

  for (const extra of site.extraInjectionTargets()) {
    if (extra.container.querySelector('.bp-CalculatorExtension')) continue;
    const button = createCalculatorElement(
      () => handleCapture(extra.extract, extra.missingDataReason),
      { className: extra.className || site.cardButtonClassName }
    );
    injectInto(extra, button);
  }
};

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

const init = () => {
  if (!site) return;

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

  window.__investorSidecarLogView = () => {
    console.group(LOG_PREFIX, 'diagnostics');
    console.log('site adapter:', site.id);
    console.log(site.diagnostics());
    console.log('injected buttons:', document.querySelectorAll('.bp-CalculatorExtension').length);
    console.groupEnd();
  };
};

init();
