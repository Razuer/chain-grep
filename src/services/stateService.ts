import * as vscode from "vscode";
import { debounce } from "../utils/utils";
import { getHighlightState, restoreHighlightState } from "./highlightService";
import { ChainGrepDataProvider } from "../providers/chainGrepDataProvider";

let extensionContext: vscode.ExtensionContext;

// Data stores that need to be persisted
const chainGrepMap: Map<string, any> = new Map();
const chainGrepContents: Map<string, string> = new Map();

const debouncedSavePersistentState = debounce(() => {
    const chainData = Array.from(chainGrepMap.entries()).map(([uri, data]) => [
        uri,
        { chain: data.chain, sourceUri: data.sourceUri.toString() },
    ]);
    const contentsData = Array.from(chainGrepContents.entries());

    const persistentHighlights = getHighlightState();

    extensionContext.workspaceState.update("chainGrepState", {
        chainData,
        contentsData,
        persistentHighlights,
    });

    console.log("Chain Grep: State saved");
}, 1000);

export function getChainGrepMap(): Map<string, any> {
    return chainGrepMap;
}

export function getChainGrepContents(): Map<string, string> {
    return chainGrepContents;
}

export function savePersistentState() {
    debouncedSavePersistentState();
}

export function loadPersistentState(context: vscode.ExtensionContext, chainGrepProvider: ChainGrepDataProvider) {
    extensionContext = context;

    const stored = context.workspaceState.get<any>("chainGrepState");
    if (!stored) {
        return;
    }

    if (stored.chainData) {
        for (const [uri, data] of stored.chainData) {
            chainGrepMap.set(uri, {
                chain: data.chain,
                sourceUri: vscode.Uri.parse(data.sourceUri),
            });
        }
    }
    if (stored.contentsData) {
        for (const [uri, content] of stored.contentsData) {
            chainGrepContents.set(uri, content);
        }
    }

    if (stored.persistentHighlights) {
        restoreHighlightState(stored.persistentHighlights);
    }

    rebuildTreeViewFromState(chainGrepProvider);
}

export function setContext(context: vscode.ExtensionContext) {
    extensionContext = context;
}

function rebuildTreeViewFromState(chainGrepProvider: ChainGrepDataProvider) {
    const entriesBySource = new Map<string, Map<string, any[]>>();

    for (const [docUri, chainInfo] of chainGrepMap.entries()) {
        const sourceUriStr = chainInfo.sourceUri.toString();
        if (!entriesBySource.has(sourceUriStr)) {
            entriesBySource.set(sourceUriStr, new Map());
        }
        entriesBySource.get(sourceUriStr)!.set(docUri, chainInfo.chain);
    }

    for (const [sourceUriStr, docEntries] of entriesBySource.entries()) {
        const docEntryPairs = Array.from(docEntries.entries());

        docEntryPairs.sort((a, b) => a[1].length - b[1].length);

        for (const [docUri, chain] of docEntryPairs) {
            const lastQuery = chain[chain.length - 1];
            const label = lastQuery ? lastQuery.query : "Unknown";

            let bestParentDocUri = "";
            let maxMatchLength = 0;

            for (const [otherDocUri, otherChain] of docEntries) {
                if (otherDocUri !== docUri && chain.length > otherChain.length && otherChain.length > maxMatchLength) {
                    let isPrefix = true;
                    for (let i = 0; i < otherChain.length; i++) {
                        if (JSON.stringify(otherChain[i]) !== JSON.stringify(chain[i])) {
                            isPrefix = false;
                            break;
                        }
                    }

                    if (isPrefix) {
                        maxMatchLength = otherChain.length;
                        bestParentDocUri = otherDocUri;
                    }
                }
            }

            if (bestParentDocUri) {
                chainGrepProvider.addSubChain(bestParentDocUri, label, chain, docUri);
            } else {
                chainGrepProvider.addRootChain(sourceUriStr, label, chain, docUri);
            }
        }
    }

    chainGrepProvider.refresh();
}

export function cleanupUnusedResources(showNotifications: boolean = false, isCleanupLogging: boolean): number {
    const visibleUris = vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString());

    let cleanedCount = 0;

    for (const contentUri of chainGrepContents.keys()) {
        if (!chainGrepMap.has(contentUri) && !visibleUris.includes(contentUri)) {
            chainGrepContents.delete(contentUri);
            cleanedCount++;

            if (isCleanupLogging || showNotifications) {
                console.log(`ChainGrep: Cleaned up orphaned content: ${contentUri}`);
            }
        }
    }

    if (cleanedCount > 0) {
        savePersistentState();

        if (isCleanupLogging || showNotifications) {
            console.log(`ChainGrep: Background cleanup removed ${cleanedCount} orphaned resources`);
        }

        if (showNotifications) {
            vscode.window.showInformationMessage(`Chain Grep: Cleaned up ${cleanedCount} orphaned resources`);
        }
    } else if (showNotifications) {
        vscode.window.showInformationMessage("Chain Grep: No orphaned resources found");
    }

    return cleanedCount;
}
