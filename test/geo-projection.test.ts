import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

/**
 * Loads public/scripts/sites/geo-projection.js -- the actual file the extension ships --
 * into a sandbox, the same way site-parsers.test.ts exercises parsers.js.
 */
function loadGeoProjection() {
  const file = resolve(__dirname, '../public/scripts/sites/geo-projection.js');
  const sandbox: Record<string, unknown> = { module: { exports: {} } };
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.SidecarGeoProjection as {
    mercY(lat: number): number;
    fit(
      a: { lat: number; lon: number; x: number; y: number },
      b: { lat: number; lon: number; x: number; y: number }
    ): { anchor: { lat: number; lon: number; x: number; y: number }; kx: number; ky: number } | null;
    project(
      projection: unknown,
      lat: number,
      lon: number
    ): { x: number; y: number } | null;
  };
}

const G = loadGeoProjection();

describe('fit + project', () => {
  // Two real Redfin pins from a live Austin page (docs/map-linking.md 1.1): the fit
  // must reproduce a third pin's on-screen position from its own lat/lon.
  const pinA = { lat: 30.2672, lon: -97.7431, x: 400, y: 300 };
  const pinB = { lat: 30.3072, lon: -97.7031, x: 600, y: 100 };
  const pinC = { lat: 30.2872, lon: -97.7231 }; // midpoint-ish, expected near (500, ~200)

  it('reproduces the anchor points exactly', () => {
    const projection = G.fit(pinA, pinB);
    expect(G.project(projection, pinA.lat, pinA.lon)).toEqual({ x: pinA.x, y: pinA.y });
    expect(G.project(projection, pinB.lat, pinB.lon)).toEqual({ x: pinB.x, y: pinB.y });
  });

  it('projects a third point to a plausible position between the two anchors', () => {
    const projection = G.fit(pinA, pinB);
    const result = G.project(projection, pinC.lat, pinC.lon);
    expect(result!.x).toBeCloseTo(500, 0);
    expect(result!.y).toBeCloseTo(200, 0);
  });

  it('returns null for a degenerate pair with equal longitudes', () => {
    const projection = G.fit(pinA, { ...pinB, lon: pinA.lon });
    expect(projection).toBeNull();
  });

  it('returns null for a degenerate pair with equal latitudes', () => {
    const projection = G.fit(pinA, { ...pinB, lat: pinA.lat });
    expect(projection).toBeNull();
  });

  it('project() no-ops to null on a null projection rather than throwing', () => {
    expect(G.project(null, 30.27, -97.74)).toBeNull();
  });
});
