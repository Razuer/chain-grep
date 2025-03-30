import * as vscode from "vscode";
import { debounce } from "../utils/utils";
import { getHighlightState, restoreHighlightState } from "./highlightService";
import { ChainGrepDataProvider } from "../providers/chainGrepDataProvider";
import { showStatusMessage } from "./configService";
import { BookmarkProvider } from "../providers/bookmarkProvider";
import { isStateSavingInProjectEnabled } from "./configService";
import * as path from "path";
import { Bookmark } from "../models/interfaces";

let extensionContext: vscode.ExtensionContext;

const chainGrepMap: Map<string, any> = new Map();
const chainGrepContents: Map<string, string> = new Map();
let bookmarkProvider: BookmarkProvider | undefined;

const BOOKMARKS_FILE_NAME = "chain-grep-bookmarks.json";
const CHAINS_FILE_NAME = "chain-grep-chains.json";
const HIGHLIGHTS_FILE_NAME = "chain-grep-highlights.json";
const CONTENTS_FILE_NAME = "chain-grep-contents.json";

const debouncedSavePersistentStateInternal = debounce(async () => {
    const chainData = Array.from(chainGrepMap.entries()).map(([uri, data]) => [
        uri,
        { chain: data.chain, sourceUri: data.sourceUri.toString() },
    ]);
    const contentsData = Array.from(chainGrepContents.entries());

    const persistentHighlights = getHighlightState();
    const bookmarks = bookmarkProvider ? bookmarkProvider.getAllBookmarks() : [];

    const saveStateToWorkspaceEnabled = isStateSavingInProjectEnabled();
    if (saveStateToWorkspaceEnabled) {
        const saved = await saveStateToWorkspace();
        if (saved) {
            extensionContext.workspaceState.update("chainGrepState", {
                stateVersion: 1,
                storedInWorkspace: true,
                timestamp: new Date().getTime(),
            });
            return;
        }
    }

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
        const vscodeUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
        const fileUri = vscode.Uri.joinPath(vscodeUri, BOOKMARKS_FILE_NAME);

        try {
            await vscode.workspace.fs.stat(vscodeUri);
        } catch (error) {
            await vscode.workspace.fs.createDirectory(vscodeUri);
        }

        const preparedBookmarks = bookmarks.map((bookmark) => {
            const normalizedBookmark = { ...bookmark };

            if (normalizedBookmark.sourceUri) {
                normalizedBookmark.sourceUri = normalizeUriPath(normalizedBookmark.sourceUri, workspaceFolder.uri);
            }

            if (normalizedBookmark.docUri && !normalizedBookmark.docUri.startsWith("chaingrep:")) {
                normalizedBookmark.docUri = normalizeUriPath(normalizedBookmark.docUri, workspaceFolder.uri);
            }

            return normalizedBookmark;
        });

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
        const fileUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", BOOKMARKS_FILE_NAME);

        try {
            const fileContent = await vscode.workspace.fs.readFile(fileUri);
            const bookmarksData = Buffer.from(fileContent).toString("utf-8");

            const bookmarks = JSON.parse(bookmarksData) as Bookmark[];

            return bookmarks.map((bookmark) => {
                const restoredBookmark = { ...bookmark };

                if (restoredBookmark.sourceUri && !restoredBookmark.sourceUri.startsWith("file:")) {
                    restoredBookmark.sourceUri = denormalizeUriPath(restoredBookmark.sourceUri, workspaceFolder.uri);
                }

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
            return null;
        }
    } catch (error) {
        console.error("Failed to load bookmarks from workspace file:", error);
        return null;
    }
}

export async function saveStateToWorkspace() {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return false;
    }

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const vscodeUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");

        try {
            await vscode.workspace.fs.stat(vscodeUri);
        } catch (error) {
            await vscode.workspace.fs.createDirectory(vscodeUri);
        }

        const chainData = Array.from(chainGrepMap.entries()).map(([uri, data]) => {
            const normalizedSourceUri = normalizeUriPath(data.sourceUri.toString(), workspaceFolder.uri);

            return {
                uri,
                chain: data.chain,
                sourceUri: normalizedSourceUri,
            };
        });

        const chainsFileUri = vscode.Uri.joinPath(vscodeUri, CHAINS_FILE_NAME);
        await vscode.workspace.fs.writeFile(chainsFileUri, Buffer.from(JSON.stringify(chainData, null, 2), "utf-8"));

        const contentsData = Array.from(chainGrepContents.entries()).map(([uri, content]) => {
            return {
                uri,
                content,
            };
        });

        const contentsFileUri = vscode.Uri.joinPath(vscodeUri, CONTENTS_FILE_NAME);
        await vscode.workspace.fs.writeFile(
            contentsFileUri,
            Buffer.from(JSON.stringify(contentsData, null, 2), "utf-8")
        );

        const highlightsFileUri = vscode.Uri.joinPath(vscodeUri, HIGHLIGHTS_FILE_NAME);
        const persistentHighlights = getHighlightState();
        await vscode.workspace.fs.writeFile(
            highlightsFileUri,
            Buffer.from(JSON.stringify(persistentHighlights, null, 2), "utf-8")
        );

        const bookmarks = bookmarkProvider ? bookmarkProvider.getAllBookmarks() : [];
        if (bookmarks.length > 0) {
            await saveBookmarksToWorkspace(bookmarks);
        }

        return true;
    } catch (error) {
        console.error("Failed to save extension state to workspace files:", error);
        return false;
    }
}

export async function loadStateFromWorkspace(chainGrepProvider: ChainGrepDataProvider): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        return false;
    }

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders[0];
        const vscodeUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");

        let loadedAnyData = false;

        try {
            const chainsFileUri = vscode.Uri.joinPath(vscodeUri, CHAINS_FILE_NAME);
            const chainsContent = await vscode.workspace.fs.readFile(chainsFileUri);
            const chainsData = JSON.parse(Buffer.from(chainsContent).toString("utf-8"));

            chainGrepMap.clear();

            for (const item of chainsData) {
                const sourceUri = item.sourceUri.startsWith("file:")
                    ? item.sourceUri
                    : denormalizeUriPath(item.sourceUri, workspaceFolder.uri);

                chainGrepMap.set(item.uri, {
                    chain: item.chain,
                    sourceUri: vscode.Uri.parse(sourceUri),
                });
            }

            loadedAnyData = true;
        } catch (error) {
            console.log("No chains file found in workspace or error reading it:", error);
        }

        try {
            const contentsFileUri = vscode.Uri.joinPath(vscodeUri, CONTENTS_FILE_NAME);
            const contentsContent = await vscode.workspace.fs.readFile(contentsFileUri);
            const contentsData = JSON.parse(Buffer.from(contentsContent).toString("utf-8"));

            chainGrepContents.clear();

            for (const item of contentsData) {
                chainGrepContents.set(item.uri, item.content);
            }

            loadedAnyData = true;
        } catch (error) {
            console.log("No contents file found in workspace or error reading it:", error);
        }

        try {
            const highlightsFileUri = vscode.Uri.joinPath(vscodeUri, HIGHLIGHTS_FILE_NAME);
            const highlightsContent = await vscode.workspace.fs.readFile(highlightsFileUri);
            const highlightsData = JSON.parse(Buffer.from(highlightsContent).toString("utf-8"));

            restoreHighlightState(highlightsData);
            loadedAnyData = true;
        } catch (error) {
            console.log("No highlights file found in workspace or error reading it:", error);
        }

        if (chainGrepMap.size > 0) {
            rebuildTreeViewFromState(chainGrepProvider);
        }

        return loadedAnyData;
    } catch (error) {
        console.error("Failed to load extension state from workspace files:", error);
        return false;
    }
}

function normalizeUriPath(uriPath: string, workspaceUri: vscode.Uri): string {
    try {
        const uri = vscode.Uri.parse(uriPath);
        if (uri.scheme !== "file") {
            return uriPath;
        }

        const workspacePath = workspaceUri.path;

        if (uri.path.startsWith(workspacePath)) {
            return uri.path.substring(workspacePath.length);
        }

        return uriPath;
    } catch (error) {
        console.error("Error normalizing URI path:", error);
        return uriPath;
    }
}

function denormalizeUriPath(relativePath: string, workspaceUri: vscode.Uri): string {
    try {
        if (relativePath.includes(":")) {
            return relativePath;
        }

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

    const saveStateToWorkspaceEnabled = isStateSavingInProjectEnabled();
    if (saveStateToWorkspaceEnabled) {
        const loadedFromWorkspace = await loadStateFromWorkspace(chainGrepProvider);
        if (loadedFromWorkspace) {
            showStatusMessage("ChainGrep: Loaded all extension state from workspace files");
            if (bookmarkProvider) {
                const workspaceBookmarks = await loadBookmarksFromWorkspace();
                if (workspaceBookmarks && workspaceBookmarks.length > 0) {
                    bookmarkProvider.loadFromState(workspaceBookmarks);
                }
            }
            return;
        }
    }

    const state = context.workspaceState.get("chainGrepState") as any;
    if (state) {
        if (state.stateVersion && state.storedInWorkspace) {
            await loadStateFromWorkspace(chainGrepProvider);
        } else {
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

            if (state.bookmarks && bookmarkProvider) {
                bookmarkProvider.loadFromState(state.bookmarks);
            }
        }
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
