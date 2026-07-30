/**
 * Zillow site adapter.
 *
 * Built from one live recon pass (see docs/zillow-recon.md), so the selectors here
 * are verified against exactly one for-sale detail page and one results page. Treat
 * anything beyond that as unproven -- particularly condos, new construction and
 * off-market listings.
 *
 * Notable differences from Redfin found during recon:
 *  - Property id is "<digits>_zpid", not a trailing all-digits segment.
 *  - Zillow uses data-testid, not data-test. Its CSS class names are hashed
 *    styled-components output and change between deploys, so nothing here keys off
 *    a class name.
 *  - __NEXT_DATA__ is large (~188KB) but only carries geo and zpid -- not price,
 *    beds, baths or address -- so it's used only as a geo source.
 *  - The ld+json RealEstateListing blob had a real numeric offers.price but its
 *    address/geo/floorSize subfields were absent, so it's used only for price.
 */
var ZillowAdapter = (function () {
  const P = SidecarParsers;

  /**
   * Geo from the embedded __NEXT_DATA__ blob. The keys are present but nested
   * unpredictably, so rather than guessing a path this scans for the first
   * plausible lat/long pair. Bounded to continental-ish ranges to avoid latching
   * onto some unrelated coordinate pair elsewhere in the payload.
   */
  function geoFromNextData(propertyID) {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el?.textContent) return null;

    let data;
    try {
      data = JSON.parse(el.textContent);
    } catch {
      return null;
    }

    const validPair = (node) => {
      const latitude = Number(node?.latitude);
      const longitude = Number(node?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
      if (latitude === 0 && longitude === 0) return null;
      return { latitude, longitude };
    };

    // A Next payload can include nearby listings, so the critical invariant is that
    // latitude and longitude come from the *same* object -- reading the first of each
    // independently (as this used to) can silently combine two different houses.
    //
    // Preferred: a coordinate pair inside the subtree belonging to this zpid.
    const walkScoped = (node, belongsToProperty = false) => {
      if (!node || typeof node !== 'object') return null;
      const isCurrentProperty = belongsToProperty || String(node.zpid ?? '') === String(propertyID);
      if (isCurrentProperty) {
        const pair = validPair(node);
        if (pair) return pair;
      }
      for (const value of Object.values(node)) {
        const found = walkScoped(value, isCurrentProperty);
        if (found) return found;
      }
      return null;
    };

    // Deliberately no unscoped fallback. A coordinate pair that isn't tied to this
    // zpid might belong to a neighbouring listing in the same payload, and feeding
    // the wrong location to the rent service yields an estimate for the wrong
    // neighbourhood that looks entirely authoritative. Returning null instead leaves
    // rent visibly unavailable, which the panel already surfaces, and leaves the door
    // open to geocoding the address properly.
    return walkScoped(data);
  }

  /**
   * Geo for a results-page card, from the search payload embedded in __NEXT_DATA__.
   *
   * A card's own DOM carries no coordinates at all (verified live, docs/map-linking.md
   * §2) -- unlike the detail page, whose blob is scoped to the one property on screen,
   * this one lists every result, so it's matched by zpid the same way geoFromNextData
   * scopes itself. Measured shape (docs/map-linking.md §1.2):
   * __NEXT_DATA__.props.pageProps.searchPageState.cat1.searchResults.listResults, an
   * array of records carrying zpid and latLong. mapResults exists on the same payload
   * but was empty on the page measured, so it isn't used as a source here.
   */
  function geoFromListResults(propertyID) {
    if (!propertyID) return null;
    const el = document.getElementById('__NEXT_DATA__');
    if (!el?.textContent) return null;

    let data;
    try {
      data = JSON.parse(el.textContent);
    } catch {
      return null;
    }

    const listResults =
      data?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
    if (!Array.isArray(listResults)) return null;

    const record = listResults.find((r) => String(r?.zpid ?? '') === String(propertyID));
    if (!record) return null;

    // latLong is the shape measured live; lat/lng covers the alternate spelling
    // Zillow's own API has used elsewhere, so a minor payload drift doesn't silently
    // regress this back to null.
    const latitude = Number(record.latLong?.latitude ?? record.latLong?.lat);
    const longitude = Number(record.latLong?.longitude ?? record.latLong?.lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    if (latitude === 0 && longitude === 0) return null;

    return { latitude, longitude };
  }

  /**
   * Reads back which marker the site lit up in response to a synthetic hover on `card`,
   * as { lat, lon, x, y } for map-projection calibration -- or null if nothing lit up
   * (virtualized list, selector drift, or this card's marker isn't in the current view).
   *
   * Zillow markers carry no id or coordinates of their own (verified live,
   * docs/map-linking.md §1.2), so this borrows the site's own card<->pin hover sync to
   * learn where a *known* coordinate renders on screen. Position is measured relative to
   * `container`, the same frame our own injected pins are placed in.
   */
  function probeMarkerFor(card, geo, container) {
    card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const marker = container.querySelector('.is-hovered');
    card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    if (!marker) return null;

    const containerRect = container.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    return {
      lat: geo.latitude,
      lon: geo.longitude,
      x: markerRect.left - containerRect.left + markerRect.width / 2,
      y: markerRect.top - containerRect.top + markerRect.height / 2
    };
  }

  /** Price from the RealEstateListing ld+json blob -- the one field it reliably carries. */
  function priceFromLdJson(propertyID) {
    // Scoped to the zpid we're actually capturing, for the same reason geoFromNextData is.
    // Both sites are SPAs and Next.js leaves server-rendered head scripts in place across
    // client-side navigations, so the first RealEstateListing blob on the page can describe
    // the listing the user came *from*. Taking it unscoped -- and preferring it over the
    // rendered price -- meant a capture could pair listing A's price with listing B's
    // address, which is exactly the confident-wrong-number this adapter exists to avoid.
    // Measured live: the blob carries a full "url" containing "<zpid>_zpid".
    if (!propertyID) return null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue;
      }
      const obj = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!String(obj?.['@type'] ?? '').includes('RealEstateListing')) continue;
      // No identifying url means we can't prove it's this listing, so we don't trust it.
      const identity = String(obj?.url ?? obj?.['@id'] ?? '');
      if (!identity.includes(`${propertyID}_zpid`)) continue;
      const price = Number(obj?.offers?.price);
      if (Number.isFinite(price) && price > 0) return String(price);
    }
    return null;
  }

  const cardHref = (card) =>
    card?.querySelector('a[href*="/homedetails/"], a[href*="/apartments/"]')?.getAttribute('href') ?? null;

  /**
   * The "save"/heart control inside an action row, whichever way this template spells it.
   * Zillow's class names are hashed, so every candidate here is a testid or an accessible
   * name -- the two things that survive a deploy.
   *
   * Used to anchor our button beside a control the page itself treats as an action, rather
   * than at whichever end of the row happens to come last.
   */
  function findSaveControl(root) {
    if (!root) return null;
    const byAttribute = root.querySelector('[data-testid="save-button"]')
      ?? root.querySelector('[data-testid*="save"]')
      ?? root.querySelector('[data-testid*="favorite"]')
      ?? root.querySelector('button[aria-label*="save" i]')
      ?? root.querySelector('button[aria-label*="favorite" i]');
    if (byAttribute) return byAttribute;

    // Last resort: the visible label. Matched exactly, not as a substring, so "Save this
    // search" or "Saved homes" can't win over the control we actually want.
    for (const button of root.querySelectorAll('button')) {
      if (/^saved?$/i.test(button.textContent?.trim() ?? '')) return button;
    }
    return null;
  }

  /**
   * Walks up from `descendant` to whichever direct child of `row` contains it.
   *
   * Needed because the control we want to sit beside is not itself a child of the row:
   * on the showcase template the row is a <ul> and Save is a <button> inside an <li>.
   * Appending next to the button put us inside that <li>, where it stacked below Save
   * instead of sitting alongside it.
   */
  function rowItemContaining(row, descendant) {
    let node = descendant;
    while (node && node.parentElement !== row) node = node.parentElement;
    return node;
  }

  /**
   * The list of action links (Save / Share / More) as an injection point, if this template
   * renders one. Returns the list itself as the container so our button becomes a peer of
   * those items rather than a child of one.
   */
  function actionLinksTarget(root) {
    const list = root?.querySelector('[data-testid="action-bar-links-container"]');
    if (!list) return null;
    const save = findSaveControl(list);
    const item = save ? rowItemContaining(list, save) : null;
    return { container: list, insertAfter: item, position: 'append' };
  }

  return {
    id: 'zillow',

    matchesHost(hostname) {
      return /(^|\.)zillow\.com$/i.test(hostname);
    },

    /**
     * Whether this detail page is a rental listing. Checked against the *rendered*
     * price text, not extractFromDetailPage's own `price` field: that field prefers a
     * RealEstateListing ld+json blob's `offers.price` when one exists, and verified
     * live, Zillow publishes exactly that for a rental listing too -- a clean number
     * with no "/mo" suffix, which is the one signal a rental's price carries.
     * Content.js uses this to withhold the ordinary Analyze button outside comp mode.
     */
    isRentalDetailPage() {
      return /\/\s*mo/i.test(document.querySelector('[data-testid="price"]')?.textContent || '');
    },

    /**
     * A zpid in the *page's own path* is the detail-page signal. A results page links
     * to /homedetails/ but its own URL never contains "<digits>_zpid", so this can't
     * confuse the two.
     *
     * This used to additionally require desktop-action-bar or bed-bath-sqft-facts.
     * Zillow has at least one other detail template -- "showcase" listings, verified
     * live on a Chicago high-rise condo -- where neither exists. Those pages were
     * classified as results pages, so the house itself got no Analyze button while
     * nine appeared on the similar-homes cards below it.
     */
    isDetailPage() {
      return Boolean(P.zillowPropertyId(window.location.pathname));
    },

    /**
     * Ordered fallbacks. desktop-action-bar only exists at desktop widths: with the
     * side panel open the viewport is narrow enough that Zillow switches to its
     * mobile layout, where the only action bar is [data-testid="mobile-action-bar"]
     * and the desktop one is absent entirely (verified live). Keying solely on the
     * desktop bar meant no Analyze button in exactly the situation the extension is
     * used in -- panel open. The header fallbacks keep the button near the price
     * rather than in a floating mobile bar.
     */
    detailInjectionTarget() {
      // The Save/Share/More list, wherever the template puts it. Measured on the showcase
      // page: a <ul data-testid="action-bar-links-container"> laid out row-reverse inside
      // showcase-action-bar-container. Appending to that outer container instead dropped
      // our button beside the back arrow at the far end of the bar.
      const links = actionLinksTarget(document);
      if (links) return links;

      const target = P.firstUsable([
        document.querySelector('[data-testid="desktop-action-bar"]'),
        document.querySelector('[data-testid="desktop-actions-container"]'),
        // "showcase" listing template -- measured 1248x120 and rendered.
        document.querySelector('[data-testid="showcase-action-bar-container"]'),
        document.querySelector('[data-testid="action-bar-container"]'),
        document.querySelector('[data-testid="action-bar"]'),
        document.querySelector('[data-testid="price"]')?.parentElement,
        document.querySelector('[data-testid="bed-bath-sqft-facts"]')?.parentElement,
        document.querySelector('[data-testid="desktop-bed-bath-sqft"]')?.parentElement,
        document.querySelector('h1')?.parentElement,
        document.querySelector('[data-testid="mobile-action-bar"]')
      ]);
      if (!target) return null;

      // Alongside the save control when this template exposes one, so we inherit its
      // alignment in the row rather than trailing whatever happens to be last.
      const save = findSaveControl(target);
      const item = save ? rowItemContaining(target, save) : null;
      return { container: target, insertAfter: item, position: 'append' };
    },

    extractFromDetailPage() {
      const propertyID = P.zillowPropertyId(window.location.pathname);
      if (!propertyID) return null;

      // Prefer the structured price -- it's a clean number rather than rendered text --
      // but only the blob proven to belong to this zpid. Falls back to the rendered price,
      // which is always about the listing on screen.
      const price = priceFromLdJson(propertyID)
        ?? document.querySelector('[data-testid="price"]')?.textContent?.trim()
        ?? null;

      // Template-dependent: the standard page uses bed-bath-sqft-facts, showcase pages
      // use desktop-/mobile-bed-bath-sqft. All render the same unpunctuated string.
      const factsText =
        document.querySelector('[data-testid="bed-bath-sqft-facts"]')?.textContent
        ?? document.querySelector('[data-testid="desktop-bed-bath-sqft"]')?.textContent
        ?? document.querySelector('[data-testid="mobile-bed-bath-sqft"]')?.textContent
        ?? '';
      const facts = P.parseBedBathSqft(factsText);

      // Zillow puts the street address in the page h1; the rest of the locality is
      // adjacent. Fall back to the document title, which is "<address> | ... | Zillow".
      const h1 = document.querySelector('h1')?.textContent?.trim() ?? null;
      const titleAddress = document.title.split('|')[0]?.trim() ?? null;
      // Detail-page h1 is often street-only. Prefer the title only when it carries
      // the state + ZIP the local tax/rent services need.
      const address = titleAddress && /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(titleAddress)
        ? titleAddress
        : h1;

      // HOA lives in the facts-and-features module; scan its text rather than
      // depending on a specific row structure.
      // "facts-and-features-module" on the standard template, "facts-and-features" on
      // showcase pages.
      const factsModule = document.querySelector('[data-testid="facts-and-features-module"]')
        ?? document.querySelector('[data-testid="facts-and-features"]');
      const hoa = factsModule ? P.parseHoa(factsModule.textContent) : null;

      const geo = geoFromNextData(propertyID);

      if (!address || !price) return null;

      return {
        source: 'zillow',
        address,
        price,
        beds: facts.beds,
        baths: facts.baths,
        sqft: facts.sqft,
        propertyID,
        url: window.location.href,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        hoa
      };
    },

    /** Results-page cards are <article id="zpid_NNNN">; [data-test="property-card"] matched nothing. */
    findCardElements() {
      return [...document.querySelectorAll('article[id^="zpid_"]')];
    },

    isInjectableCard(card) {
      if (!card) return false;
      // Exact-price apartment cards are usable rent comps too. The driver separately
      // rejects "+" starting prices, "Price on request", and coordinate pseudo-ids.
      // Ads have neither a homedetails nor an apartments link.
      return Boolean(cardHref(card));
    },

    cardInjectionTarget(card) {
      // Sit alongside the card's own save/actions control when present, else append
      // to the price row so we end up somewhere visible rather than off-layout.
      const actions = card.querySelector('[data-testid="property-card-actions-btn"]')
        ?? card.querySelector('[data-testid="property-card-save"]')
        ?? card.querySelector('[data-testid="property-card-save-button"]');
      if (actions?.parentElement) {
        return { container: actions.parentElement, insertAfter: actions };
      }
      const price = card.querySelector('[data-testid="property-card-price"]');
      if (price?.parentElement) {
        return { container: price.parentElement, insertAfter: price };
      }
      return { container: card, insertAfter: null };
    },

    extractFromCard(card) {
      if (!card) return null;
      const href = cardHref(card);
      const propertyID = P.zillowPropertyId(P.pathnameOf(href, window.location.origin))
        // The <article> id itself carries the zpid, as a last resort.
        ?? card.id?.match(/zpid_(\d+)/)?.[1]
        ?? null;

      // separatedText, not textContent: the card's price element runs straight into its
      // bed count ("$750,0002 bds"), which had every card reporting beds as "0002".
      const facts = P.parseBedBathSqft(P.separatedText(card));
      const geo = geoFromListResults(propertyID);

      return {
        source: 'zillow',
        address: card.querySelector('[data-testid="property-card-address-link"]')?.textContent?.trim()
          ?? card.querySelector('address')?.textContent?.trim()
          ?? null,
        price: card.querySelector('[data-testid="property-card-price"]')?.textContent?.trim() ?? null,
        beds: facts.beds,
        baths: facts.baths,
        sqft: facts.sqft,
        propertyID,
        url: P.absoluteUrl(href, window.location.origin),
        // Falls back to null (rather than throwing) when this card's zpid isn't in the
        // search payload's listResults -- e.g. mapResults-only pins, which carry no geo
        // on the page measured (docs/map-linking.md §1.2). The rent API and the map-pin
        // feature both already degrade gracefully without coordinates.
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        hoa: null
      };
    },

    extraInjectionTargets() {
      return [];
    },

    /**
     * Comp-mode extras for a results-page card. Zillow carries no separate price-label
     * text the way Redfin does -- a non-disclosure-state sold price just renders the
     * literal "$--", which parseCompAmount already treats as null -- so priceLabel is
     * always null here; the caller infers 'sold' whenever an amount actually parses.
     * soldDateText is the card's own text, best-effort: no Zillow sold-date selector has
     * been verified live yet (see docs/zillow-recon.md).
     */
    compFacts(card) {
      if (!card) return null;
      return {
        amountText: card.querySelector('[data-testid="property-card-price"]')?.textContent?.trim() ?? null,
        priceLabel: null,
        soldDateText: P.separatedText(card)
      };
    },

    // Zillow's own class names are hashed and unusable, so our button carries only
    // our own classes and relies on the self-contained styles in content.js.
    cardButtonClassName: 'bp-CalculatorExtension sidecar-Button--icon',
    detailButtonClassName: 'bp-CalculatorExtension sidecar-Button--action',
    detailWrapperClassName: 'sidecar-ActionWrapper',

    /** The element the site's own map markers live in (verified live, docs/map-linking.md §1.2). */
    mapPinContainer() {
      return document.querySelector('.zillow-map-layer');
    },

    /**
     * Fits a lat/lon -> screen-px projection via hover-probe calibration: dispatch a
     * synthetic hover on two rendered result cards with known coordinates, read back
     * which marker the site's own JS lit up (`.is-hovered`) and where it landed, and fit
     * an affine projection from those two (known coordinate, measured position) pairs.
     * Measured live at 0.00px median error on a cold load (docs/map-linking.md §1.2).
     *
     * Deliberately capped at exactly two synthetic hovers per call -- see docs/map-linking.md
     * §5 on bot-protection posture -- so this fails closed (returns null) rather than
     * probing further when the list is virtualized down to fewer than two matchable cards,
     * or when a probe doesn't light up a marker at all.
     */
    buildMapProjection() {
      const container = this.mapPinContainer();
      if (!container) return null;

      const candidates = [];
      for (const card of document.querySelectorAll('article[id^="zpid_"]')) {
        const propertyID = P.zillowPropertyId(P.pathnameOf(cardHref(card), window.location.origin))
          ?? card.id?.match(/zpid_(\d+)/)?.[1] ?? null;
        const geo = geoFromListResults(propertyID);
        if (geo) candidates.push({ card, geo });
        if (candidates.length >= 2) break;
      }
      if (candidates.length < 2) return null;

      const probes = candidates
        .map(({ card, geo }) => probeMarkerFor(card, geo, container))
        .filter(Boolean);
      if (probes.length < 2) return null;

      const fit = SidecarGeoProjection.fit(probes[0], probes[1]);
      return fit ? { container, fit } : null;
    },

    /** Projects a (lat, lon) through a projection built by buildMapProjection(). */
    projectPoint(projection, lat, lon) {
      return projection ? SidecarGeoProjection.project(projection.fit, lat, lon) : null;
    },

    diagnostics() {
      return {
        cards: document.querySelectorAll('article[id^="zpid_"]').length,
        detailPage: this.isDetailPage(),
        detailTarget: !!this.detailInjectionTarget(),
        zpid: P.zillowPropertyId(window.location.pathname),
        hasNextData: !!document.getElementById('__NEXT_DATA__'),
        ldJsonPrice: priceFromLdJson(P.zillowPropertyId(window.location.pathname)),
        listResultsCount: (() => {
          const el = document.getElementById('__NEXT_DATA__');
          if (!el?.textContent) return 0;
          try {
            const data = JSON.parse(el.textContent);
            const results = data?.props?.pageProps?.searchPageState?.cat1?.searchResults?.listResults;
            return Array.isArray(results) ? results.length : 0;
          } catch {
            return 0;
          }
        })(),
        mapPinContainer: !!this.mapPinContainer()
      };
    }
  };
})();
