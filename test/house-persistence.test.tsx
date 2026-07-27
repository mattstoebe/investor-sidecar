import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HouseCard, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters } from '../src/App';

/**
 * How a card persists its per-house overrides. It does not write storage: every card doing
 * its own read-modify-write of the single storedHouses array meant two overlapping saves
 * each spread a stale snapshot over the other and one edit vanished silently. The card now
 * sends the fields it owns to the service worker, which is the sole writer and serializes
 * every mutation. The merge itself is covered in test/house-storage.test.ts.
 */

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const localParams = (overrides: Partial<NonNullable<House['localParams']>> = {}) => ({
  percentDown: null, interestRate: null, price: null,
  additionalCashInvestment: 0, sliderValue: 2000, propertyTaxRate: null,
  vacancyRate: null, maintenanceRate: null, capExRate: null,
  managementRate: null, insuranceRate: null,
  ...overrides
}) as NonNullable<House['localParams']>;

const house = (overrides: Partial<House> = {}): House => ({
  address: '123 Example St, Fort Worth, TX 76179',
  price: '$425,000',
  beds: '3', baths: '2', sqft: '1800',
  propertyID: '12345',
  url: 'https://www.redfin.com/TX/Fort-Worth/123-Example-St/home/12345',
  latitude: 32.7, longitude: -97.3,
  ...overrides
});

const seed = async (h: House) => {
  await chrome.storage.local.set({ storedHouses: [h] });
  vi.mocked(chrome.storage.local.set).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, saved: true });
};

/** The updateLocalParams messages the card sent, newest last. */
const sentUpdates = () =>
  vi.mocked(chrome.runtime.sendMessage).mock.calls
    .map(([msg]) => msg as { action?: string; localParams?: Record<string, unknown>; propertyID?: string })
    .filter((msg) => msg?.action === 'updateLocalParams');

describe('per-house parameter persistence', () => {
  /**
   * The effect used to write on mount, echoing back the values it had just read -- N of those
   * per panel open, each a chance to clobber a concurrent capture.
   */
  it('sends nothing on mount', async () => {
    const h = house({ localParams: localParams() });
    await seed(h);

    render(<HouseCard house={h} globalParams={globalParams} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(sentUpdates()).toHaveLength(0);
  });

  it('never writes storedHouses directly -- the worker owns that key', async () => {
    const h = house({ localParams: localParams() });
    await seed(h);

    render(<HouseCard house={h} globalParams={globalParams} />);
    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '3100' } });

    await waitFor(() => expect(sentUpdates()).toHaveLength(1));
    const wroteHouses = vi.mocked(chrome.storage.local.set).mock.calls
      .some(([items]) => 'storedHouses' in (items as Record<string, unknown>));
    expect(wroteHouses).toBe(false);
  });

  it('sends the edited value to the worker', async () => {
    const h = house({ localParams: localParams() });
    await seed(h);

    render(<HouseCard house={h} globalParams={globalParams} />);
    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '3100' } });

    await waitFor(() => expect(sentUpdates()).toHaveLength(1));
    const [update] = sentUpdates();
    expect(update.propertyID).toBe('12345');
    expect(update.localParams?.sliderValue).toBe(3100);
  });

  /**
   * The card sends only the fields it owns. Anything else in localParams -- the per-house
   * mode override, an API-seeded tax rate -- is the worker's to preserve, so the card must
   * not send a key that would blank it.
   */
  it('does not send fields it does not own, so the worker can preserve them', async () => {
    const h = house({ localParams: localParams({ mode: 'rental' }) });
    await seed(h);

    render(<HouseCard house={h} globalParams={globalParams} />);
    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '2600' } });

    await waitFor(() => expect(sentUpdates()).toHaveLength(1));
    const [update] = sentUpdates();
    expect(update.localParams).not.toHaveProperty('mode');
    expect(update.localParams?.sliderValue).toBe(2600);
  });

  it('reports a rejected save rather than assuming it worked', async () => {
    const h = house({ localParams: localParams() });
    await seed(h);
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: false, reason: 'Chrome storage failed' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<HouseCard house={h} globalParams={globalParams} />);
    fireEvent.change(screen.getByTestId('rent-field'), { target: { value: '3300' } });

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(consoleError.mock.calls.flat().join(' ')).toMatch(/Chrome storage failed/);
    consoleError.mockRestore();
  });
});
