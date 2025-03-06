import * as vscode from "vscode";
import { ChainGrepQuery } from "./models/interfaces";
import { ChainGrepNode } from "./models/chainGrepNode";
import { ChainGrepDataProvider } from "./providers/chainGrepDataProvider";
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
} from "./services/configService";
import { getSelectedTextOrWord } from "./utils/utils";

const CHAIN_GREP_SCHEME = "chaingrep";

const chainGrepProvider = new ChainGrepDataProvider();
const chainGrepMap = getChainGrepMap();
const chainGrepContents = getChainGrepContents();

export async function activate(context: vscode.ExtensionContext) {
    setContext(context);

    const chainGrepFs = new ChainGrepFSProvider(chainGrepContents, chainGrepMap);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(CHAIN_GREP_SCHEME, chainGrepFs, {
            isReadonly: false,
        })
    );

    initHighlightDecorations();

    loadPersistentState(context, chainGrepProvider);

    chainGrepFs.markInitialized();

    setTimeout(() => {
        applyHighlightsToOpenEditors(chainGrepMap);
        showStatusMessage("Chain Grep: Applied highlights from saved state", 1000);
    }, 1000);

    const treeView = vscode.window.createTreeView("chainGrepView", {
        treeDataProvider: chainGrepProvider,
        showCollapseAll: true,
    });

    treeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            chainGrepProvider.refresh();
            recoverFailedChainGrepFiles();
        }
    });

    context.subscriptions.push(treeView);

    cleanupUnusedResources(false);

    let cleanupInterval: NodeJS.Timeout | undefined;
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
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                reapplyHighlightsLocal(editor, chainGrepMap);
                reapplyHighlightsGlobal(editor);
            }
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
        vscode.workspace.onDidChangeConfiguration(handleConfigChange)
    );
}

function handleConfigChange(e: vscode.ConfigurationChangeEvent) {
    if (e.affectsConfiguration("chainGrep.cleanupInterval")) {
    }

    if (e.affectsConfiguration("chainGrep.showScrollbarIndicators")) {
        console.log("Chain Grep: Scrollbar indicators setting changed, updating decorations");
        resetAllHighlightDecorations(chainGrepMap);
        applyHighlightsToOpenEditors(chainGrepMap);
    }

    if (e.affectsConfiguration("chainGrep.colours")) {
        console.log("Chain Grep: Color palette changed, resetting all highlights");
        resetAllHighlightDecorations(chainGrepMap, true);
    }

    if (e.affectsConfiguration("chainGrep.randomColors")) {
        console.log("Chain Grep: Random colors setting changed");
        resetAllHighlightDecorations(chainGrepMap, true);
    }

    if (
        e.affectsConfiguration("chainGrep.colours") ||
        e.affectsConfiguration("chainGrep.showScrollbarIndicators") ||
        e.affectsConfiguration("chainGrep.randomColors")
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
    const { lines: results, stats } = await executeChainSearch(sourceUri, chain);
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found.");
    } else {
        showStatusMessage(
            `Chain Grep: Found ${results.length} matches (${((results.length / stats.totalLines) * 100).toFixed(
                1
            )}% of source)`
        );
    }

    const header = buildChainDetailedHeader(chain, stats);
    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + results.join("\n");
    } else {
        content = results.join("\n");
    }

    const docUri = generateChainGrepDocUri(sourceUri, chain);

    chainGrepContents.set(docUri.toString(), content);
    chainGrepMap.set(docUri.toString(), { chain, sourceUri });

    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
    });
    reapplyHighlightsLocal(editor, chainGrepMap);

    const nodeLabel = label || chain[chain.length - 1].query;
    if (parentDocUri) {
        chainGrepProvider.addSubChain(parentDocUri, nodeLabel, chain, docUri.toString());
    } else {
        chainGrepProvider.addRootChain(sourceUri.toString(), nodeLabel, chain, docUri.toString());
    }

    savePersistentState();
}

async function executeChainSearchAndUpdateEditor(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    editor: vscode.TextEditor
) {
    const { lines, stats } = await executeChainSearch(sourceUri, chain);
    if (!lines.length) {
        vscode.window.showInformationMessage("No matches found after refresh.");
        return;
    }

    const header = buildChainDetailedHeader(chain, stats);

    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + lines.join("\n");
    } else {
        content = lines.join("\n");
    }

    chainGrepContents.set(editor.document.uri.toString(), content);

    await vscode.commands.executeCommand("workbench.action.files.revert");

    let oldViewColumn = editor.viewColumn || vscode.ViewColumn.One;

    const doc = await vscode.workspace.openTextDocument(editor.document.uri);
    const newEd = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: oldViewColumn,
    });
    reapplyHighlightsLocal(newEd, chainGrepMap);

    savePersistentState();
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
    } else {
        const sourceDoc = await vscode.workspace.openTextDocument(node.sourceUri);
        await vscode.window.showTextDocument(sourceDoc, { preview: false });
    }
}

async function closeNode(node: ChainGrepNode) {
    console.log("ChainGrep: Fully removing node and all data from tree");

    const nodesToRemove = collectNodeAndDescendants(node);

    for (const nodeToRemove of nodesToRemove) {
        if (nodeToRemove.docUri) {
            chainGrepMap.delete(nodeToRemove.docUri);
            chainGrepContents.delete(nodeToRemove.docUri);
        }
    }

    chainGrepProvider.removeNode(node);
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
                }
            }
        }
    }
}

async function closeAllNodes() {
    const roots = Array.from(chainGrepProvider.getAllRoots());

    if (roots.length === 0) {
        vscode.window.showInformationMessage("Chain Grep: No results to clear");
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

    savePersistentState();
    vscode.window.showInformationMessage(`Chain Grep: Cleared all results`);
}

export function deactivate() {
    cleanupUnusedResources();
    savePersistentState();
}
