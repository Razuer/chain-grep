import * as vscode from "vscode";
import * as path from "path";
import { ChainGrepQuery, Bookmark } from "./models/interfaces";
import { ChainGrepNode } from "./models/chainGrepNode";
import { BookmarkNode } from "./models/bookmarkNode";
import { ChainGrepDataProvider } from "./providers/chainGrepDataProvider";
import { BookmarkProvider } from "./providers/bookmarkProvider";
import { ChainGrepFSProvider } from "./providers/chainGrepFSProvider";
import {
    initHighlightDecorations,
    toggleHighlightGlobal,
    clearHighlightsGlobal,
    reapplyHighlightsGlobal,
    toggleHighlightLocal,
    clearHighlightsLocal,
    clearAllLocalHighlights,
    reapplyHighlightsLocal,
    applyHighlightsToOpenEditors,
    resetAllHighlightDecorations,
} from "./services/highlightService";
import { executeChainSearch, generateChainGrepDocUri, buildChainDetailedHeader } from "./services/searchService";
import {
    getChainGrepMap,
    getChainGrepContents,
    savePersistentState,
    loadPersistentState,
    setContext,
    cleanupUnusedResources,
} from "./services/stateService";
import {
    isDetailedChainDocEnabled,
    getCleanupInterval,
    isRegexValid,
    showStatusMessage,
    getBookmarkColor,
    isCleanupLoggingEnabled,
} from "./services/configService";
import { getSelectedTextOrWord } from "./utils/utils";

const CHAIN_GREP_SCHEME = "chaingrep";
const SAVE_STATE_DELAY = 1000;

const chainGrepProvider = new ChainGrepDataProvider();
const bookmarkProvider = new BookmarkProvider();
const chainGrepMap = getChainGrepMap();
const chainGrepContents = getChainGrepContents();
let chainTreeView: vscode.TreeView<ChainGrepNode> | undefined;
let cleanupInterval: NodeJS.Timeout | undefined;

let saveTimeout: NodeJS.Timeout | undefined;

function debouncedSaveState() {
    if (saveTimeout) {
        clearTimeout(saveTimeout);
    }

    saveTimeout = setTimeout(() => {
        savePersistentState();
        saveTimeout = undefined;
    }, SAVE_STATE_DELAY);
}

export async function activate(context: vscode.ExtensionContext) {
    setContext(context);

    const chainGrepFs = new ChainGrepFSProvider(chainGrepContents, chainGrepMap);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(CHAIN_GREP_SCHEME, chainGrepFs, {
            isReadonly: false,
        })
    );

    initHighlightDecorations();

    loadPersistentState(context, chainGrepProvider, bookmarkProvider);

    chainGrepFs.markInitialized();

    // Ustaw początkowy kontekst editorIsOpen
    vscode.commands.executeCommand("setContext", "editorIsOpen", !!vscode.window.activeTextEditor);

    setTimeout(() => {
        applyHighlightsToOpenEditors(chainGrepMap);
        bookmarkProvider.reapplyAllBookmarkDecorations();
    }, 1000);

    chainTreeView = vscode.window.createTreeView("chainGrepView", {
        treeDataProvider: chainGrepProvider,
        showCollapseAll: true,
    });

    const bookmarkTreeView = vscode.window.createTreeView("chainGrepBookmarks", {
        treeDataProvider: bookmarkProvider,
        showCollapseAll: true,
    });

    bookmarkProvider.setTreeView(bookmarkTreeView);
    bookmarkProvider.setChainGrepTree(chainGrepProvider, chainTreeView);

    chainTreeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            chainGrepProvider.refresh();
            recoverFailedChainGrepFiles();
        }
    });

    context.subscriptions.push(chainTreeView, bookmarkTreeView);

    cleanupUnusedResources(false, isCleanupLoggingEnabled());

    const intervalMs = getCleanupInterval();

    if (intervalMs > 0) {
        cleanupInterval = setInterval(() => cleanupUnusedResources(false), intervalMs);
        showStatusMessage(`ChainGrep: Scheduled cleanup every ${intervalMs / 60000} minutes`, 1500);
    } else {
        showStatusMessage(`ChainGrep: Automatic cleanup disabled`, 1500);
    }

    const openNodeCmd = vscode.commands.registerCommand("_chainGrep.openNode", (node: ChainGrepNode) => {
        openNode(node);
    });

    const closeNodeCmd = vscode.commands.registerCommand("_chainGrep.closeNode", (node: ChainGrepNode) => {
        closeNode(node);
    });

    const refreshAndOpenCmd = vscode.commands.registerCommand(
        "_chainGrep.refreshAndOpenNode",
        (node: ChainGrepNode) => {
            refreshAndOpen(node);
        }
    );

    const closeAllNodesCmd = vscode.commands.registerCommand("chainGrep.closeAllNodes", closeAllNodes);

    const addBookmarkCmd = vscode.commands.registerCommand("chainGrep.addBookmark", async () => {
        await addBookmarkAtCurrentLine();
    });

    const openBookmarkCmd = vscode.commands.registerCommand("_chainGrep.openBookmark", (node: BookmarkNode) => {
        bookmarkProvider.openBookmark(node);
    });

    const openCurrentLineBookmarkCmd = vscode.commands.registerCommand("chainGrep.openCurrentLineBookmark", () => {
        bookmarkProvider.openBookmark();
    });

    const removeBookmarkCmd = vscode.commands.registerCommand("_chainGrep.removeBookmark", (node: BookmarkNode) => {
        removeBookmark(node);
    });

    const clearBookmarksCmd = vscode.commands.registerCommand("chainGrep.clearBookmarks", clearAllBookmarks);

    const clearCurrentDocBookmarksCmd = vscode.commands.registerCommand(
        "chainGrep.clearCurrentDocBookmarks",
        clearCurrentDocumentBookmarks
    );

    const clearAllLocalHighlightsCmd = vscode.commands.registerCommand("chainGrep.clearAllLocalHighlights", () => {
        clearAllLocalHighlights(chainGrepMap);
        savePersistentState();
    });

    const clearAllGlobalHighlightsCmd = vscode.commands.registerCommand("_chainGrep.clearAllGlobalHighlights", () => {
        clearHighlightsGlobal(true);
        savePersistentState();
    });

    const toggleHighlightCmd = vscode.commands.registerTextEditorCommand("chainGrep.toggleHighlight", (editor) => {
        const text = getSelectedTextOrWord(editor);
        toggleHighlightLocal(editor, text, chainGrepMap);
        savePersistentState();
    });

    const clearHighlightsCmd = vscode.commands.registerTextEditorCommand("chainGrep.clearHighlights", (editor) => {
        clearHighlightsLocal(editor, chainGrepMap);
        savePersistentState();
    });

    const toggleHighlightGlobalCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.toggleHighlightGlobal",
        (editor) => {
            const text = getSelectedTextOrWord(editor);
            toggleHighlightGlobal(editor, text, chainGrepMap);
            savePersistentState();
        }
    );

    const clearHighlightsGlobalCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.clearHighlightsGlobal",
        () => {
            clearHighlightsGlobal(false);
            savePersistentState();
        }
    );

    const grepTextCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepText", async (editor) => {
        const input = await showQueryAndOptionsQuickInput(undefined, "text");
        if (!input?.query) {
            return;
        }

        const inverted = input.options.includes("Invert");
        const caseSensitive = input.options.includes("Case Sensitive");
        const { chain, sourceUri } = getChainForEditor(editor);

        const newQuery: ChainGrepQuery = {
            type: "text",
            query: input.query,
            inverted,
            caseSensitive,
        };
        const newChain = [...chain, newQuery];

        const docUri = editor.document.uri.toString();
        let parentDocUri: string | undefined;
        if (chainGrepMap.has(docUri)) {
            parentDocUri = docUri;
        }

        await executeChainSearchAndDisplayResults(sourceUri, newChain, parentDocUri, input.query);
    });

    const grepRegexCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepRegex", async (editor) => {
        const input = await showQueryAndOptionsQuickInput(undefined, "regex");
        if (!input?.query) {
            return;
        }

        const inverted = input.options.includes("Invert");
        const caseSensitive = input.options.includes("Case Sensitive");

        if (!isRegexValid(input.query)) {
            vscode.window.showInformationMessage("Invalid regular expression input (illegal single slash).");
            return;
        }

        let pattern: string;
        let flags = "";
        if (input.query.startsWith("/") && input.query.lastIndexOf("/") > 0) {
            const lastSlash = input.query.lastIndexOf("/");
            pattern = input.query.substring(1, lastSlash);
            flags = input.query.substring(lastSlash + 1);
        } else {
            pattern = input.query;
        }
        pattern = pattern.replace(/\/\//g, "/");

        const { chain, sourceUri } = getChainForEditor(editor);
        const newQuery: ChainGrepQuery = {
            type: "regex",
            query: pattern,
            flags,
            inverted,
            caseSensitive,
        };
        const newChain = [...chain, newQuery];

        const docUri = editor.document.uri.toString();
        let parentDocUri: string | undefined;
        if (chainGrepMap.has(docUri)) {
            parentDocUri = docUri;
        }

        await executeChainSearchAndDisplayResults(sourceUri, newChain, parentDocUri, input.query);
    });

    const grepSelectionCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepSelection", async (editor) => {
        const selText = editor.document.getText(editor.selection).trim();
        const input = await showQueryAndOptionsQuickInput(selText || "", "text");
        if (!input?.query) {
            return;
        }

        const inverted = input.options.includes("Invert");
        const caseSensitive = input.options.includes("Case Sensitive");
        const { chain, sourceUri } = getChainForEditor(editor);

        const newQuery: ChainGrepQuery = {
            type: "text",
            query: input.query,
            inverted,
            caseSensitive,
        };
        const newChain = [...chain, newQuery];

        const docUri = editor.document.uri.toString();
        let parentDocUri: string | undefined;
        if (chainGrepMap.has(docUri)) {
            parentDocUri = docUri;
        }

        await executeChainSearchAndDisplayResults(sourceUri, newChain, parentDocUri, input.query);
    });

    const refreshChainCmd = vscode.commands.registerTextEditorCommand("chainGrep.refresh", async (chainEditor) => {
        const chainDocUri = chainEditor.document.uri;
        const docUriStr = chainDocUri.toString();
        if (!chainGrepMap.has(docUriStr)) {
            vscode.window.showInformationMessage("No chain grep found for this document.");
            return;
        }
        const chainInfo = chainGrepMap.get(docUriStr)!;
        const sourceUri = chainInfo.sourceUri;
        try {
            const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
            await vscode.window.showTextDocument(sourceDoc, {
                preview: false,
            });

            await vscode.commands.executeCommand("workbench.action.files.revert");

            const chainDoc = await vscode.workspace.openTextDocument(chainDocUri);
            const newChainEditor = await vscode.window.showTextDocument(chainDoc, {
                preview: false,
            });
            await executeChainSearchAndUpdateEditor(sourceUri, chainInfo.chain, newChainEditor);
        } catch {
            vscode.window.showInformationMessage("Unable to refresh the source document.");
        }
    });

    const closeDocHandler = vscode.workspace.onDidCloseTextDocument((doc) => {
        const docUri = doc.uri;

        if (docUri.scheme === CHAIN_GREP_SCHEME) {
            const uriString = docUri.toString();
            console.log(`ChainGrep: Chain grep file closed: ${uriString}`);

            const inContents = chainGrepContents.has(uriString);

            console.log(`ChainGrep: File exists in contents: ${inContents}`);

            if (inContents) {
                chainGrepContents.delete(uriString);
                console.log(`ChainGrep: Content deleted from chainGrepContents, but chain info preserved`);
                savePersistentState();
            }
        }
    });

    const tabCloseListener = vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;

                if (uri.scheme === CHAIN_GREP_SCHEME) {
                    const uriString = uri.toString();
                    console.log(`ChainGrep: Tab closed for document: ${uriString}`);

                    const inContents = chainGrepContents.has(uriString);

                    console.log(`ChainGrep: File exists in contents: ${inContents}`);

                    if (inContents) {
                        chainGrepContents.delete(uriString);
                        console.log(`ChainGrep: Content deleted from chainGrepContents, chain info preserved`);
                        savePersistentState();
                    }
                }
            }
        }
    });

    const forceCleanupCmd = vscode.commands.registerCommand("chainGrep.forceCleanup", async () => {
        cleanupUnusedResources(true);
    });

    context.subscriptions.push(
        openNodeCmd,
        closeNodeCmd,
        refreshAndOpenCmd,
        addBookmarkCmd,
        openBookmarkCmd,
        openCurrentLineBookmarkCmd,
        removeBookmarkCmd,
        clearBookmarksCmd,
        clearCurrentDocBookmarksCmd,
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                reapplyHighlightsLocal(editor, chainGrepMap);
                reapplyHighlightsGlobal(editor);
                bookmarkProvider.refresh();
                setTimeout(() => {
                    bookmarkProvider.reapplyAllBookmarkDecorations();
                }, 50);

                const docUri = editor.document.uri.toString();
                if (docUri.startsWith("chaingrep:")) {
                    vscode.commands.executeCommand("workbench.view.extension.chainGrepViewContainer");
                    revealChainNode(docUri);
                } else if (chainTreeView?.visible) {
                    revealChainNode(docUri);
                }

                vscode.commands.executeCommand("setContext", "editorIsOpen", true);
            } else {
                vscode.commands.executeCommand("setContext", "editorIsOpen", false);
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor) {
                const editor = event.textEditor;
                const lineNumber = editor.selection.active.line;
                const docUri = editor.document.uri.toString();

                let hasBookmark = false;

                if (docUri.startsWith("chaingrep:")) {
                    hasBookmark = bookmarkProvider.hasBookmarkAtLine(docUri, lineNumber);
                } else {
                    hasBookmark = bookmarkProvider.hasSourceBookmarkAtLine(docUri, lineNumber);

                    if (!hasBookmark) {
                        const sourceBookmarks = bookmarkProvider.getSourceBookmarksAtLine(docUri, lineNumber);
                        hasBookmark = sourceBookmarks.some((b) => b.linkedBookmarkId !== undefined);
                    }
                }

                vscode.commands.executeCommand("setContext", "editorHasBookmark", hasBookmark);
            }
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && event.document === activeEditor.document) {
                setTimeout(() => {
                    bookmarkProvider.reapplyAllBookmarkDecorations();
                }, 100);
            }
        }),
        vscode.workspace.onDidOpenTextDocument((document) => {
            setTimeout(() => {
                bookmarkProvider.reapplyAllBookmarkDecorations();
            }, 200);
        }),
        toggleHighlightCmd,
        clearHighlightsCmd,
        toggleHighlightGlobalCmd,
        clearHighlightsGlobalCmd,
        grepTextCmd,
        grepRegexCmd,
        grepSelectionCmd,
        refreshChainCmd,
        cleanupInterval ? new vscode.Disposable(() => clearInterval(cleanupInterval)) : new vscode.Disposable(() => {}),
        closeDocHandler,
        tabCloseListener,
        closeAllNodesCmd,
        clearAllLocalHighlightsCmd,
        clearAllGlobalHighlightsCmd,
        forceCleanupCmd,
        vscode.workspace.onDidChangeConfiguration(handleConfigChange),
        new vscode.Disposable(() => {
            if (saveTimeout) {
                clearTimeout(saveTimeout);
            }
        })
    );
}

function handleConfigChange(e: vscode.ConfigurationChangeEvent) {
    if (e.affectsConfiguration("chainGrep.cleanupInterval")) {
        const intervalMs = getCleanupInterval();
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = undefined;
        }

        if (intervalMs > 0) {
            cleanupInterval = setInterval(() => cleanupUnusedResources(false), intervalMs);
            showStatusMessage(`ChainGrep: Cleanup interval changed to ${intervalMs / 60000} minutes`);
        } else {
            showStatusMessage(`ChainGrep: Automatic cleanup disabled`);
        }
    }

    if (e.affectsConfiguration("chainGrep.showScrollbarIndicators")) {
        resetAllHighlightDecorations(chainGrepMap);
        applyHighlightsToOpenEditors(chainGrepMap);
    }

    if (e.affectsConfiguration("chainGrep.colours")) {
        console.log("Chain Grep: Color palette changed, resetting all highlights");
        resetAllHighlightDecorations(chainGrepMap, true);
    }

    if (e.affectsConfiguration("chainGrep.randomColors")) {
        resetAllHighlightDecorations(chainGrepMap, true);
    }

    if (e.affectsConfiguration("chainGrep.bookmarkColor")) {
        bookmarkProvider.updateDecorationStyle();
    }

    if (
        e.affectsConfiguration("chainGrep.colours") ||
        e.affectsConfiguration("chainGrep.showScrollbarIndicators") ||
        e.affectsConfiguration("chainGrep.randomColors") ||
        e.affectsConfiguration("chainGrep.bookmarkColor")
    ) {
        savePersistentState();
    }
}

async function showQueryAndOptionsQuickInput(defaultQuery?: string, searchType: "text" | "regex" = "text") {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = searchType === "text" ? "Chain Grep | Text Search" : "Chain Grep | Regex Search";

    quickPick.placeholder =
        searchType === "text" ? "Enter search query here..." : "Enter regex pattern (e.g. foo|bar, \\bword\\b)...";

    quickPick.ignoreFocusOut = true;

    if (defaultQuery) {
        quickPick.value = defaultQuery;
    }

    let invertSelected = false;
    let caseSensitiveSelected = false;

    quickPick.buttons = [
        {
            iconPath: new vscode.ThemeIcon("arrow-swap"),
            tooltip: "Invert (Off)",
        },
        {
            iconPath: new vscode.ThemeIcon("case-sensitive"),
            tooltip: "Case Sensitive (Off)",
        },
    ];

    quickPick.onDidTriggerButton((button) => {
        if (button.tooltip?.startsWith("Invert")) {
            invertSelected = !invertSelected;
        } else if (button.tooltip?.startsWith("Case Sensitive")) {
            caseSensitiveSelected = !caseSensitiveSelected;
        }

        quickPick.buttons = [
            {
                iconPath: new vscode.ThemeIcon(invertSelected ? "check" : "arrow-swap"),
                tooltip: `Invert (${invertSelected ? "On" : "Off"})`,
            },
            {
                iconPath: new vscode.ThemeIcon(caseSensitiveSelected ? "check" : "case-sensitive"),
                tooltip: `Case Sensitive (${caseSensitiveSelected ? "On" : "Off"})`,
            },
        ];
    });

    return new Promise<{ query: string; options: string[] } | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
            const query = quickPick.value;
            const options: string[] = [];
            if (invertSelected) {
                options.push("Invert");
            }
            if (caseSensitiveSelected) {
                options.push("Case Sensitive");
            }
            quickPick.hide();
            resolve({ query, options });
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
        });
        quickPick.show();
    });
}

function getChainForEditor(editor: vscode.TextEditor): {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
} {
    const docUri = editor.document.uri.toString();
    if (chainGrepMap.has(docUri)) {
        return chainGrepMap.get(docUri)!;
    }
    return { chain: [], sourceUri: editor.document.uri };
}

async function executeChainSearchAndDisplayResults(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    parentDocUri?: string,
    label?: string
) {
    // Generate the document URI first to check if it already exists
    const docUri = generateChainGrepDocUri(sourceUri, chain);
    const docUriStr = docUri.toString();

    // Check if an identical document already exists in the map with content
    let existingDocWithContent = false;
    if (chainGrepMap.has(docUriStr) && chainGrepContents.has(docUriStr)) {
        existingDocWithContent = true;

        try {
            // If it exists, just open it instead of creating a new one
            const doc = await vscode.workspace.openTextDocument(docUri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
            });
            reapplyHighlightsLocal(editor, chainGrepMap);

            // Still update the tree view to ensure it's properly represented
            const nodeLabel = label || chain[chain.length - 1].query;
            if (parentDocUri) {
                chainGrepProvider.addSubChain(parentDocUri, nodeLabel, chain, docUriStr);
            } else {
                chainGrepProvider.addRootChain(sourceUri.toString(), nodeLabel, chain, docUriStr);
            }

            showStatusMessage(`Chain Grep: Opened existing search results`);
            return;
        } catch (error) {
            console.error("Failed to open existing chain grep document:", error);
            existingDocWithContent = false;
        }
    }

    // If we don't have an existing document with content, run the search
    const { lines: results, stats } = await executeChainSearch(sourceUri, chain);
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found.");
        return;
    } else {
        vscode.window.setStatusBarMessage(
            `Chain Grep: ${results.length} matches (${((results.length / stats.totalLines) * 100).toFixed(1)}%)`,
            5000
        );
    }

    const header = buildChainDetailedHeader(chain, stats);
    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + results.join("\n");
    } else {
        content = results.join("\n");
    }

    chainGrepContents.set(docUriStr, content);
    chainGrepMap.set(docUriStr, { chain, sourceUri });

    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
    });
    reapplyHighlightsLocal(editor, chainGrepMap);

    const nodeLabel = label || chain[chain.length - 1].query;
    if (parentDocUri) {
        chainGrepProvider.addSubChain(parentDocUri, nodeLabel, chain, docUriStr);
    } else {
        chainGrepProvider.addRootChain(sourceUri.toString(), nodeLabel, chain, docUriStr);
    }

    await synchronizeExistingBookmarks(sourceUri.toString(), docUri.toString());

    savePersistentState();
}

async function synchronizeExistingBookmarks(sourceUri: string, chainDocUri: string) {
    const sourceBookmarks = bookmarkProvider
        .getAllBookmarks()
        .filter((b) => b.sourceUri === sourceUri && b.docUri === "");

    if (sourceBookmarks.length === 0) {
        return;
    }

    const chainDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(chainDocUri));

    for (const bookmark of sourceBookmarks) {
        try {
            // Sprawdź czy istnieje już zakładka w łańcuchu z tym samym indeksem wystąpienia
            const existingChainBookmark = bookmarkProvider
                .getAllBookmarks()
                .find(
                    (b) =>
                        (b.linkedBookmarkId === bookmark.id && b.docUri === chainDocUri) ||
                        (b.docUri === chainDocUri &&
                            b.sourceUri === bookmark.sourceUri &&
                            b.lineText === bookmark.lineText &&
                            b.context?.occurrenceIndex === bookmark.context?.occurrenceIndex)
                );

            if (existingChainBookmark) {
                // Update links if needed
                if (
                    existingChainBookmark.linkedBookmarkId !== bookmark.id ||
                    bookmark.linkedBookmarkId !== existingChainBookmark.id
                ) {
                    existingChainBookmark.linkedBookmarkId = bookmark.id;
                    bookmark.linkedBookmarkId = existingChainBookmark.id;

                    // Ensure both bookmarks are properly updated in the provider
                    bookmarkProvider.addBookmark(existingChainBookmark);
                    bookmarkProvider.addBookmark(bookmark);
                }
                continue;
            }

            const matchingLineNumber = await bookmarkProvider.findBestMatchingLine(bookmark, chainDocUri);

            if (matchingLineNumber !== undefined && matchingLineNumber >= 0) {
                const lineText = chainDoc.lineAt(matchingLineNumber).text.trim();

                // Sprawdź czy istnieje zakładka w tym samym miejscu i z tym samym indeksem wystąpienia
                const existingBookmarkAtLine = bookmarkProvider
                    .getAllBookmarks()
                    .find(
                        (b) =>
                            b.docUri === chainDocUri &&
                            b.lineNumber === matchingLineNumber &&
                            b.context?.occurrenceIndex === bookmark.context?.occurrenceIndex
                    );

                if (existingBookmarkAtLine) {
                    // Link existing bookmark at that line
                    existingBookmarkAtLine.linkedBookmarkId = bookmark.id;
                    bookmark.linkedBookmarkId = existingBookmarkAtLine.id;

                    // Update both bookmarks
                    bookmarkProvider.addBookmark(existingBookmarkAtLine);
                    bookmarkProvider.addBookmark(bookmark);
                    continue;
                }

                // Create a new bookmark in the chain document
                const context = bookmarkProvider.getLineContext(chainDoc, matchingLineNumber, 5);

                const relativePosition = matchingLineNumber / (chainDoc.lineCount || 1);

                const chainBookmark: Bookmark = {
                    id: `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                    lineNumber: matchingLineNumber,
                    lineText,
                    docUri: chainDocUri,
                    sourceUri: bookmark.sourceUri,
                    label: bookmark.label,
                    timestamp: Date.now(),
                    linkedBookmarkId: bookmark.id,
                    context: {
                        beforeLines: context.beforeLines,
                        afterLines: context.afterLines,
                        relativePosition,
                        occurrenceIndex: context.occurrenceIndex,
                    },
                };

                // Update source bookmark with link to chain bookmark
                if (!bookmark.linkedBookmarkId) {
                    bookmark.linkedBookmarkId = chainBookmark.id;
                    bookmarkProvider.addBookmark(bookmark);
                }

                // Add new chain bookmark
                bookmarkProvider.addBookmark(chainBookmark);
            }
        } catch (error) {
            console.error(`Chain Grep: Error synchronizing bookmark:`, error);
        }
    }

    // Make sure the UI is updated
    bookmarkProvider.refresh();
    bookmarkProvider.reapplyAllBookmarkDecorations();
}

async function executeChainSearchAndUpdateEditor(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    editor: vscode.TextEditor
) {
    const { lines, stats } = await executeChainSearch(sourceUri, chain);
    if (!lines.length) {
        vscode.window.showInformationMessage("No matches after refresh.");
        return;
    }

    const header = buildChainDetailedHeader(chain, stats);

    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + lines.join("\n");
    } else {
        content = lines.join("\n");
    }

    const docUri = editor.document.uri.toString();

    const existingBookmarks = bookmarkProvider
        .getAllBookmarks()
        .filter((b) => b.docUri === docUri)
        .map((b) => ({ ...b }));

    chainGrepContents.set(docUri, content);

    await vscode.commands.executeCommand("workbench.action.files.revert");

    let oldViewColumn = editor.viewColumn || vscode.ViewColumn.One;

    const doc = await vscode.workspace.openTextDocument(editor.document.uri);
    const newEd = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: oldViewColumn,
    });
    reapplyHighlightsLocal(newEd, chainGrepMap);

    await bookmarkProvider.synchronizeBookmarks(docUri, doc);

    for (const oldBookmark of existingBookmarks) {
        const existingBookmarkNow = bookmarkProvider.getAllBookmarks().find((b) => b.id === oldBookmark.id);

        if (!existingBookmarkNow) {
            const matchingLine = await bookmarkProvider.findBestMatchingLine(oldBookmark, docUri);

            if (matchingLine !== undefined) {
                const lineText = doc.lineAt(matchingLine).text.trim();
                const context = bookmarkProvider.getLineContext(doc, matchingLine);

                const newBookmark: Bookmark = {
                    ...oldBookmark,
                    lineNumber: matchingLine,
                    lineText,
                    context: {
                        beforeLines: context.beforeLines,
                        afterLines: context.afterLines,
                        relativePosition: matchingLine / (doc.lineCount || 1),
                        occurrenceIndex: context.occurrenceIndex,
                    },
                };

                bookmarkProvider.addBookmark(newBookmark);
            }
        }
    }

    savePersistentState();
}

function revealChainNode(docUri: string) {
    // Sprawdź tylko czy widok Chain Grep jest widoczny
    if (!chainTreeView?.visible) {
        return;
    }

    // Najpierw znajdź odpowiedni węzeł
    let nodeToReveal: ChainGrepNode | undefined;

    if (docUri.startsWith("chaingrep:")) {
        nodeToReveal = chainGrepProvider.docUriToNode.get(docUri);
    } else {
        nodeToReveal = chainGrepProvider.findRootNodeBySourceUri(docUri);
    }

    if (nodeToReveal && chainTreeView) {
        try {
            // Używamy standardowego reveal bez czyszczenia poprzedniego zaznaczenia
            chainTreeView.reveal(nodeToReveal, {
                select: true,
                focus: false,
                expand: true,
            });
        } catch (error) {
            console.error(`Chain Grep: Error revealing node:`, error);
        }
    }
}

async function openNode(node: ChainGrepNode) {
    if (node.docUri) {
        if (!chainGrepContents.has(node.docUri)) {
            const chainDoc = chainGrepMap.get(node.docUri);
            if (chainDoc) {
                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Regenerating chain grep results...",
                        cancellable: false,
                    },
                    async () => {
                        const { chain, sourceUri } = chainDoc;
                        const { lines, stats } = await executeChainSearch(sourceUri, chain);
                        const header = buildChainDetailedHeader(chain, stats);
                        let content = "";
                        if (isDetailedChainDocEnabled()) {
                            content = header + "\n\n" + lines.join("\n");
                        } else {
                            content = lines.join("\n");
                        }
                        chainGrepContents.set(node.docUri!, content);
                        savePersistentState();
                    }
                );
            }
        }

        const docUri = vscode.Uri.parse(node.docUri);
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc, { preview: false });

        revealChainNode(node.docUri);
    } else {
        const sourceDoc = await vscode.workspace.openTextDocument(node.sourceUri);
        await vscode.window.showTextDocument(sourceDoc, { preview: false });
    }
}

async function closeNode(node: ChainGrepNode) {
    const nodesToRemove = collectNodeAndDescendants(node);

    for (const nodeToRemove of nodesToRemove) {
        if (nodeToRemove.docUri) {
            chainGrepMap.delete(nodeToRemove.docUri);
            chainGrepContents.delete(nodeToRemove.docUri);
        }
    }

    chainGrepProvider.removeNode(node);
    bookmarkProvider.refresh();
    savePersistentState();
}

function collectNodeAndDescendants(node: ChainGrepNode): ChainGrepNode[] {
    const result: ChainGrepNode[] = [node];
    for (const child of node.children) {
        result.push(...collectNodeAndDescendants(child));
    }
    return result;
}

async function refreshAndOpen(node: ChainGrepNode) {
    if (!node.docUri) {
        vscode.window.showInformationMessage("Can't refresh root node.");
        return;
    }

    const chainDocInfo = chainGrepMap.get(node.docUri);
    if (!chainDocInfo) {
        vscode.window.showInformationMessage("No chain doc info found.");
        return;
    }

    const { chain, sourceUri } = chainDocInfo;

    try {
        const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
        await vscode.window.showTextDocument(sourceDoc, { preview: false });
        await vscode.commands.executeCommand("workbench.action.files.revert");

        const docUri = vscode.Uri.parse(node.docUri);
        const chainDoc = await vscode.workspace.openTextDocument(docUri);
        const newChainEditor = await vscode.window.showTextDocument(chainDoc, {
            preview: false,
        });

        await executeChainSearchAndUpdateEditor(sourceUri, chain, newChainEditor);

        await synchronizeExistingBookmarks(sourceUri.toString(), node.docUri);

        bookmarkProvider.refresh();

        revealChainNode(node.docUri);

        vscode.window.showInformationMessage("Refreshed successfully.");
    } catch {
        vscode.window.showInformationMessage("Unable to refresh the chain doc.");
    }
}

async function recoverFailedChainGrepFiles() {
    const visibleEditors = vscode.window.visibleTextEditors;

    for (const editor of visibleEditors) {
        const uri = editor.document.uri;

        if (uri.scheme === CHAIN_GREP_SCHEME) {
            const content = editor.document.getText();
            if (content === "Loading Chain Grep results..." || content === "") {
                const uriStr = uri.toString();
                if (chainGrepMap.has(uriStr) && !chainGrepContents.has(uriStr)) {
                    const chainInfo = chainGrepMap.get(uriStr)!;

                    vscode.window.showInformationMessage("Recovering Chain Grep file...");

                    const { lines, stats } = await executeChainSearch(chainInfo.sourceUri, chainInfo.chain);
                    const header = buildChainDetailedHeader(chainInfo.chain, stats);
                    let newContent = "";
                    if (isDetailedChainDocEnabled()) {
                        newContent = header + "\n\n" + lines.join("\n");
                    } else {
                        newContent = lines.join("\n");
                    }

                    chainGrepContents.set(uriStr, newContent);

                    await vscode.commands.executeCommand("workbench.action.files.revert");

                    const doc = await vscode.workspace.openTextDocument(uri);
                    bookmarkProvider.synchronizeBookmarks(uriStr, doc);
                }
            }
        }
    }
}

async function closeAllNodes() {
    const roots = Array.from(chainGrepProvider.getAllRoots());

    if (roots.length === 0) {
        vscode.window.showInformationMessage("No results to clear");
        return;
    }

    for (const node of roots) {
        const nodesToRemove = collectNodeAndDescendants(node);
        for (const nodeToRemove of nodesToRemove) {
            if (nodeToRemove.docUri) {
                chainGrepMap.delete(nodeToRemove.docUri);
                chainGrepContents.delete(nodeToRemove.docUri);
            }
        }
        chainGrepProvider.removeNode(node);
    }

    bookmarkProvider.refresh();
    savePersistentState();
    vscode.window.showInformationMessage(`Cleared all results`);
}

export function deactivate() {
    cleanupUnusedResources(false, isCleanupLoggingEnabled());
    bookmarkProvider.dispose();
    savePersistentState();
}

async function addBookmarkAtCurrentLine() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("No active editor.");
        return;
    }

    const docUri = editor.document.uri.toString();
    let sourceUri: string;
    let chainInfo: any;

    if (editor.document.uri.scheme === CHAIN_GREP_SCHEME) {
        chainInfo = chainGrepMap.get(docUri);
        if (!chainInfo) {
            vscode.window.showInformationMessage("No chain info for this document.");
            return;
        }
        sourceUri = chainInfo.sourceUri.toString();
    } else {
        sourceUri = docUri;
    }

    const selection = editor.selection;
    const lineNumber = selection.active.line;
    const lineText = editor.document.lineAt(lineNumber).text.trim();

    const existingBookmarks = bookmarkProvider.getAllBookmarks();
    const existingBookmark = existingBookmarks.find((b) => {
        if (editor.document.uri.scheme === CHAIN_GREP_SCHEME) {
            return b.docUri === docUri && b.lineNumber === lineNumber;
        } else {
            return b.sourceUri === sourceUri && b.docUri === "" && b.lineNumber === lineNumber;
        }
    });

    if (existingBookmark) {
        bookmarkProvider.removeBookmark(existingBookmark.id);
        savePersistentState();
        vscode.window.showInformationMessage("Bookmark removed.");
        return;
    }

    const label = await vscode.window.showInputBox({
        prompt: "Enter optional bookmark label (leave empty for default)",
        placeHolder: "Bookmark label",
    });

    if (label === undefined) {
        return;
    }

    const context = bookmarkProvider.getLineContext(editor.document, lineNumber, 5);

    const relativePosition = lineNumber / (editor.document.lineCount || 1);

    const bookmarkId = `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    const bookmark: Bookmark = {
        id: bookmarkId,
        lineNumber,
        lineText,
        docUri: editor.document.uri.scheme === CHAIN_GREP_SCHEME ? docUri : "",
        sourceUri,
        label: label || undefined,
        timestamp: Date.now(),
        context: {
            beforeLines: context.beforeLines,
            afterLines: context.afterLines,
            relativePosition,
            occurrenceIndex: context.occurrenceIndex,
        },
    };

    bookmarkProvider.addBookmark(bookmark);

    debouncedSaveState();

    if (editor.document.uri.scheme !== CHAIN_GREP_SCHEME) {
        try {
            await bookmarkProvider.synchronizeBookmarkToAllChainDocs(bookmark);

            await synchronizeBookmarksToAllExistingDocuments(sourceUri);

            const updatedSourceBookmark = bookmarkProvider.getAllBookmarks().find((b) => b.id === bookmarkId);
            if (updatedSourceBookmark && updatedSourceBookmark.docUri !== "") {
                updatedSourceBookmark.docUri = "";
                bookmarkProvider.addBookmark(updatedSourceBookmark);
            }
        } catch (error) {
            console.error("Error during bookmark synchronization:", error);
        }
    } else {
        await bookmarkProvider.synchronizeBookmarkToFile(bookmark);
    }

    savePersistentState();

    bookmarkProvider.reapplyAllBookmarkDecorations();

    vscode.window.showInformationMessage("Bookmark added and synchronized.");
}

function removeBookmark(node: BookmarkNode) {
    bookmarkProvider.removeBookmark(node.bookmark.id);
    debouncedSaveState();
    vscode.window.showInformationMessage("Bookmark removed.");
}

function clearAllBookmarks() {
    bookmarkProvider.clearAllBookmarks();
    savePersistentState();
    vscode.window.showInformationMessage("Cleared all bookmarks from all files.");
}

function clearCurrentDocumentBookmarks() {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showInformationMessage("No active editor.");
        return;
    }

    const activeDocUri = activeEditor.document.uri.toString();

    if (activeDocUri.startsWith("chaingrep:")) {
        bookmarkProvider.clearBookmarksFromDocument(activeDocUri);
        savePersistentState();
        vscode.window.showInformationMessage("Cleared bookmarks from current Chain Grep document.");
    } else {
        bookmarkProvider.clearBookmarksFromFile(activeDocUri);
        savePersistentState();
        vscode.window.showInformationMessage(
            "Cleared all bookmarks from current file and related Chain Grep documents."
        );
    }
}

function getAllChainGrepDocumentsForSource(sourceUri: string): string[] {
    const chainGrepDocuments: string[] = [];

    for (const [docUri, info] of chainGrepMap.entries()) {
        if (info.sourceUri.toString() === sourceUri) {
            chainGrepDocuments.push(docUri);
        }
    }

    return chainGrepDocuments;
}

async function synchronizeBookmarksToAllExistingDocuments(sourceUri: string) {
    const chainDocsForSource = Array.from(chainGrepMap.entries())
        .filter(([, info]) => info.sourceUri.toString() === sourceUri)
        .map(([docUri]) => docUri);

    if (chainDocsForSource.length === 0) {
        return;
    }

    const sourceBookmarks = bookmarkProvider
        .getAllBookmarks()
        .filter((b) => b.sourceUri === sourceUri && (!b.docUri || b.docUri === ""));

    for (const chainDocUri of chainDocsForSource) {
        const chainInfo = chainGrepMap.get(chainDocUri);
        if (!chainInfo) {
            continue;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(chainDocUri));

            const existingChainBookmarks = bookmarkProvider.getAllBookmarks().filter((b) => b.docUri === chainDocUri);

            for (const sourceBookmark of sourceBookmarks) {
                const linkedBookmark = existingChainBookmarks.find(
                    (b) =>
                        b.linkedBookmarkId === sourceBookmark.id ||
                        (b.sourceUri === sourceBookmark.sourceUri && b.lineText === sourceBookmark.lineText)
                );

                if (linkedBookmark) {
                    if (linkedBookmark.linkedBookmarkId !== sourceBookmark.id) {
                        linkedBookmark.linkedBookmarkId = sourceBookmark.id;
                        bookmarkProvider.addBookmark(linkedBookmark);
                    }
                    if (sourceBookmark.linkedBookmarkId !== linkedBookmark.id) {
                        const updatedSourceBookmark = {
                            ...sourceBookmark,
                            linkedBookmarkId: linkedBookmark.id,
                        };
                        bookmarkProvider.addBookmark(updatedSourceBookmark);
                    }
                    continue;
                }

                const matchingLine = await bookmarkProvider.findBestMatchingLine(sourceBookmark, chainDocUri);

                if (matchingLine !== undefined && matchingLine !== -1) {
                    const lineText = document.lineAt(matchingLine).text.trim();
                    const context = bookmarkProvider.getLineContext(document, matchingLine, 5);
                    const relativePosition = matchingLine / (document.lineCount || 1);

                    const newBookmarkId = `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

                    const newBookmark: Bookmark = {
                        id: newBookmarkId,
                        lineNumber: matchingLine,
                        lineText,
                        docUri: chainDocUri,
                        sourceUri,
                        label: sourceBookmark.label,
                        timestamp: Date.now(),
                        linkedBookmarkId: sourceBookmark.id,
                        context: {
                            beforeLines: context.beforeLines,
                            afterLines: context.afterLines,
                            relativePosition,
                            occurrenceIndex: context.occurrenceIndex,
                        },
                    };

                    const updatedSourceBookmark = {
                        ...sourceBookmark,
                        linkedBookmarkId: newBookmarkId,
                    };

                    bookmarkProvider.addBookmark(updatedSourceBookmark);

                    bookmarkProvider.addBookmark(newBookmark);
                }
            }
        } catch (err) {
            console.error(`Failed to synchronize bookmarks with document ${chainDocUri}:`, err);
        }
    }
}
