import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { HouseCard, UndoToast, DEFAULT_GLOBAL_PARAMETERS } from '../src/App';
import type { House, GlobalParameters } from '../src/App';

/**
 * The panel half of undo: telling the user something is reversible, and asking the worker to
 * reverse it. The panel never applies an inverse itself -- it does not even receive one.
 */

const globalParams: GlobalParameters = { ...DEFAULT_GLOBAL_PARAMETERS, propertyTaxRate: 1 };

const house = (overrides: Partial<House> = {}): House => ({
  address: '123 Example St, Fort Worth, TX 76179',
  price: '$425,000',
  beds: '3', baths: '2', sqft: '1800',
  propertyID: '12345',
  url: 'https://www.redfin.com/home/12345',
  latitude: 32.7, longitude: -97.3,
  ...overrides
});

const sent = (action: string) =>
  vi.mocked(chrome.runtime.sendMessage).mock.calls
    .map(([msg]) => msg as { action?: string; address?: string })
    .filter((msg) => msg?.action === action);

describe('removing a house', () => {
  it('names the house so the worker can label the undo', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true });
    render(<HouseCard house={house()} globalParams={globalParams} />);

    fireEvent.click(screen.getByLabelText('Remove house'));

    const removals = sent('removeHouse');
    expect(removals).toHaveLength(1);
    expect(removals[0].address).toBe('123 Example St, Fort Worth, TX 76179');
  });

  it('tells the panel what was removed, so the offer can name it', () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true });
    const onRemoved = vi.fn();
    render(<HouseCard house={house()} globalParams={globalParams} onRemoved={onRemoved} />);

    fireEvent.click(screen.getByLabelText('Remove house'));
    expect(onRemoved).toHaveBeenCalledWith('123 Example St, Fort Worth, TX 76179');
  });

  /** A card that is not wired to a panel must still delete rather than throw. */
  it('removes without a listener attached', () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true });
    render(<HouseCard house={house()} globalParams={globalParams} />);
    expect(() => fireEvent.click(screen.getByLabelText('Remove house'))).not.toThrow();
  });
});

describe('UndoToast', () => {
  it('says what it will reverse', () => {
    render(<UndoToast message="Removed 123 Example St" onUndo={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId('undo-toast')).toHaveTextContent('Removed 123 Example St');
  });

  it('asks to undo when pressed', () => {
    const onUndo = vi.fn();
    render(<UndoToast message="Removed a house" onUndo={onUndo} onDismiss={() => {}} />);
    fireEvent.click(screen.getByTestId('undo-button'));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('can be dismissed outright', () => {
    const onDismiss = vi.fn();
    render(<UndoToast message="Removed a house" onUndo={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  /** An offer that outlives the moment reads as a warning that something is still wrong. */
  it('withdraws the offer on its own', async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<UndoToast message="Removed a house" onUndo={() => {}} onDismiss={onDismiss} />);
    expect(onDismiss).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(8000); });
    expect(onDismiss).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('stops its timer when it goes away, so a dismissed toast cannot fire later', async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { unmount } = render(<UndoToast message="x" onUndo={() => {}} onDismiss={onDismiss} />);
    unmount();

    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(onDismiss).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

/**
 * The panel is told how deep the log is and what the top entry was -- never the inverses. It
 * cannot apply one even if it wanted to, which is the point: the worker is the only serialized
 * writer of storedHouses, and undo is a write like any other.
 */
describe('the panel end to end', () => {
  const renderPanel = async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, undone: true });
    await chrome.storage.local.set({ storedHouses: [house()] });
    const { default: SidePanel } = await import('../src/App');
    render(<SidePanel />);
    await screen.findByTestId('house-card');

    // The worker's broadcast is what tells the panel there is anything to undo.
    const listener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls.at(-1)?.[0] as
      (message: unknown) => void;
    return {
      broadcast: async (undo: { depth: number; label: string | null }, houses: House[] = [house()]) => {
        await act(async () => { listener({ action: 'updateSidePanel', houses, undo }); });
      }
    };
  };

  it('offers to undo a removal, and asks the worker to do it', async () => {
    const { broadcast } = await renderPanel();

    fireEvent.click(screen.getByLabelText('Remove house'));
    await broadcast({ depth: 1, label: 'Removed 123 Example St' }, []);

    const toast = await screen.findByTestId('undo-toast');
    expect(toast).toHaveTextContent('Removed 123 Example St');

    vi.mocked(chrome.runtime.sendMessage).mockClear();
    fireEvent.click(screen.getByTestId('undo-button'));
    await waitFor(() => expect(sent('undo')).toHaveLength(1));
  });

  /**
   * The worker drops entries it can no longer apply, so the log can empty underneath the
   * panel. Offering an Undo that would do nothing is worse than offering none.
   */
  it('withholds the offer once the log is empty', async () => {
    const { broadcast } = await renderPanel();

    fireEvent.click(screen.getByLabelText('Remove house'));
    await broadcast({ depth: 0, label: null }, []);

    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('undoes on the keyboard as well', async () => {
    const { broadcast } = await renderPanel();
    await broadcast({ depth: 1, label: 'Changed assumptions' });

    vi.mocked(chrome.runtime.sendMessage).mockClear();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    await waitFor(() => expect(sent('undo')).toHaveLength(1));
  });

  /** The text buffer owns undo inside a field; stealing it there would eat a keystroke. */
  it('leaves undo alone while a field has focus', async () => {
    const { broadcast } = await renderPanel();
    await broadcast({ depth: 1, label: 'Changed assumptions' });

    const field = screen.getByTestId('rent-field');
    field.focus();
    vi.mocked(chrome.runtime.sendMessage).mockClear();
    fireEvent.keyDown(field, { key: 'z', metaKey: true });

    expect(sent('undo')).toHaveLength(0);
  });

  it('ignores redo, which is a different feature and not this one done badly', async () => {
    const { broadcast } = await renderPanel();
    await broadcast({ depth: 1, label: 'Changed assumptions' });

    vi.mocked(chrome.runtime.sendMessage).mockClear();
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });

    expect(sent('undo')).toHaveLength(0);
  });
});
