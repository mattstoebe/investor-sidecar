/**
 * Redfin site adapter. Every Redfin-specific selector in the extension lives here;
 * content.js knows nothing about any particular site.
 */
var RedfinAdapter = (function () {
  const P = SidecarParsers;

  const propertyIdFromCard = (contentEl) => {
    const href = contentEl?.querySelector('a[href*="/"]')?.getAttribute('href');
    return P.redfinPropertyId(P.pathnameOf(href, window.location.origin));
  };

  const listingUrlFromCard = (contentEl) => {
    const href = contentEl?.querySelector('a[href*="/"]')?.getAttribute('href');
    return P.absoluteUrl(href, window.location.origin);
  };

  /**
   * Reads lat/long from an ld+json blob carrying geo.
   *
   * `expectedId` scopes the result to one listing and must be supplied whenever `root` is
   * the whole document. Redfin is an SPA, so blobs describing the previously viewed listing
   * can outlive the navigation, and coordinates belonging to another house are worse than
   * none: the rent estimate would come back confidently wrong for the wrong location.
   * Card lookups pass the card element as `root`, which scopes them by DOM instead.
   */
  function geoFromLdJson(root, expectedId) {
    const scripts = (root || document).querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue; // a malformed blob shouldn't abort the whole lookup
      }
      const objects = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of objects) {
        const geo = obj?.geo ?? obj?.mainEntity?.geo;
        const latitude = Number(geo?.latitude);
        const longitude = Number(geo?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;

        const url = obj?.url ?? obj?.mainEntity?.url ?? null;
        if (expectedId) {
          // Require proof of identity rather than assuming the first blob is the right one.
          if (P.redfinPropertyId(P.pathnameOf(url, window.location.origin)) !== expectedId) continue;
        }
        return { latitude, longitude, url };
      }
    }

    // Redfin also exposes the current detail page's coordinate in a scoped meta tag.
    // Use it only for a whole-document lookup whose URL proves the requested identity.
    if ((root || document) === document && expectedId
        && P.redfinPropertyId(window.location.pathname) === expectedId) {
      const raw = document.querySelector('meta[name="geo.position"]')?.getAttribute('content') ?? '';
      const [latitude, longitude] = raw.split(';').map(Number);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return { latitude, longitude, url: window.location.href };
      }
    }
    return null;
  }

  /**
   * Reads a stat from the detail-page header. Redfin is inconsistent: abp-price,
   * abp-beds and abp-sqFt wrap their value in .statsValue, but abp-baths renders
   * "6.5 ba" directly on the element. Requiring .statsValue silently lost every
   * bathroom count, which then failed the rent API's 1-4 bathroom validation.
   */
  function readStat(container, testId) {
    const el = container?.querySelector(`[data-rf-test-id="${testId}"]`);
    if (!el) return null;
    const raw = (el.querySelector('.statsValue')?.textContent ?? el.textContent ?? '').trim();
    if (!raw) return null;
    return P.firstNumber(raw) ?? raw;
  }

  /**
   * A rental-listing detail page's own stat blocks -- a third detail template,
   * verified live 2026-07-29 on an active "For Rent" listing at a plain /home/<id>
   * URL indistinguishable by path from a for-sale one. Keyed by `data-rf-test-name`,
   * not `data-rf-test-id`: readStat above finds nothing here, which is why this
   * template's Analyze button (and, before that, its comp button) never appeared at
   * all. The `data-rf-test-name="stat-price"` attribute identifies this template;
   * `.stat-block.price-section` is also used by current for-sale pages.
   */
  function readRentalStat(testName) {
    const el = document.querySelector(`[data-rf-test-name="${testName}"]`);
    if (!el) return null;
    const raw = (el.querySelector('.statsValue')?.textContent ?? el.textContent ?? '').trim();
    if (!raw) return null;
    return P.firstNumber(raw) ?? raw;
  }

  function isRentalTemplate() {
    return Boolean(document.querySelector('[data-rf-test-name="stat-price"]'));
  }

  return {
    id: 'redfin',

    matchesHost(hostname) {
      return /(^|\.)redfin\.com$/i.test(hostname);
    },

    /**
     * Whether the current detail page is the rental-listing template (see
     * extractFromDetailPage below) rather than a for-sale one. Content.js uses this to
     * withhold the ordinary Analyze button outside comp mode -- a rental's price is a
     * monthly rent, not a purchase price, and feeding "$4,500/mo" into the buy-and-hold
     * calculator as a $4,500 house is exactly the mistake this exists to prevent.
     */
    isRentalDetailPage() {
      return isRentalTemplate();
    },

    /**
     * Identified by DOM, not URL. Listings live under /home/<id>, /for-sale/<id> and
     * others, so a substring check on the path both missed the Analyze button on those
     * pages and made the code treat them as results pages.
     */
    isDetailPage() {
      return Boolean(
        document.querySelector('.MainHouseInfoPanel') ||
        document.querySelector('.home-main-stats-variant') ||
        isRentalTemplate()
      );
    },

    /**
     * Ordered fallbacks. The pill bar is not present on every listing state: verified
     * live on a Coming Soon listing (ListingStatusBannerSection banner, no Share/Save
     * controls anywhere on the page) where .bp-HomeControls matched nothing. Its data
     * extracted perfectly, so keying solely on the pill bar meant a whole listing
     * state could never be captured. The later entries put the button next to the
     * address instead of nowhere.
     */
    detailInjectionTarget() {
      // firstUsable, not ?? chaining: Redfin hides parts of the action bar
      // responsively rather than removing them, so the first target that merely
      // exists can be display:none at panel widths.
      const actionRow = P.firstUsable([
        document.querySelector('.bp-HomeControls .bp-pill-container-variant'),
        document.querySelector('.bp-HomeControls'),
        document.querySelector('[class*="pill-container"]')
      ]);
      // Prepended, so we're the leftmost control in the row. The row overflows rather
      // than wraps once the side panel narrows the viewport, and an appended button
      // ended up off the right edge of the page where it couldn't be found.
      if (actionRow) return { container: actionRow, insertAfter: null, position: 'prepend' };

      // No action bar on this listing state (verified on a Coming Soon listing, which
      // has no Share/Save controls at all). Sit after the address instead of nowhere --
      // appended here, because prepending would put us ahead of the address itself.
      const nearAddress = P.firstUsable([
        document.querySelector('.bp-homeAddress')?.parentElement,
        document.querySelector('.home-main-stats-variant')?.parentElement
      ]);
      return nearAddress ? { container: nearAddress, insertAfter: null, position: 'append' } : null;
    },

    extractFromDetailPage() {
      // Rental-listing template: no .home-main-stats-variant, no .bp-homeAddress --
      // <h1> is the reliable address source here, the same fallback Zillow's own
      // extractor already leans on.
      if (isRentalTemplate()) {
        const address = document.querySelector('h1')?.textContent?.trim() ?? null;
        const price = readRentalStat('stat-price');
        if (!address || !price) return null;

        const geo = geoFromLdJson(document, P.redfinPropertyId(window.location.pathname));
        return {
          source: 'redfin',
          address,
          price,
          beds: readRentalStat('stat-beds'),
          baths: readRentalStat('stat-baths'),
          sqft: readRentalStat('stat-sqft'),
          propertyID: P.redfinPropertyId(window.location.pathname),
          url: geo?.url ?? window.location.href,
          latitude: geo?.latitude ?? null,
          longitude: geo?.longitude ?? null,
          // Rentals don't carry an HOA line the way for-sale listings do.
          hoa: null
        };
      }

      const statsContainer = document.querySelector('.home-main-stats-variant');
      if (!statsContainer) return null;

      const address = document.querySelector('.bp-homeAddress .full-address')?.textContent?.trim() ?? null;
      const price = readStat(statsContainer, 'abp-price');
      if (!address || !price) return null;

      let hoa = null;
      for (const el of document.querySelectorAll('.KeyDetailsTable .valueType')) {
        if (el.textContent === 'HOA Dues') {
          // The value cell is just "$145/month" -- the "HOA Dues" label is what
          // identified it, so parse a bare amount rather than requiring "HOA" in it.
          hoa = P.parseMoneyAmount(el.closest('.keyDetails-row')?.querySelector('.valueText')?.textContent);
          break;
        }
      }

      // Scoped to this listing: an SPA navigation can leave the previous listing's blob in
      // the document, and its coordinates would drive a rent estimate for the wrong house.
      const geo = geoFromLdJson(document, P.redfinPropertyId(window.location.pathname));

      return {
        source: 'redfin',
        address,
        price,
        beds: readStat(statsContainer, 'abp-beds'),
        baths: readStat(statsContainer, 'abp-baths'),
        sqft: readStat(statsContainer, 'abp-sqFt'),
        propertyID: P.redfinPropertyId(window.location.pathname),
        url: geo?.url ?? window.location.href,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        hoa
      };
    },

    findCardElements() {
      const seen = new Set();
      const out = [];
      for (const el of document.querySelectorAll('div.bp-Homecard__Content')) {
        seen.add(el);
        out.push(el);
      }
      // Map hover cards and any .bp-Homecard whose content wasn't reached above.
      for (const card of document.querySelectorAll('.bp-Homecard')) {
        const contentEl = card.querySelector('.bp-Homecard__Content') || card;
        if (!seen.has(contentEl)) {
          seen.add(contentEl);
          out.push(contentEl);
        }
      }
      return out;
    },

    isInjectableCard(contentEl) {
      if (!contentEl) return false;
      const isAd = Boolean(
        contentEl.closest('.InlineResultStaticPlacement') ||
        contentEl.closest('.nativeAd') ||
        contentEl.closest('.DisplayAd') ||
        contentEl.closest('.DisplayAdWrapper') ||
        contentEl.closest('[aria-label="Advertisement"]')
      );
      if (isAd) return false;
      return Boolean(
        contentEl.querySelector('.bp-Homecard__Address') ||
        contentEl.querySelector('.bp-Homecard__Price--value') ||
        contentEl.querySelector('a[href*="/"]')
      );
    },

    /** Sit next to Favorite/Share so we inherit the same click treatment. */
    cardInjectionTarget(contentEl) {
      const shareEl = contentEl.querySelector('.bp-ShareExtension');
      const favoriteEl = contentEl.querySelector('.bp-FavoriteExtension');
      if (shareEl?.parentElement) {
        return { container: shareEl.parentElement, insertAfter: favoriteEl || shareEl };
      }
      const priceEl = contentEl.querySelector('.bp-Homecard__Price');
      if (priceEl?.parentElement) return { container: priceEl.parentElement, insertAfter: null };
      const firstFlex = contentEl.querySelector('.flex');
      if (firstFlex) return { container: firstFlex, insertAfter: null };
      return { container: contentEl.firstElementChild || contentEl, insertAfter: null };
    },

    extractFromCard(contentEl) {
      if (!contentEl) return null;
      // separatedText throughout: the stats block's own spans concatenate without a
      // separator, and falling back to the whole card would glue the price on as well.
      const statsEl = contentEl.querySelector('.bp-Homecard__Stats');
      const facts = P.parseBedBathSqft(P.separatedText(statsEl ?? contentEl));
      const geo = geoFromLdJson(contentEl);

      let hoa = null;
      for (const fact of contentEl.querySelectorAll('.KeyFacts-item')) {
        hoa = P.parseHoa(fact.textContent);
        if (hoa !== null) break;
      }

      return {
        source: 'redfin',
        address: contentEl.querySelector('.bp-Homecard__Address')?.textContent?.trim() ?? null,
        price: contentEl.querySelector('.bp-Homecard__Price--value')?.textContent?.trim() ?? null,
        beds: facts.beds,
        baths: facts.baths,
        sqft: facts.sqft,
        // From the card's link. textContent cannot see href attributes, so the old
        // approach only worked where Redfin embedded ld+json in the card.
        propertyID: propertyIdFromCard(contentEl),
        url: listingUrlFromCard(contentEl) ?? geo?.url ?? null,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
        hoa
      };
    },

    /**
     * Comp-mode extras for a results-page card: the raw price text (parsed by
     * SidecarParsers.parseCompAmount), the label above it -- "Last list price" on a sold
     * card, since Redfin never shows a true sold price in a non-disclosure state -- and
     * the card's own text, which carries the sold-date sash ("SOLD MAY 28, 2026") for
     * the caller to pull a date out of. See docs/comp-workflow.md §3.
     */
    compFacts(contentEl) {
      if (!contentEl) return null;
      return {
        amountText: contentEl.querySelector('.bp-Homecard__Price--value')?.textContent?.trim() ?? null,
        priceLabel: contentEl.querySelector('.bp-Homecard__Price--label')?.textContent?.trim() ?? null,
        soldDateText: P.separatedText(contentEl)
      };
    },

    /**
     * Redfin's table view has a single action bar for the selected row rather than
     * per-card buttons. Returned as an "extra" target the driver injects into.
     */
    extraInjectionTargets() {
      const bar = document.querySelector('.ActionBar__homeActionButtons.flex');
      if (!bar) return [];
      return [{
        container: bar,
        insertAfter: null,
        // The table action bar styles its buttons differently from card actions.
        className: 'bp-shareButtonWrapper bp-HomeActionsButton bp-CalculatorExtension',
        extract: () => {
          const card = document.querySelector('.TableViewHomecardSection.flex .bp-Homecard');
          if (!card) return null;
          const facts = P.parseBedBathSqft(P.separatedText(card.querySelector('.bp-Homecard__Stats')));
          const geo = geoFromLdJson(card);
          const hoaEl = card.closest('.TableViewHomecardSection')
            ?.querySelector('.AmenitiesRow .value[data-rf-test-name="homecard-amenities-hoa"]');
          return {
            source: 'redfin',
            address: card.querySelector('.bp-Homecard__Address')?.textContent?.trim() ?? null,
            price: card.querySelector('.bp-Homecard__Price--value')?.textContent?.trim() ?? null,
            beds: facts.beds,
            baths: facts.baths,
            sqft: facts.sqft,
            propertyID: propertyIdFromCard(card),
            url: listingUrlFromCard(card) ?? geo?.url ?? null,
            latitude: geo?.latitude ?? null,
            longitude: geo?.longitude ?? null,
            hoa: hoaEl ? P.parseHoa(hoaEl.textContent) : null
          };
        },
        missingDataReason: "Couldn't read this row's details."
      }];
    },

    /** Classes that make our button look native next to Redfin's own card actions. */
    cardButtonClassName: 'bp-ShareExtension bp-CalculatorExtension',
    detailButtonClassName: 'bp-CalculatorExtension bp-Button--pill',
    detailWrapperClassName: 'HomeControlButtonWrapper',

    /**
     * The element the site's own map pins live in. Watched by content.js's reposition
     * observer, and the container our own injected pins get appended into -- Redfin
     * positions pins with position:absolute; left/top directly inside it (verified live,
     * docs/map-linking.md §1.1/Option 3), so ours follow the same convention.
     */
    mapPinContainer() {
      return document.querySelector('.HomeMarkersContainer');
    },

    mapClipElement() {
      return document.querySelector('#search-map-wrapper');
    },

    mapPinAnchorOffset() {
      return { dx: 6, dy: 6 };
    },

    nativeMapPinForHouse(house) {
      const latitude = Number(house?.latitude);
      const longitude = Number(house?.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      const matches = [];
      for (const pin of document.querySelectorAll('.HomeMarkersContainer .Pushpin[latitude][longitude]')) {
        const pinLatitude = Number(pin.getAttribute('latitude'));
        const pinLongitude = Number(pin.getAttribute('longitude'));
        if (!Number.isFinite(pinLatitude) || !Number.isFinite(pinLongitude)) continue;
        const distance = Math.hypot(pinLatitude - latitude, pinLongitude - longitude);
        matches.push({ pin, distance });
      }
      matches.sort((a, b) => a.distance - b.distance);
      const nearest = matches[0];
      if (!nearest || nearest.distance > 0.00025) return null;
      const runnerUp = matches[1];
      if (runnerUp && nearest.distance > 0.000001 && runnerUp.distance < nearest.distance * 2) return null;
      return nearest.pin;
    },

    /**
     * Fits a lat/lon -> screen-px projection from two of the site's own rendered pins.
     *
     * Redfin needs no calibration at all: every pin carries its own latitude/longitude
     * attributes *and* its own left/top position, so any two pins are enough to fit the
     * projection directly (verified live: reproduced all 330 on-screen pins to within
     * 0.001px). Anchors are chosen for maximum spread rather than DOM order, so the fit
     * isn't destabilized by two near-neighbor pins landing first in the container.
     *
     * Returns null -- rather than a broken fit -- when the map isn't on screen yet or
     * fewer than two pins carry usable geometry; every caller must treat that as "don't
     * draw anything yet," not an error.
     */
    buildMapProjection() {
      const container = this.mapPinContainer();
      if (!container) return null;

      const pins = [];
      for (const el of container.querySelectorAll('.Pushpin[latitude][longitude]')) {
        const lat = Number(el.getAttribute('latitude'));
        const lon = Number(el.getAttribute('longitude'));
        const x = parseFloat(el.style.left);
        const y = parseFloat(el.style.top);
        if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(x) && Number.isFinite(y)) {
          pins.push({ lat, lon, x, y });
        }
      }
      if (pins.length < 2) return null;

      const spread = (key) => {
        let min = pins[0], max = pins[0];
        for (const p of pins) {
          if (p[key] < min[key]) min = p;
          if (p[key] > max[key]) max = p;
        }
        return [min, max];
      };

      const [minLon, maxLon] = spread('lon');
      let fit = SidecarGeoProjection.fit(minLon, maxLon);
      if (!fit) {
        // Every pin shares a longitude (a near-vertical view) -- fit off latitude spread
        // instead of giving up on a projection that a wider pair would have found.
        const [minLat, maxLat] = spread('lat');
        fit = SidecarGeoProjection.fit(minLat, maxLat);
      }
      if (!fit) return null;

      const clipEl = this.mapClipElement();
      return {
        container,
        fit,
        clip: clipEl ? clipEl.getBoundingClientRect() : null,
        anchor: this.mapPinAnchorOffset()
      };
    },

    /** Projects a (lat, lon) through a projection built by buildMapProjection(). */
    projectPoint(projection, lat, lon) {
      return projection ? SidecarGeoProjection.project(projection.fit, lat, lon) : null;
    },

    diagnostics() {
      return {
        cards: document.querySelectorAll('div.bp-Homecard__Content').length,
        detailPage: this.isDetailPage(),
        detailTarget: !!this.detailInjectionTarget(),
        rentalDetailTemplate: !!document.querySelector('.stat-block.price-section'),
        tableBar: !!document.querySelector('.ActionBar__homeActionButtons.flex'),
        mapPinContainer: !!this.mapPinContainer(),
        mapProjection: !!this.buildMapProjection()
      };
    }
  };
})();
