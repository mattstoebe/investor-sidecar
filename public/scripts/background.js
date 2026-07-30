/** Service worker and sole writer of `storedHouses`. */
import {
    houseKey, applyLocalParams, stampRevision, pushUndoEntry, undoLast,
    addCompToHouse, removeCompFromHouse
} from './house-storage.js';
import { buildCompUrl } from './comp-links.js';

const COMP_SESSION_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAP_VISIBILITY = { defaultVisible: false, exceptions: [] };

function normalizeMapVisibility(value, legacyDefault = false) {
    const defaultVisible = typeof value?.defaultVisible === 'boolean'
        ? value.defaultVisible
        : Boolean(legacyDefault);
    const exceptions = Array.isArray(value?.exceptions)
        ? [...new Set(value.exceptions.filter((key) => typeof key === 'string'))]
        : [];
    return { defaultVisible, exceptions };
}

let mapVisibilityQueue = Promise.resolve();

function mutateMapVisibility(mutator) {
    const run = async () => {
        const stored = await chrome.storage.local.get(['mapVisibility', 'showHousesOnMap']);
        const current = normalizeMapVisibility(stored.mapVisibility, stored.showHousesOnMap);
        const next = normalizeMapVisibility(mutator(current));
        await chrome.storage.local.set({ mapVisibility: next });
        chrome.runtime.sendMessage({ action: 'mapVisibilityUpdated', state: next }, () => {
            void chrome.runtime.lastError;
        });
        return next;
    };
    mapVisibilityQueue = mapVisibilityQueue.then(run, run);
    return mapVisibilityQueue;
}

function notifySidePanel(houses, undoLog) {
    chrome.runtime.sendMessage({
        action: 'updateSidePanel',
        houses,
        undo: summariseUndo(undoLog)
    }, () => {
        void chrome.runtime.lastError;
    });
}

function summariseUndo(log) {
    const entries = Array.isArray(log) ? log : [];
    const top = entries[entries.length - 1];
    return { depth: entries.length, label: top ? top.label : null };
}

// Serialize all read-modify-write access to stored houses.
let storedHousesQueue = Promise.resolve();

function mutateStoredHouses(mutate, undoable) {
    const run = async () => {
        const result = await chrome.storage.local.get(['storedHouses', 'undoLog']);
        const houses = result.storedHouses || [];
        const outcome = await mutate(houses);
        if (!outcome) return null;

        const updated = Array.isArray(outcome) ? outcome : outcome.houses;
        if (!updated) return null;

        let log = Array.isArray(outcome) ? (result.undoLog || []) : outcome.undoLog;
        if (undoable) {
            const index = houses.findIndex((house) => houseKey(house) === undoable.key);
            const prior = index === -1 ? null : houses[index];
            if (prior) {
                log = pushUndoEntry(log, {
                    op: undoable.op,
                    key: undoable.key,
                    label: undoable.label,
                    index,
                    localParams: undoable.op === 'edit' ? (prior.localParams ?? null) : null,
                    house: undoable.op === 'delete' ? prior : null,
                    comps: undoable.op === 'comp' ? (prior.comps ?? null) : null
                });
            }
        }

        await chrome.storage.local.set({ storedHouses: updated, undoLog: log });
        notifySidePanel(updated, log);
        return updated;
    };
    storedHousesQueue = storedHousesQueue.then(run, run);
    return storedHousesQueue;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "addHouse") {
        (async () => {
            if (!request.house || typeof request.house !== 'object' || !request.house.propertyID) {
                sendResponse({ ok: false, reason: 'Invalid listing data.' });
                return;
            }
            try {
                const key = houseKey(request.house);
                let alreadyTracked = false;
                let enriched = false;

                await mutateStoredHouses((storedHouses) => {
                    const index = storedHouses.findIndex((house) => houseKey(house) === key);
                    alreadyTracked = index !== -1;
                    if (alreadyTracked) {
                        const current = storedHouses[index];
                        const incomingLatitude = Number(request.house.latitude);
                        const incomingLongitude = Number(request.house.longitude);
                        const needsCoordinates = !Number.isFinite(current.latitude)
                            || !Number.isFinite(current.longitude);
                        const hasCoordinates = Number.isFinite(incomingLatitude)
                            && Number.isFinite(incomingLongitude);
                        if (!needsCoordinates || !hasCoordinates) return null;

                        const updated = [...storedHouses];
                        updated[index] = stampRevision({
                            ...current,
                            latitude: incomingLatitude,
                            longitude: incomingLongitude
                        }, 'capture-geo');
                        enriched = true;
                        return updated;
                    }
                    console.log(`House added: ${key}`);
                    return [...storedHouses, stampRevision(request.house, 'capture')];
                });

                sendResponse({ ok: true, added: !alreadyTracked, enriched });
            } catch (error) {
                sendResponse({
                    ok: false,
                    reason: error instanceof Error ? error.message : 'Chrome storage failed'
                });
            }
        })();
        return true;
    }

    if (request.action === "removeHouse") {
        const { propertyID, source } = request;
        if (propertyID) {
            const key = houseKey({ propertyID, source });
            mutateStoredHouses((storedHouses) => {
                const updatedHouses = storedHouses.filter(h => houseKey(h) !== key);
                if (updatedHouses.length === storedHouses.length) return null;
                console.log("House removed:", key);
                return updatedHouses;
            }, {
                op: 'delete',
                key,
                label: request.address ? `Removed ${request.address}` : 'Removed a house'
            }).then(() => {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const tabId = tabs?.[0]?.id;
                    if (!tabId) return;
                    chrome.tabs.sendMessage(tabId, {
                        action: "houseRemoved",
                        propertyID: propertyID
                    }, () => { void chrome.runtime.lastError; });
                });
            }).catch((error) => {
                console.error('Error removing house:', error);
            });
        }
    }

    if (request.action === "updateLocalParams") {
        (async () => {
            const { propertyID, source, localParams, writer } = request;
            if (!propertyID || !localParams || typeof localParams !== 'object') {
                sendResponse({ ok: false, reason: 'Invalid parameter update.' });
                return;
            }
            try {
                const key = houseKey({ propertyID, source });
                let found = false;
                await mutateStoredHouses((houses) => {
                    const applied = applyLocalParams(houses, key, localParams, writer);
                    found = applied !== null;
                    return applied ? applied.updatedHouses : null;
                }, { op: 'edit', key, label: 'Changed assumptions' });
                sendResponse({ ok: true, saved: found });
            } catch (error) {
                sendResponse({
                    ok: false,
                    reason: error instanceof Error ? error.message : 'Chrome storage failed'
                });
            }
        })();
        return true;
    }

    if (request.action === "undo") {
        (async () => {
            try {
                let applied = null;
                await mutateStoredHouses(async (houses) => {
                    const stored = await chrome.storage.local.get('undoLog');
                    const result = undoLast(houses, stored.undoLog || []);
                    applied = result;
                    return { houses: result.updatedHouses ?? houses, undoLog: result.log };
                });

                if (!applied || !applied.entry) {
                    sendResponse({ ok: true, undone: false, reason: 'Nothing left to undo.' });
                    return;
                }
                sendResponse({ ok: true, undone: true, label: applied.entry.label });
            } catch (error) {
                sendResponse({
                    ok: false,
                    reason: error instanceof Error ? error.message : 'Chrome storage failed'
                });
            }
        })();
        return true;
    }

    if (request.action === "addComp") {
        (async () => {
            const { targetKey, comp } = request;
            if (!targetKey || !comp || typeof comp !== 'object') {
                sendResponse({ ok: false, reason: 'Invalid comp.' });
                return;
            }
            try {
                let outcome = 'missing';
                await mutateStoredHouses((houses) => {
                    const result = addCompToHouse(houses, targetKey, comp);
                    if (!result) { outcome = 'missing'; return null; }
                    if (result.duplicate) { outcome = 'duplicate'; return null; }
                    outcome = 'added';
                    return result.updatedHouses;
                });

                if (outcome === 'missing') {
                    sendResponse({ ok: false, reason: 'That house is no longer tracked.' });
                } else if (outcome === 'duplicate') {
                    sendResponse({ ok: true, added: false, reason: 'Already added' });
                } else {
                    sendResponse({ ok: true, added: true });
                }
            } catch (error) {
                sendResponse({
                    ok: false,
                    reason: error instanceof Error ? error.message : 'Chrome storage failed'
                });
            }
        })();
        return true;
    }

    if (request.action === "removeComp") {
        const { targetKey, compKey } = request;
        if (targetKey && compKey) {
            mutateStoredHouses((houses) => {
                const result = removeCompFromHouse(houses, targetKey, compKey);
                return result ? result.updatedHouses : null;
            }, { op: 'comp', key: targetKey, label: 'Removed a comp' }).catch((error) => {
                console.error('Error removing comp:', error);
            });
        }
    }

    if (request.action === "mapPinClicked") {
        const { key } = request;
        if (key) {
            chrome.runtime.sendMessage({ action: 'highlightHouse', key }, () => {
                void chrome.runtime.lastError;
            });
        }
    }

    if (request.action === "mapPinStatus") {
        if (sender.tab?.active) {
            chrome.runtime.sendMessage({
                action: 'mapPinStatus',
                shown: request.shown,
                total: request.total,
                missing: request.missing,
                tabId: sender.tab.id
            }, () => {
                void chrome.runtime.lastError;
            });
        }
    }

    if (request.action === "highlightMapHouse" || request.action === "focusMapHouse") {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (!tabId) return;
            chrome.tabs.sendMessage(tabId, {
                action: request.action,
                key: typeof request.key === 'string' ? request.key : null
            }, () => { void chrome.runtime.lastError; });
        });
    }

    if (request.action === "setMapDefault") {
        (async () => {
            const next = await mutateMapVisibility(() => ({
                defaultVisible: Boolean(request.visible),
                exceptions: []
            }));
            sendResponse({ ok: true, state: next });
        })().catch((error) => {
            sendResponse({ ok: false, reason: error instanceof Error ? error.message : 'Chrome storage failed' });
        });
        return true;
    }

    if (request.action === "toggleMapHouse") {
        (async () => {
            if (typeof request.key !== 'string') {
                sendResponse({ ok: false, reason: 'Invalid house key.' });
                return;
            }
            const next = await mutateMapVisibility((current) => {
                const exceptions = new Set(current.exceptions);
                if (exceptions.has(request.key)) exceptions.delete(request.key);
                else exceptions.add(request.key);
                return { ...current, exceptions: [...exceptions] };
            });
            sendResponse({ ok: true, state: next });
        })().catch((error) => {
            sendResponse({ ok: false, reason: error instanceof Error ? error.message : 'Chrome storage failed' });
        });
        return true;
    }

    if (request.action === "startCompSession") {
        (async () => {
            const { targetKey, kind, searchSource } = request;
            if (!targetKey || (kind !== 'rent' && kind !== 'sold')
                || (searchSource && !['redfin', 'zillow', 'homes'].includes(searchSource))) {
                sendResponse({ ok: false, reason: 'Invalid comp session request.' });
                return;
            }
            try {
                const stored = await chrome.storage.local.get('storedHouses');
                const houses = stored.storedHouses || [];
                const house = houses.find((h) => houseKey(h) === targetKey);
                if (!house) {
                    sendResponse({ ok: false, reason: 'That house is no longer tracked.' });
                    return;
                }

                const url = buildCompUrl({
                    source: searchSource || house.source || 'redfin',
                    address: house.address,
                    beds: house.beds,
                    baths: house.baths,
                    kind
                });
                if (!url) {
                    sendResponse({ ok: false, reason: "Couldn't build a same-site comp search from this listing's address." });
                    return;
                }

                // Persist the session before a fast search page can ask for it.
                const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
                await chrome.storage.local.set({
                    compSession: {
                        tabIds: [tab.id],
                        targetKey,
                        kind,
                        searchSource: searchSource || house.source || 'redfin',
                        subject: {
                            address: house.address,
                            price: house.price,
                            beds: house.beds,
                            baths: house.baths,
                            sqft: house.sqft,
                            latitude: house.latitude ?? null,
                            longitude: house.longitude ?? null
                        },
                        startedAt: Date.now()
                    }
                });
                await chrome.tabs.update(tab.id, { url, active: true });
                sendResponse({ ok: true });
            } catch (error) {
                sendResponse({
                    ok: false,
                    reason: error instanceof Error ? error.message : 'Chrome storage failed'
                });
            }
        })();
        return true;
    }

    if (request.action === "endCompSession") {
        chrome.storage.local.remove('compSession', () => {
            sendResponse({ ok: true });
        });
        return true;
    }

    if (request.action === "getCompSession") {
        (async () => {
            const stored = await chrome.storage.local.get('compSession');
            const session = stored.compSession || null;
            const tabId = sender.tab?.id;

            if (session && Date.now() - session.startedAt > COMP_SESSION_STALE_MS) {
                await chrome.storage.local.remove('compSession');
                sendResponse({ session: null });
                return;
            }
            if (!session || !tabId || !session.tabIds.includes(tabId)) {
                sendResponse({ session: null });
                return;
            }
            sendResponse({ session });
        })();
        return true;
    }

});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'complete') return;
    chrome.storage.local.get('compSession').then(({ compSession }) => {
        if (!compSession?.tabIds?.includes(tabId)) return;
        chrome.tabs.sendMessage(tabId, { action: 'setCompSession', session: compSession }, () => {
            void chrome.runtime.lastError;
        });
    });
});

chrome.tabs.onCreated.addListener((tab) => {
    if (tab.openerTabId === undefined) return;
    chrome.storage.local.get('compSession').then(({ compSession }) => {
        if (!compSession || !compSession.tabIds.includes(tab.openerTabId)) return;
        if (compSession.tabIds.includes(tab.id)) return;
        chrome.storage.local.set({
            compSession: { ...compSession, tabIds: [...compSession.tabIds, tab.id] }
        });
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    chrome.storage.local.get('compSession').then(({ compSession }) => {
        if (!compSession || !compSession.tabIds.includes(tabId)) return;
        const remaining = compSession.tabIds.filter((id) => id !== tabId);
        if (remaining.length === 0) {
            chrome.storage.local.remove('compSession');
        } else {
            chrome.storage.local.set({ compSession: { ...compSession, tabIds: remaining } });
        }
    });
});

chrome.runtime.onInstalled.addListener(() => {
    if (chrome.sidePanel) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    console.log("Extension installed and side panel behavior set.");
});
