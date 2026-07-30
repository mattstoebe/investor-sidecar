import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HouseCard, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters, Comp } from '../src/App';
import type { MetricKey } from '../src/metrics';

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const house = (overrides: Partial<House> = {}): House => ({
  address: '123 Example St, Fort Worth, TX 76179',
  price: '$425,000',
  beds: '3',
  baths: '2',
  sqft: '1800',
  propertyID: '12345',
  url: 'https://www.redfin.com/TX/Fort-Worth/123-Example-St/home/12345',
  latitude: 32.7,
  longitude: -97.3,
  ...overrides
});

describe('HouseCard', () => {
  it('renders a normal house with its address and figures', () => {
    render(<HouseCard house={house()} globalParams={globalParams} />);

    expect(screen.getByTestId('house-card')).toBeInTheDocument();
    expect(screen.getByText(/123 Example St/)).toBeInTheDocument();
    // No rent saved on this fixture. The hint takes the strip's place rather than sitting
    // under a row of dashes, so the strip is absent entirely.
    expect(screen.getByTestId('needs-rent-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('verdict-strip')).not.toBeInTheDocument();
  });

  it('collapses all card detail behind a status-bearing header', () => {
    render(<HouseCard house={house()} globalParams={globalParams} />);

    const toggle = screen.getByTestId('toggle-house-card');
    const dot = screen.getByTestId('house-status-dot');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(dot).toHaveAttribute('aria-label', 'Primary metric is not ready');
    expect(dot).toHaveClass('bg-gray-300');
    expect(screen.getByTestId('rent-field')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('rent-field')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remove house')).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByTestId('rent-field')).toBeInTheDocument();
  });

  // The regression that made houses silently vanish from the panel.
  it.each([
    ['an unreadable price', { price: 'N/A' }],
    ['an empty price', { price: '' }],
    ['a zero price', { price: '$0' }],
    ['a missing address', { address: '' }]
  ])('still renders when the listing has %s', (_label, overrides) => {
    render(<HouseCard house={house(overrides as Partial<House>)} globalParams={globalParams} />);
    expect(screen.getByTestId('house-card')).toBeInTheDocument();
  });

  it('explains why cashflow is unavailable instead of showing nothing', () => {
    render(<HouseCard house={house({ price: 'N/A' })} globalParams={globalParams} />);

    expect(screen.getByTestId('analysis-error')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-error')).toHaveTextContent(/readable price/i);
    // Nothing to analyse means neither the strip nor the hint -- just the reason.
    expect(screen.queryByTestId('verdict-strip')).not.toBeInTheDocument();
  });

  it('renders missing beds and baths as a dash, not "undefined"', () => {
    render(
      <HouseCard
        house={house({ beds: undefined as unknown as string, baths: undefined as unknown as string })}
        globalParams={globalParams}
      />
    );

    const card = screen.getByTestId('house-card');
    expect(card).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/undefined/);
  });

  // Was rendered to the user as the literal string "Infinity%".
  it('shows a dash rather than Infinity when nothing is invested', () => {
    // Zero down and zero closing costs, so total cash invested is genuinely $0 --
    // the case a real % down of 0 with no closing-cost assumption used to divide by zero on.
    // Cash-on-cash isn't in the default card metrics, so ask for it explicitly.
    const zeroCostGlobals: GlobalParameters = {
      ...globalParams,
      closingCostRate: 0,
      cardMetrics: { rental: ['cashOnCash', 'capRate', 'dscr'] }
    };
    render(
      <HouseCard
        house={house({
          localParams: {
            percentDown: 0,
            interestRate: null,
            price: null,
            sliderValue: 3000,
            additionalCashInvestment: 0,
            propertyTaxRate: null,
            vacancyRate: null,
            maintenanceRate: null,
            capExRate: null,
            managementRate: null,
            insuranceRate: null
          }
        })}
        globalParams={zeroCostGlobals}
      />
    );

    const coc = screen.getByTestId('cash-on-cash');
    expect(coc).toHaveTextContent('—');
    expect(coc.textContent).not.toMatch(/Infinity|NaN/);
  });

  // Deliberately inverted: there is no tax service, so reporting its failure told the user
  // about a feature that doesn't exist. Pinned so the message can't reappear by accident.
  it('stays silent about tax lookup failures while there is no tax service', () => {
    render(
      <HouseCard house={house({ taxError: 'Missing zip code' })} globalParams={globalParams} />
    );
    expect(screen.queryByText(/tax lookup/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing zip code/)).not.toBeInTheDocument();
  });

  it('stays silent about rent lookup failures while there is no rent service', () => {
    render(
      <HouseCard house={house({ rentError: 'Missing latitude/longitude' })} globalParams={globalParams} />
    );
    expect(screen.queryByTestId('rent-unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing latitude\/longitude/)).not.toBeInTheDocument();
  });

  it('prompts for rent instead of showing returns computed against $0 income', () => {
    render(<HouseCard house={house()} globalParams={globalParams} />);
    expect(screen.getByTestId('needs-rent-hint')).toBeInTheDocument();
    // No strip at all, so there are no misleading figures to misread.
    expect(screen.queryByTestId('verdict-strip')).not.toBeInTheDocument();
    for (const id of ['monthly-cash-flow', 'cap-rate', 'cash-on-cash', 'dscr']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });

  it('renders exactly the three metrics chosen in the panel, in order', () => {
    const withRent = house({
      localParams: {
        percentDown: null, interestRate: null, price: null,
        additionalCashInvestment: 0, sliderValue: 3000, propertyTaxRate: null,
        vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null
      }
    });
    render(
      <HouseCard
        house={withRent}
        globalParams={{ ...globalParams, cardMetrics: { rental: ['grm', 'opexRatio', 'breakEvenRent'] } }}
      />
    );

    const strip = screen.getByTestId('verdict-strip');
    const rendered = [...strip.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));
    expect(rendered).toEqual(['grm', 'opex-ratio', 'break-even-rent']);
    // The defaults are not rendered when they weren't chosen.
    expect(screen.queryByTestId('monthly-cash-flow')).not.toBeInTheDocument();
  });

  it('falls back to defaults when the stored metric selection is unusable', () => {
    const withRent = house({
      localParams: {
        percentDown: null, interestRate: null, price: null,
        additionalCashInvestment: 0, sliderValue: 3000, propertyTaxRate: null,
        vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null
      }
    });
    render(
      <HouseCard
        house={withRent}
        globalParams={{
          ...globalParams,
          // A key that no longer exists plus a duplicate: what a stale storage value looks like.
          cardMetrics: { rental: ['notAMetric' as unknown as MetricKey, 'capRate', 'capRate'] }
        }}
      />
    );

    const strip = screen.getByTestId('verdict-strip');
    const rendered = [...strip.querySelectorAll('[data-testid]')].map((el) => el.getAttribute('data-testid'));
    expect(rendered).toHaveLength(3);
    expect(new Set(rendered).size).toBe(3);
    expect(rendered).toContain('cap-rate');
  });

  it('shows the verdict strip once rent is known from a saved slider value', () => {
    render(
      <HouseCard
        house={house({
          localParams: {
            percentDown: null, interestRate: null, price: null,
            additionalCashInvestment: 0, sliderValue: 3000, propertyTaxRate: null,
            vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null
          }
        })}
        globalParams={globalParams}
      />
    );

    expect(screen.queryByTestId('needs-rent-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('monthly-cash-flow')).toHaveTextContent(/\$-?[\d,]+/);
    expect(screen.getByTestId('cap-rate')).toHaveTextContent(/%/);
    expect(screen.getByTestId('dscr')).toHaveTextContent(/x$/);
  });

  it('a per-house rate override in the expenses dropdown changes the computed figures', () => {
    const withDefaultVacancy = house({
      localParams: {
        percentDown: null, interestRate: null, price: null,
        additionalCashInvestment: 0, sliderValue: 2000, propertyTaxRate: null,
        vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null
      }
    });
    const withOverriddenVacancy = house({
      localParams: {
        percentDown: null, interestRate: null, price: null,
        additionalCashInvestment: 0, sliderValue: 2000, propertyTaxRate: null,
        vacancyRate: 50, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null
      }
    });

    const { unmount } = render(<HouseCard house={withDefaultVacancy} globalParams={globalParams} />);
    const defaultCashFlow = screen.getByTestId('monthly-cash-flow').textContent;
    unmount();

    render(<HouseCard house={withOverriddenVacancy} globalParams={globalParams} />);
    const overriddenCashFlow = screen.getByTestId('monthly-cash-flow').textContent;

    // A 50% vacancy override should visibly drag cash flow down relative to the global default.
    expect(overriddenCashFlow).not.toBe(defaultCashFlow);
  });

  /**
   * Regression: switching a house's mode while a section only the old mode has (Rent,
   * absent from Flip) is open used to crash the whole card. `openSection` survives the
   * mode switch as component state; `MODES['flip'].sections.find(s => s.id === 'rent')`
   * then returns undefined, and the render used to call renderSection on it unguarded.
   */
  it('does not crash when the mode changes away from a section that is open', () => {
    const { rerender } = render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('toggle-income'));
    expect(screen.getByTestId('rent-field')).toBeInTheDocument();

    rerender(
      <HouseCard
        house={house({ localParams: { mode: 'flip', arv: 520000 } })}
        globalParams={globalParams}
      />
    );

    expect(screen.getByTestId('house-card')).toBeInTheDocument();
    expect(screen.queryByTestId('rent-field')).not.toBeInTheDocument();
  });
});

/**
 * Comps in the card. These exercise the panel half of docs/comp-workflow.md: dots and a
 * list render from house.comps (never written by this card, only by the worker), and
 * picking a comp goes through setParam + commit -- the same path a keystroke takes.
 */
describe('HouseCard comps', () => {
  const rentComp = (over: Partial<Comp> = {}): Comp => ({
    source: 'redfin', propertyID: '555', kind: 'rent', address: '456 Comp Ave, Austin, TX 78745',
    amount: 2100, amountLabel: 'rent', beds: '3', baths: '2', sqft: '1400',
    url: 'https://www.redfin.com/x/455/home/555', soldDate: null, capturedAt: 1_000,
    ...over
  });

  it('shows all three rent-comp sources even with no comps yet', () => {
    render(<HouseCard house={house()} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('toggle-income'));
    expect(screen.getByTestId('find-rent-comps-redfin')).toBeInTheDocument();
    expect(screen.getByTestId('find-rent-comps-zillow')).toBeInTheDocument();
    expect(screen.getByTestId('find-rent-comps-homes')).toBeInTheDocument();
    expect(screen.queryByTestId('comp-dots')).not.toBeInTheDocument();
  });

  it('renders a dot and a list row for each rent comp once the section is open', () => {
    render(
      <HouseCard
        house={house({ comps: [rentComp({ propertyID: '1' }), rentComp({ propertyID: '2', amount: 2400 })] })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('toggle-income'));

    expect(screen.getAllByTestId('comp-dot')).toHaveLength(2);
    expect(screen.getByTestId('comp-list')).toHaveTextContent('2 comps');
    expect(screen.getByTestId('comp-list')).toHaveTextContent('456 Comp Ave, Austin, TX 78745');
  });

  it('clicking a comp dot sets rent to that comp\'s amount', () => {
    render(
      <HouseCard
        house={house({
          localParams: { sliderValue: 0, percentDown: null, interestRate: null, price: null, additionalCashInvestment: 0, propertyTaxRate: null, vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null },
          comps: [rentComp({ amount: 2750 })]
        })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('toggle-income'));
    fireEvent.click(screen.getByTestId('comp-dot'));

    expect(screen.getByTestId('rent-field')).toHaveValue('$2,750');
  });

  it('"Use median" adopts the median of the comps shown', () => {
    render(
      <HouseCard
        house={house({
          localParams: { sliderValue: 0, percentDown: null, interestRate: null, price: null, additionalCashInvestment: 0, propertyTaxRate: null, vacancyRate: null, maintenanceRate: null, capExRate: null, managementRate: null, insuranceRate: null },
          comps: [rentComp({ propertyID: '1', amount: 2000 }), rentComp({ propertyID: '2', amount: 3000 }), rentComp({ propertyID: '3', amount: 2500 })]
        })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('toggle-income'));
    fireEvent.click(screen.getByText('Use median'));

    expect(screen.getByTestId('rent-field')).toHaveValue('$2,500');
  });

  it('removing a comp sends removeComp with the target house and comp identity', () => {
    render(
      <HouseCard
        house={house({ propertyID: '999', comps: [rentComp()] })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('toggle-income'));
    fireEvent.click(screen.getByLabelText(/Remove comp/));

    const sent = vi.mocked(chrome.runtime.sendMessage).mock.calls
      .map(([msg]) => msg as { action?: string; targetKey?: string; compKey?: string })
      .find((msg) => msg?.action === 'removeComp');
    expect(sent?.targetKey).toBe('redfin:999');
    expect(sent?.compKey).toBe('redfin:555:rent');
  });

  it('shows source-selectable sale comps and sale comps under a flip\'s ARV section', () => {
    render(
      <HouseCard
        house={house({
          localParams: { sliderValue: 0, mode: 'flip', arv: 520000 },
          comps: [rentComp({ kind: 'sold', amount: 495000, amountLabel: 'last-list' })]
        })}
        globalParams={globalParams}
      />
    );
    fireEvent.click(screen.getByTestId('toggle-resale'));

    expect(screen.getByTestId('find-sale-comps-redfin')).toBeInTheDocument();
    expect(screen.getByTestId('find-sale-comps-zillow')).toBeInTheDocument();
    expect(screen.getByTestId('find-sale-comps-homes')).toBeInTheDocument();
    expect(screen.getByTestId('comp-dot')).toBeInTheDocument();
    expect(screen.getByTestId('comp-list')).toHaveTextContent('(last list)');
  });

  it('starts a comp session for the selected source and the same subject house', () => {
    render(<HouseCard house={house({ propertyID: '777' })} globalParams={globalParams} />);
    fireEvent.click(screen.getByTestId('toggle-income'));
    fireEvent.click(screen.getByTestId('find-rent-comps-zillow'));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'startCompSession', targetKey: 'redfin:777', kind: 'rent', searchSource: 'zillow' })
    );
  });
});
