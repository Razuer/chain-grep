import * as vscode from "vscode";
import { debounce } from "../utils/utils";
import { getHighlightState, restoreHighlightState } from "./highlightService";
import { ChainGrepDataProvider } from "../providers/chainGrepDataProvider";
import { showStatusMessage } from "./configService";
import { BookmarkProvider } from "../providers/bookmarkProvider";
import { isBookmarkSavingInProjectEnabled } from "./configService";
import * as path from "path";
import { Bookmark } from "../models/interfaces";

let extensionContext: vscode.ExtensionContext;

const chainGrepMap: Map<string, any> = new Map();
const chainGrepContents: Map<string, string> = new Map();
let bookmarkProvider: BookmarkProvider | undefined;

const BOOKMARKS_FILE_PATH = ".vscode/chain-grep-bookmarks.json";

const debouncedSavePersistentStateInternal = debounce(async () => {
    const chainData = Array.from(chainGrepMap.entries()).map(([uri, data]) => [
        uri,
        { chain: data.chain, sourceUri: data.sourceUri.toString() },
    ]);
    const contentsData = Array.from(chainGrepContents.entries());

    const persistentHighlights = getHighlightState();
    const bookmarks = bookmarkProvider ? bookmarkProvider.getAllBookmarks() : [];

    // Save bookmarks to workspace file if enabled
    const saveToWorkspaceEnabled = isBookmarkSavingInProjectEnabled();
    if (saveToWorkspaceEnabled && bookmarks.length > 0) {
        const saved = await saveBookmarksToWorkspace(bookmarks);
        if (saved) {
            // Still save the state in workspaceState for compatibility
            extensionContext.workspaceState.update("chainGrepState", {
                chainData,
                contentsData,
                persistentHighlights,
                bookmarks: [], // Don't duplicate bookmarks in state when saved in file
            });
            return;
        }
    }

    // If not enabled or saving failed, save bookmarks in workspaceState
    extensionContext.workspaceState.update("chainGrepState", {
        chainData,
        contentsData,
        persistentHighlights,
        bookmarks,
    });
}, 1000);

export function getChainGrepMap(): Map<string, any> {
    return chainGrepMap;
}

export function getChainGrepContents(): Map<string, string> {
    return chainGrepContents;
}

export function savePersistentState() {
    debouncedSavePersistentStateInternal();
}

export async function saveBookmarksToWorkspace(bookmarks: Bookmark[]) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return false;
    }

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        // Używamy URI zamiast ścieżek systemowych dla kompatybilności z Remote Development
        const vscodeUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
        const fileUri = vscode.Uri.joinPath(vscodeUri, "chain-grep-bookmarks.json");

        // Ensure .vscode directory exists
        try {
            await vscode.workspace.fs.stat(vscodeUri);
        } catch (error) {
            // Create .vscode directory if it doesn't exist
            await vscode.workspace.fs.createDirectory(vscodeUri);
        }

        // Przygotowanie zakładek do zapisu - normalizacja URI dla kompatybilności
        const preparedBookmarks = bookmarks.map((bookmark) => {
            // Konwertuj URI do formatu względnego dla Remote Development
            const normalizedBookmark = { ...bookmark };

            // Jeśli mamy sourceUri i jest to absolutna ścieżka, skonwertuj ją na względną
            if (normalizedBookmark.sourceUri) {
                normalizedBookmark.sourceUri = normalizeUriPath(normalizedBookmark.sourceUri, workspaceFolder.uri);
            }

            // Jeśli mamy docUri i jest to absolutna ścieżka, skonwertuj ją na względną
            if (normalizedBookmark.docUri && !normalizedBookmark.docUri.startsWith("chaingrep:")) {
                normalizedBookmark.docUri = normalizeUriPath(normalizedBookmark.docUri, workspaceFolder.uri);
            }

            return normalizedBookmark;
        });

        // Save bookmarks to file
        const bookmarksData = JSON.stringify(preparedBookmarks, null, 2);
        await vscode.workspace.fs.writeFile(fileUri, Buffer.from(bookmarksData, "utf-8"));

        return true;
    } catch (error) {
        console.error("Failed to save bookmarks to workspace file:", error);
        return false;
    }
}

export async function loadBookmarksFromWorkspace(): Promise<Bookmark[] | null> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return null;
    }

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        // Używamy URI zamiast ścieżek systemowych dla kompatybilności z Remote Development
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", "chain-grep-bookmarks.json");

        // Try to read the bookmarks file
        try {
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const bookmarksData = Buffer.from(fileContent).toString("utf-8");

            // Przywracamy zakładki z zachowaniem kompatybilności z Remote Development
            const bookmarks = JSON.parse(bookmarksData) as Bookmark[];

            // Konwertuj względne ścieżki z powrotem na absolutne
            return bookmarks.map((bookmark) => {
                const restoredBookmark = { ...bookmark };

                // Jeśli mamy sourceUri jako ścieżkę względną, konwertuj ją na absolutną
                if (restoredBookmark.sourceUri && !restoredBookmark.sourceUri.startsWith("file:")) {
                    restoredBookmark.sourceUri = denormalizeUriPath(restoredBookmark.sourceUri, workspaceFolder.uri);
                }

                // Jeśli mamy docUri jako ścieżkę względną, konwertuj ją na absolutną
                if (
                    restoredBookmark.docUri &&
                    !restoredBookmark.docUri.startsWith("chaingrep:") &&
                    !restoredBookmark.docUri.startsWith("file:")
                ) {
                    restoredBookmark.docUri = denormalizeUriPath(restoredBookmark.docUri, workspaceFolder.uri);
                }

                return restoredBookmark;
            });
        } catch (error) {
            // File doesn't exist or is not accessible
            return null;
        }
    } catch (error) {
        console.error("Failed to load bookmarks from workspace file:", error);
        return null;
    }
}

// Przekształca absolutne URI na ścieżkę względną w kontekście workspace
function normalizeUriPath(uriPath: string, workspaceUri: vscode.Uri): string {
    try {
        const uri = vscode.Uri.parse(uriPath);
        // Jeśli to specjalne URI (np. chaingrep:), pozostawiamy bez zmian
        if (uri.scheme !== "file") {
            return uriPath;
        }

        // Konwersja ścieżki absolutnej na względną
        const workspacePath = workspaceUri.path;

        if (uri.path.startsWith(workspacePath)) {
            // Jeśli ścieżka jest w obrębie workspace, zapisz ją jako względną
            return uri.path.substring(workspacePath.length);
        }

        // Jeśli ścieżka jest poza workspace, pozostaw ją jak jest
        return uriPath;
    } catch (error) {
        console.error("Error normalizing URI path:", error);
        return uriPath;
    }
}

// Przekształca względną ścieżkę na absolutne URI w kontekście workspace
function denormalizeUriPath(relativePath: string, workspaceUri: vscode.Uri): string {
    try {
        // Jeśli to już jest absolutne URI, pozostawiamy bez zmian
        if (relativePath.includes(":")) {
            return relativePath;
        }

        // Jeśli to ścieżka względna, łączymy ją z workspace URI
        // Upewnij się, że ścieżka ma prawidłowy format (usuń lub dodaj ukośnik początkowy)
        const normalizedPath = relativePath.startsWith("/") ? relativePath : "/" + relativePath;

        return vscode.Uri.joinPath(workspaceUri, normalizedPath.substring(1)).toString();
    } catch (error) {
        console.error("Error denormalizing URI path:", error);
        return relativePath;
    }
}

export async function loadPersistentState(
    context: vscode.ExtensionContext,
    chainGrepProvider: ChainGrepDataProvider,
    bookmarkProv?: BookmarkProvider
) {
    extensionContext = context;
    bookmarkProvider = bookmarkProv;

    const state = context.workspaceState.get("chainGrepState") as any;
    if (state) {
        if (state.chainData) {
            for (const [uri, data] of state.chainData) {
                chainGrepMap.set(uri, {
                    chain: data.chain,
                    sourceUri: vscode.Uri.parse(data.sourceUri),
                });
            }
        }

        if (state.contentsData) {
            for (const [uri, content] of state.contentsData) {
                chainGrepContents.set(uri, content);
            }
        }

        if (state.persistentHighlights) {
            restoreHighlightState(state.persistentHighlights);
        }
    }

    // Try to load bookmarks from workspace file first if feature is enabled
    let loadedFromFile = false;
    if (isBookmarkSavingInProjectEnabled() && bookmarkProvider) {
        const workspaceBookmarks = await loadBookmarksFromWorkspace();
        if (workspaceBookmarks && workspaceBookmarks.length > 0) {
            bookmarkProvider.loadFromState(workspaceBookmarks);
            loadedFromFile = true;
        }
    }

    // If not loaded from file and state contains bookmarks, load from state
    if (!loadedFromFile && state && state.bookmarks && bookmarkProvider) {
        bookmarkProvider.loadFromState(state.bookmarks);
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

export function cleanupUnusedResources(showNotifications: boolean = false, isLoggingEnabled: boolean = false): number {
    const visibleUris = vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString());

    let cleanedCount = 0;

    for (const contentUri of chainGrepContents.keys()) {
        if (!chainGrepMap.has(contentUri) && !visibleUris.includes(contentUri)) {
            chainGrepContents.delete(contentUri);
            cleanedCount++;

            if (isLoggingEnabled) {
                showStatusMessage(`ChainGrep: Cleaned up orphaned content: ${contentUri}`);
            }
        }
    }

    if (cleanedCount > 0) {
        savePersistentState();

        if (isLoggingEnabled) {
            showStatusMessage(`ChainGrep: Background cleanup removed ${cleanedCount} orphaned resources`);
        }

        if (showNotifications) {
            vscode.window.showInformationMessage(`Chain Grep: Cleaned up ${cleanedCount} orphaned resources`);
        }
    } else if (showNotifications) {
        vscode.window.showInformationMessage("Chain Grep: No orphaned resources found");
    }

    return cleanedCount;
}
