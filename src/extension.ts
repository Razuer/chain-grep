import * as vscode from "vscode";
import * as path from "path";
import { ChainGrepQuery } from "./models/interfaces";
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
import {
    getChainGrepMap,
    getChainGrepContents,
    savePersistentState,
    loadPersistentState,
    setContext,
    cleanupUnusedResources,
} from "./services/stateService";
import {
    getCleanupInterval,
    showStatusMessage,
    isCleanupLoggingEnabled,
    handleConfigChange,
} from "./services/configService";
import {
    addBookmarkAtCurrentLine,
    removeFileBookmarks,
    clearCurrentDocumentBookmarks,
} from "./services/bookmarkService";
import { getSelectedTextOrWord } from "./utils/utils";
import {
    showQueryAndOptionsQuickInput,
    processRegexInput,
} from "./services/uiService";
import {
    getChainForEditor,
    executeChainSearchAndDisplayResults,
    executeChainSearchAndUpdateEditor,
    openNode,
    closeNode,
    refreshAndOpenNode,
    recoverFailedChainGrepFiles,
    closeAllNodes,
    revealChainNode,
} from "./services/chainService";

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

    const chainGrepFs = new ChainGrepFSProvider(
        chainGrepContents,
        chainGrepMap
    );
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(
            CHAIN_GREP_SCHEME,
            chainGrepFs,
            {
                isReadonly: false,
            }
        )
    );

    initHighlightDecorations();

    loadPersistentState(context, chainGrepProvider, bookmarkProvider);

    chainGrepFs.markInitialized();

    vscode.commands.executeCommand(
        "setContext",
        "editorIsOpen",
        !!vscode.window.activeTextEditor
    );

    setTimeout(() => {
        applyHighlightsToOpenEditors(chainGrepMap);
        bookmarkProvider.reapplyAllBookmarkDecorations();
    }, 1000);

    chainTreeView = vscode.window.createTreeView("chainGrepView", {
        treeDataProvider: chainGrepProvider,
        showCollapseAll: true,
    });

    const bookmarkTreeView = vscode.window.createTreeView(
        "chainGrepBookmarks",
        {
            treeDataProvider: bookmarkProvider,
            showCollapseAll: true,
        }
    );

    bookmarkProvider.setTreeView(bookmarkTreeView);
    bookmarkProvider.setChainGrepTree(chainGrepProvider, chainTreeView);

    chainTreeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            chainGrepProvider.refresh();
            recoverFailedChainGrepFiles(bookmarkProvider);
        }
    });

    context.subscriptions.push(chainTreeView, bookmarkTreeView);

    cleanupUnusedResources(false, isCleanupLoggingEnabled());

    const intervalMs = getCleanupInterval();

    if (intervalMs > 0) {
        cleanupInterval = setInterval(
            () => cleanupUnusedResources(false),
            intervalMs
        );
        showStatusMessage(
            `ChainGrep: Scheduled cleanup every ${intervalMs / 60000} minutes`,
            1500
        );
    } else {
        showStatusMessage(`ChainGrep: Automatic cleanup disabled`, 1500);
    }

    const openNodeCmd = vscode.commands.registerCommand(
        "_chainGrep.openNode",
        (node: ChainGrepNode) => {
            openNode(node, chainTreeView);
        }
    );

    const closeNodeCmd = vscode.commands.registerCommand(
        "_chainGrep.closeNode",
        (node: ChainGrepNode) => {
            closeNode(node, chainGrepProvider, bookmarkProvider);
        }
    );

    const refreshAndOpenCmd = vscode.commands.registerCommand(
        "_chainGrep.refreshAndOpenNode",
        (node: ChainGrepNode) => {
            refreshAndOpenNode(
                node,
                chainGrepProvider,
                bookmarkProvider,
                chainTreeView
            );
        }
    );

    const closeAllNodesCmd = vscode.commands.registerCommand(
        "chainGrep.closeAllNodes",
        () => closeAllNodes(chainGrepProvider, bookmarkProvider)
    );

    const addBookmarkCmd = vscode.commands.registerCommand(
        "chainGrep.addBookmark",
        async () => {
            await addBookmarkAtCurrentLine(bookmarkProvider);
            savePersistentState();
        }
    );

    const openBookmarkCmd = vscode.commands.registerCommand(
        "_chainGrep.openBookmark",
        (node: BookmarkNode) => {
            bookmarkProvider.openBookmark(node);
        }
    );

    const removeBookmarkCmd = vscode.commands.registerCommand(
        "_chainGrep.removeBookmark",
        (node: BookmarkNode) => {
            bookmarkProvider.removeBookmarkWithRelated(node.bookmark.id);
            debouncedSaveState();
            vscode.window.showInformationMessage(
                "Bookmark and related references removed."
            );
        }
    );

    const clearBookmarksCmd = vscode.commands.registerCommand(
        "chainGrep.clearBookmarks",
        () => {
            bookmarkProvider.clearAllBookmarks();
            savePersistentState();
            vscode.window.showInformationMessage(
                "Cleared all bookmarks from all files."
            );
        }
    );

    const clearCurrentDocBookmarksCmd = vscode.commands.registerCommand(
        "chainGrep.clearCurrentDocBookmarks",
        () => {
            clearCurrentDocumentBookmarks(bookmarkProvider);
            savePersistentState();
        }
    );

    const clearAllLocalHighlightsCmd = vscode.commands.registerCommand(
        "chainGrep.clearAllLocalHighlights",
        () => {
            clearAllLocalHighlights(chainGrepMap);
            savePersistentState();
        }
    );

    const clearAllGlobalHighlightsCmd = vscode.commands.registerCommand(
        "_chainGrep.clearAllGlobalHighlights",
        () => {
            clearHighlightsGlobal(true);
            savePersistentState();
        }
    );

    const toggleHighlightCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.toggleHighlight",
        (editor) => {
            const text = getSelectedTextOrWord(editor);
            toggleHighlightLocal(editor, text, chainGrepMap);
            savePersistentState();
        }
    );

    const clearHighlightsCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.clearHighlights",
        (editor) => {
            clearHighlightsLocal(editor, chainGrepMap);
            savePersistentState();
        }
    );

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

    const grepTextCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.grepText",
        async (editor) => {
            const input = await showQueryAndOptionsQuickInput(
                undefined,
                "text"
            );
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

            await executeChainSearchAndDisplayResults(
                sourceUri,
                newChain,
                parentDocUri,
                input.query,
                chainGrepProvider,
                bookmarkProvider
            );
        }
    );

    const grepRegexCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.grepRegex",
        async (editor) => {
            const input = await showQueryAndOptionsQuickInput(
                undefined,
                "regex"
            );
            if (!input?.query) {
                return;
            }

            const inverted = input.options.includes("Invert");
            const caseSensitive = input.options.includes("Case Sensitive");

            const processedRegex = processRegexInput(input.query);
            if (!processedRegex) {
                return;
            }

            const { pattern, flags } = processedRegex;
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

            await executeChainSearchAndDisplayResults(
                sourceUri,
                newChain,
                parentDocUri,
                input.query,
                chainGrepProvider,
                bookmarkProvider
            );
        }
    );

    const grepSelectionCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.grepSelection",
        async (editor) => {
            const selText = editor.document.getText(editor.selection).trim();
            const input = await showQueryAndOptionsQuickInput(
                selText || "",
                "text"
            );
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

            await executeChainSearchAndDisplayResults(
                sourceUri,
                newChain,
                parentDocUri,
                input.query,
                chainGrepProvider,
                bookmarkProvider
            );
        }
    );

    const refreshChainCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.refresh",
        async (chainEditor) => {
            const chainDocUri = chainEditor.document.uri;
            const docUriStr = chainDocUri.toString();
            if (!chainGrepMap.has(docUriStr)) {
                vscode.window.showInformationMessage(
                    "No chain grep found for this document."
                );
                return;
            }
            const chainInfo = chainGrepMap.get(docUriStr)!;
            const sourceUri = chainInfo.sourceUri;
            try {
                const sourceDoc = await vscode.workspace.openTextDocument(
                    sourceUri
                );
                await vscode.window.showTextDocument(sourceDoc, {
                    preview: false,
                });

                await vscode.commands.executeCommand(
                    "workbench.action.files.revert"
                );

                const chainDoc = await vscode.workspace.openTextDocument(
                    chainDocUri
                );
                const newChainEditor = await vscode.window.showTextDocument(
                    chainDoc,
                    {
                        preview: false,
                    }
                );
                await executeChainSearchAndUpdateEditor(
                    sourceUri,
                    chainInfo.chain,
                    newChainEditor,
                    bookmarkProvider
                );
            } catch {
                vscode.window.showInformationMessage(
                    "Unable to refresh the source document."
                );
            }
        }
    );

    const closeDocHandler = vscode.workspace.onDidCloseTextDocument((doc) => {
        const docUri = doc.uri;

        if (docUri.scheme === CHAIN_GREP_SCHEME) {
            const uriString = docUri.toString();
            console.log(`ChainGrep: Chain grep file closed: ${uriString}`);

            const inContents = chainGrepContents.has(uriString);

            console.log(`ChainGrep: File exists in contents: ${inContents}`);

            if (inContents) {
                chainGrepContents.delete(uriString);
                console.log(
                    `ChainGrep: Content deleted from chainGrepContents, but chain info preserved`
                );
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
                    console.log(
                        `ChainGrep: Tab closed for document: ${uriString}`
                    );

                    const inContents = chainGrepContents.has(uriString);

                    console.log(
                        `ChainGrep: File exists in contents: ${inContents}`
                    );

                    if (inContents) {
                        chainGrepContents.delete(uriString);
                        console.log(
                            `ChainGrep: Content deleted from chainGrepContents, chain info preserved`
                        );
                        savePersistentState();
                    }
                }
            }
        }
    });

    const forceCleanupCmd = vscode.commands.registerCommand(
        "chainGrep.forceCleanup",
        async () => {
            cleanupUnusedResources(true);
        }
    );

    const removeFileBookmarksCommand = vscode.commands.registerCommand(
        "_chainGrep.removeFileBookmarks",
        (node: BookmarkNode) => {
            removeFileBookmarks(node, bookmarkProvider);
            debouncedSaveState();
        }
    );

    context.subscriptions.push(
        openNodeCmd,
        closeNodeCmd,
        refreshAndOpenCmd,
        addBookmarkCmd,
        openBookmarkCmd,
        removeBookmarkCmd,
        clearBookmarksCmd,
        clearCurrentDocBookmarksCmd,
        removeFileBookmarksCommand,
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
                    vscode.commands.executeCommand(
                        "workbench.view.extension.chainGrepViewContainer"
                    );
                    revealChainNode(docUri, chainTreeView, chainGrepProvider);
                } else if (chainTreeView?.visible) {
                    revealChainNode(docUri, chainTreeView, chainGrepProvider);
                }

                vscode.commands.executeCommand(
                    "setContext",
                    "editorIsOpen",
                    true
                );
            } else {
                vscode.commands.executeCommand(
                    "setContext",
                    "editorIsOpen",
                    false
                );
            }
        }),
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor) {
                const editor = event.textEditor;
                const lineNumber = editor.selection.active.line;
                const docUri = editor.document.uri.toString();

                let hasBookmark = false;

                if (docUri.startsWith("chaingrep:")) {
                    hasBookmark = bookmarkProvider.hasBookmarkAtLine(
                        docUri,
                        lineNumber
                    );
                } else {
                    hasBookmark = bookmarkProvider.hasSourceBookmarkAtLine(
                        docUri,
                        lineNumber
                    );

                    if (!hasBookmark) {
                        const sourceBookmarks =
                            bookmarkProvider.getSourceBookmarksAtLine(
                                docUri,
                                lineNumber
                            );
                        hasBookmark = sourceBookmarks.some(
                            (b) => b.linkedBookmarkId !== undefined
                        );
                    }
                }

                vscode.commands.executeCommand(
                    "setContext",
                    "editorHasBookmark",
                    hasBookmark
                );
            }
        }),
        vscode.workspace.onDidChangeTextDocument((event) => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && event.document === activeEditor.document) {
                bookmarkProvider
                    .updateBookmarkPositionsForDocument(
                        event.document,
                        event.contentChanges
                    )
                    .then((changed) => {
                        setTimeout(() => {
                            bookmarkProvider.reapplyAllBookmarkDecorations();

                            if (activeEditor) {
                                const lineNumber =
                                    activeEditor.selection.active.line;
                                const docUri =
                                    activeEditor.document.uri.toString();

                                let hasBookmark = false;

                                if (docUri.startsWith("chaingrep:")) {
                                    hasBookmark =
                                        bookmarkProvider.hasBookmarkAtLine(
                                            docUri,
                                            lineNumber
                                        );
                                } else {
                                    hasBookmark =
                                        bookmarkProvider.hasSourceBookmarkAtLine(
                                            docUri,
                                            lineNumber
                                        );

                                    if (!hasBookmark) {
                                        const sourceBookmarks =
                                            bookmarkProvider.getSourceBookmarksAtLine(
                                                docUri,
                                                lineNumber
                                            );
                                        hasBookmark = sourceBookmarks.some(
                                            (b) =>
                                                b.linkedBookmarkId !== undefined
                                        );
                                    }
                                }

                                vscode.commands.executeCommand(
                                    "setContext",
                                    "editorHasBookmark",
                                    hasBookmark
                                );
                            }
                        }, 100);

                        if (changed) {
                            debouncedSaveState();
                        }
                    })
                    .catch((error) => {
                        console.error(
                            "Error updating bookmark positions:",
                            error
                        );
                    });
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
        cleanupInterval
            ? new vscode.Disposable(() => clearInterval(cleanupInterval))
            : new vscode.Disposable(() => {}),
        closeDocHandler,
        tabCloseListener,
        closeAllNodesCmd,
        clearAllLocalHighlightsCmd,
        clearAllGlobalHighlightsCmd,
        forceCleanupCmd,
        vscode.workspace.onDidChangeConfiguration((e) => {
            const result = handleConfigChange(e, {
                cleanupInterval,
                chainGrepMap,
                bookmarkProvider,
                cleanupUnusedResources,
                highlightService: {
                    resetAllHighlightDecorations,
                    applyHighlightsToOpenEditors,
                },
                savePersistentState,
            });

            if (result.cleanupInterval !== undefined) {
                cleanupInterval = result.cleanupInterval;
            }
        }),
        new vscode.Disposable(() => {
            if (saveTimeout) {
                clearTimeout(saveTimeout);
            }
        })
    );
}

export function deactivate() {
    cleanupUnusedResources(false, isCleanupLoggingEnabled());
    bookmarkProvider.dispose();
    savePersistentState();
}
