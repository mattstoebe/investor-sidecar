/**
 * Site-agnostic map projection math, shared by the Redfin and Zillow map-pin adapters.
 *
 * Both sites render their maps as a standard Web Mercator projection, so a screen
 * position can be recovered from two reference points -- (lat, lon) paired with their
 * on-screen (x, y) -- without knowing anything about the map library underneath. Verified
 * live against both sites in docs/map-linking.md: fit from two on-screen Redfin pins
 * reproduced all 330 pin positions to within 0.001px, and the same fit from two
 * Zillow hover-probe points matched 41/41 markers at 0.00px median error.
 */
var SidecarGeoProjection = (function () {
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

  /**
   * Fits an affine projection from two reference points, each { lat, lon, x, y }.
   *
   * Returns null on a degenerate pair -- equal longitudes or equal projected latitudes --
   * rather than dividing by zero. Callers should try a different pair rather than trust
   * an Infinity/NaN fit; two points close together on screen but far apart in the world
   * (or vice versa) also produce a numerically unstable fit worth rejecting the same way.
   */
  function fit(a, b) {
    if (!a || !b) return null;
    const dLon = a.lon - b.lon;
    const dMercY = mercY(a.lat) - mercY(b.lat);
    if (!dLon || !dMercY) return null;

    const kx = (a.x - b.x) / dLon;
    const ky = (a.y - b.y) / dMercY;
    if (!Number.isFinite(kx) || !Number.isFinite(ky)) return null;

    return { anchor: { lat: a.lat, lon: a.lon, x: a.x, y: a.y }, kx, ky };
  }

  /** Projects a (lat, lon) to screen coordinates under a fit produced by fit() above. */
  function project(projection, lat, lon) {
    if (!projection) return null;
    const { anchor, kx, ky } = projection;
    return {
      x: anchor.x + (lon - anchor.lon) * kx,
      y: anchor.y + (mercY(lat) - mercY(anchor.lat)) * ky
    };
  }

  return { mercY, fit, project };
})();
