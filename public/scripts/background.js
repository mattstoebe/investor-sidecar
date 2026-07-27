/**
 * Service worker: the sole writer of storedHouses.
 *
 * The tax/rent enrichment client that used to live here was removed before the Chrome Web
 * Store release. It fetched an unauthenticated service over plain http on a user-configured
 * localhost URL, which is not something to ship to strangers, and the setting had no way to
 * be anything but broken for anyone who wasn't running the service themselves.
 *
 * It is coming back with real auth. What was deliberately *kept* for that, unused in the
 * meantime, is the panel-side half: House.rentEstimate/apiTaxRate and the rent distribution
 * chart in src/RentChart.tsx still render whenever a house carries those fields. So the
 * server work reduces to writing them into storage from here again -- via
 * mergeEnrichmentIntoLatest in house-storage.js, also kept and still tested, which merges
 * API fields into the newest record without clobbering a concurrent user edit.
 *
 * git log -- public/scripts/background.js has the removed client if it's a useful starting
 * point; treat its transport as a sketch, not a design.
 */
import {
    houseKey, applyLocalParams, stampRevision, pushUndoEntry, undoLast
} from './house-storage.js';

/**
 * Notifies the side panel that stored houses changed. The panel is frequently closed, and in
 * MV3 a callback-less sendMessage returns a promise that rejects with "Receiving end does not
 * exist" when nothing is listening. Left unhandled that logged an error on every single
 * capture, which trains you to ignore the service-worker console -- the opposite of what this
 * worker's error reporting is for.
 */
function notifySidePanel(houses, undoLog) {
    chrome.runtime.sendMessage({
        action: 'updateSidePanel',
        houses,
        // The panel only needs to know whether there is anything to undo and what it was;
        // shipping the inverses themselves would invite a second writer of them.
        undo: summariseUndo(undoLog)
    }, () => {
        void chrome.runtime.lastError;
    });
}

/** What the panel is told about the log: enough to label a button, not enough to apply one. */
function summariseUndo(log) {
    const entries = Array.isArray(log) ? log : [];
    const top = entries[entries.length - 1];
    return { depth: entries.length, label: top ? top.label : null };
}

/**
 * The one place storedHouses is written.
 *
 * This worker is the sole writer of that key, and every mutation goes through this queue.
 * Before, the panel wrote it too -- each card independently doing get-then-set of the whole
 * array -- so a card's save and a capture could each spread their own stale snapshot over
 * the other's write and one of them vanished. Rare, unreproducible, and silent.
 *
 * `mutate` receives the freshest array and returns the new one, or null to write nothing.
 * Reading inside the queued callback rather than before it is what makes the read and the
 * write atomic with respect to every other mutation.
 */
let storedHousesQueue = Promise.resolve();

/**
 * `undoable` describes how to reverse this mutation: { op, key, label }. Recorded inside the
 * queue, from the array the mutation is actually about to overwrite -- capturing it outside
 * would race the very writes this queue exists to serialize. Omitted for changes that are not
 * the user's to undo: a capture, an enrichment merge, an undo itself.
 */
function mutateStoredHouses(mutate, undoable) {
    const run = async () => {
        const result = await chrome.storage.local.get(['storedHouses', 'undoLog']);
        const houses = result.storedHouses || [];
        const outcome = await mutate(houses);
        if (!outcome) return null;

        // A mutation returns the new array, or -- when it is the undo path, which consumes the
        // log as well as the houses -- both. Writing both here rather than letting the caller
        // write the log separately is what keeps the two keys consistent: a side write would
        // be overwritten by the log this function had already read.
        const updated = Array.isArray(outcome) ? outcome : outcome.houses;
        if (!updated) return null;

        let log = Array.isArray(outcome) ? (result.undoLog || []) : outcome.undoLog;
        if (undoable) {
            const index = houses.findIndex((house) => houseKey(house) === undoable.key);
            const prior = index === -1 ? null : houses[index];
            // No before-state means nothing to restore -- an edit to a house that wasn't there.
            if (prior) {
                log = pushUndoEntry(log, {
                    op: undoable.op,
                    key: undoable.key,
                    label: undoable.label,
                    index,
                    // An edit restores only what the user owns; a delete restores the record.
                    localParams: undoable.op === 'edit' ? (prior.localParams ?? null) : null,
                    house: undoable.op === 'delete' ? prior : null
                });
            }
        }

        await chrome.storage.local.set({ storedHouses: updated, undoLog: log });
        notifySidePanel(updated, log);
        return updated;
    };
    // Chained on both settle paths so one failed mutation can't wedge every later one.
    storedHousesQueue = storedHousesQueue.then(run, run);
    return storedHousesQueue;
}

// The login/logout/isUserSignedIn branch that used to sit here was unreachable:
// chrome.identity.launchWebAuthFlow needs the "identity" permission, which the manifest
// has never requested, and the Sign In button that sent those messages is gone.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // House storage and export
    if (request.action === "addHouse") {
        // A content-script button must not say "Added" until storage has actually
        // accepted the record. Keep the message port open and acknowledge only after
        // the write completes.
        (async () => {
            if (!request.house || typeof request.house !== 'object' || !request.house.propertyID) {
                sendResponse({ ok: false, reason: 'Invalid listing data.' });
                return;
            }
            try {
                const key = houseKey(request.house);
                let alreadyTracked = false;

                await mutateStoredHouses((storedHouses) => {
                    alreadyTracked = storedHouses.some((house) => houseKey(house) === key);
                    if (alreadyTracked) return null;
                    console.log(`House added: ${key}`);
                    // Stamped like every other write so a captured house enters storage with a
                    // revision rather than acquiring one on its first edit.
                    return [...storedHouses, stampRevision(request.house, 'capture')];
                });

                sendResponse({ ok: true, added: !alreadyTracked });
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
                // Deletion is the one unrecoverable thing this panel can do, and it fires with
                // no confirmation. It is the reason undo exists at all.
                label: request.address ? `Removed ${request.address}` : 'Removed a house'
            }).then(() => {
                // tabs can come back empty -- devtools focused, no active tab -- and
                // tabs[0].id then threw inside this callback.
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

    /**
     * The panel's per-house overrides. The panel used to write these itself, which made it a
     * second writer of storedHouses racing this worker; it now sends them here instead.
     * Acknowledged so the panel can surface a failure rather than assume it saved.
     */
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
                    // `writer` is the sending card's id: it comes back on the broadcast so that
                    // card can skip its own echo instead of adopting it over newer keystrokes.
                    const applied = applyLocalParams(houses, key, localParams, writer);
                    found = applied !== null;
                    return applied ? applied.updatedHouses : null;
                }, { op: 'edit', key, label: 'Changed assumptions' });
                // Not an error: the house can be removed while an edit is in flight, and
                // re-adding it from this update would resurrect a deleted record.
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

    /**
     * Reverses the last thing the user did to storedHouses.
     *
     * Applied here rather than in the panel for the same reason every other mutation is: this
     * queue is the only place a read and a write are atomic with respect to each other. It
     * deliberately does not go through mutateStoredHouses' own undoable path -- undoing an
     * undo is redo, which is a different feature and not this one done badly.
     */
    if (request.action === "undo") {
        (async () => {
            try {
                let applied = null;
                await mutateStoredHouses(async (houses) => {
                    const stored = await chrome.storage.local.get('undoLog');
                    const result = undoLast(houses, stored.undoLog || []);
                    applied = result;
                    // The log shrinks whether or not an entry applied: undoLast drops stale
                    // ones as it goes, and re-offering them would wedge undo behind a mistake
                    // that is no longer undoable. Houses fall back to unchanged so that
                    // shrinking still gets written.
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

});

chrome.runtime.onInstalled.addListener(() => {
    if (chrome.sidePanel) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    console.log("Extension installed and side panel behavior set.");
});
