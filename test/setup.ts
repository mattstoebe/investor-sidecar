import '@testing-library/jest-dom/vitest';
import { vi, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Minimal in-memory stand-in for the chrome.* surface the side panel touches.
 * Enough to render components under test without a real extension host.
 */
const store: Record<string, unknown> = {};

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const wanted = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          wanted.filter((k) => k in store).map((k) => [k, store[k]])
        );
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      })
    }
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn()
    }
  }
};

vi.stubGlobal('chrome', chromeMock);

// ResizeObserver is required by recharts' ResponsiveContainer and absent in jsdom.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
);

afterEach(() => {
  cleanup();
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
});
