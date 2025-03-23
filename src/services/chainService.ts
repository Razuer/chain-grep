import * as vscode from "vscode";
import { ChainGrepNode } from "../models/chainGrepNode";
import { ChainGrepQuery } from "../models/interfaces";
import { ChainGrepDataProvider } from "../providers/chainGrepDataProvider";
import {
    getChainGrepMap,
    getChainGrepContents,
    savePersistentState,
} from "./stateService";
import { BookmarkProvider } from "../providers/bookmarkProvider";
import {
    executeChainSearch,
    buildChainDetailedHeader,
    generateChainGrepDocUri,
} from "./searchService";
import { isDetailedChainDocEnabled } from "./configService";
import { reapplyHighlightsLocal } from "./highlightService";

export function getChainForEditor(editor: vscode.TextEditor): {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
} {
    const docUri = editor.document.uri.toString();
    const chainGrepMap = getChainGrepMap();

    if (chainGrepMap.has(docUri)) {
        return chainGrepMap.get(docUri)!;
    }
    return { chain: [], sourceUri: editor.document.uri };
}

export async function executeChainSearchAndDisplayResults(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    parentDocUri?: string,
    label?: string,
    chainGrepProvider?: ChainGrepDataProvider,
    bookmarkProvider?: BookmarkProvider
) {
    const chainGrepMap = getChainGrepMap();
    const chainGrepContents = getChainGrepContents();

    const provider = chainGrepProvider || new ChainGrepDataProvider();
    const bookmarkProv = bookmarkProvider || new BookmarkProvider();

    const docUri = generateChainGrepDocUri(sourceUri, chain);
    const docUriStr = docUri.toString();

    let existingDocWithContent = false;
    if (chainGrepMap.has(docUriStr) && chainGrepContents.has(docUriStr)) {
        existingDocWithContent = true;

        try {
            const doc = await vscode.workspace.openTextDocument(docUri);
            const editor = await vscode.window.showTextDocument(doc, {
                preview: false,
            });
            reapplyHighlightsLocal(editor, chainGrepMap);

            const nodeLabel = label || chain[chain.length - 1].query;
            if (parentDocUri) {
                provider.addSubChain(parentDocUri, nodeLabel, chain, docUriStr);
            } else {
                provider.addRootChain(
                    sourceUri.toString(),
                    nodeLabel,
                    chain,
                    docUriStr
                );
            }

            vscode.window.setStatusBarMessage(
                `Chain Grep: Opened existing search results`,
                2000
            );
            return;
        } catch (error) {
            console.error(
                "Failed to open existing chain grep document:",
                error
            );
            existingDocWithContent = false;
        }
    }

    const { lines: results, stats } = await executeChainSearch(
        sourceUri,
        chain
    );
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found.");
        return;
    } else {
        vscode.window.setStatusBarMessage(
            `Chain Grep: ${results.length} matches (${(
                (results.length / stats.totalLines) *
                100
            ).toFixed(1)}%)`,
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
        provider.addSubChain(parentDocUri, nodeLabel, chain, docUriStr);
    } else {
        provider.addRootChain(
            sourceUri.toString(),
            nodeLabel,
            chain,
            docUriStr
        );
    }

    await synchronizeExistingBookmarks(
        sourceUri.toString(),
        docUri.toString(),
        bookmarkProv
    );

    savePersistentState();
}

export async function executeChainSearchAndUpdateEditor(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    editor: vscode.TextEditor,
    bookmarkProvider?: BookmarkProvider
) {
    const chainGrepMap = getChainGrepMap();
    const chainGrepContents = getChainGrepContents();
    const bookmarkProv = bookmarkProvider || new BookmarkProvider();

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

    const existingBookmarks = bookmarkProv
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

    await bookmarkProv.synchronizeBookmarks(docUri, doc);

    for (const oldBookmark of existingBookmarks) {
        const existingBookmarkNow = bookmarkProv
            .getAllBookmarks()
            .find((b) => b.id === oldBookmark.id);

        if (!existingBookmarkNow) {
            const matchingLine = await bookmarkProv.findBestMatchingLine(
                oldBookmark,
                docUri
            );

            if (matchingLine !== undefined) {
                const lineText = doc.lineAt(matchingLine).text.trim();
                const context = bookmarkProv.getLineContext(doc, matchingLine);

                const newBookmark = {
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

                bookmarkProv.addBookmark(newBookmark);
            }
        }
    }

    savePersistentState();
}

export async function synchronizeExistingBookmarks(
    sourceUri: string,
    chainDocUri: string,
    bookmarkProvider: BookmarkProvider
) {
    const sourceBookmarks = bookmarkProvider.findBookmarks({
        sourceUri: sourceUri,
        docUri: null,
    });

    if (sourceBookmarks.length === 0) {
        return;
    }

    const chainDoc = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(chainDocUri)
    );

    for (const bookmark of sourceBookmarks) {
        try {
            const existingChainBookmark = bookmarkProvider
                .findBookmarks({
                    docUri: chainDocUri,
                    sourceUri: bookmark.sourceUri,
                    occurrenceIndex: bookmark.context?.occurrenceIndex,
                })
                .find(
                    (b) =>
                        b.linkedBookmarkId === bookmark.id ||
                        b.lineText === bookmark.lineText
                );

            if (existingChainBookmark) {
                if (
                    existingChainBookmark.linkedBookmarkId !== bookmark.id ||
                    bookmark.linkedBookmarkId !== existingChainBookmark.id
                ) {
                    existingChainBookmark.linkedBookmarkId = bookmark.id;
                    bookmark.linkedBookmarkId = existingChainBookmark.id;

                    bookmarkProvider.addBookmark(existingChainBookmark);
                    bookmarkProvider.addBookmark(bookmark);
                }
                continue;
            }

            const matchingLineNumber =
                await bookmarkProvider.findBestMatchingLine(
                    bookmark,
                    chainDocUri
                );

            if (matchingLineNumber !== undefined && matchingLineNumber >= 0) {
                const lineText = chainDoc
                    .lineAt(matchingLineNumber)
                    .text.trim();

                const existingBookmarkAtLine = bookmarkProvider.findBookmarks({
                    docUri: chainDocUri,
                    lineNumber: matchingLineNumber,
                    occurrenceIndex: bookmark.context?.occurrenceIndex,
                })[0];

                if (existingBookmarkAtLine) {
                    existingBookmarkAtLine.linkedBookmarkId = bookmark.id;
                    bookmark.linkedBookmarkId = existingBookmarkAtLine.id;

                    bookmarkProvider.addBookmark(existingBookmarkAtLine);
                    bookmarkProvider.addBookmark(bookmark);
                    continue;
                }

                const context = bookmarkProvider.getLineContext(
                    chainDoc,
                    matchingLineNumber,
                    5
                );

                const relativePosition =
                    matchingLineNumber / (chainDoc.lineCount || 1);

                const chainBookmark = {
                    id: `bookmark_${Date.now()}_${Math.random()
                        .toString(36)
                        .substring(2, 11)}`,
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

                if (!bookmark.linkedBookmarkId) {
                    bookmark.linkedBookmarkId = chainBookmark.id;
                    bookmarkProvider.addBookmark(bookmark);
                }

                bookmarkProvider.addBookmark(chainBookmark);
            }
        } catch (error) {
            console.error(`Chain Grep: Error synchronizing bookmark:`, error);
        }
    }

    bookmarkProvider.refresh();
    bookmarkProvider.reapplyAllBookmarkDecorations();
}

export function collectNodeAndDescendants(
    node: ChainGrepNode
): ChainGrepNode[] {
    const result: ChainGrepNode[] = [node];
    for (const child of node.children) {
        result.push(...collectNodeAndDescendants(child));
    }
    return result;
}

export async function openNode(
    node: ChainGrepNode,
    chainTreeView?: vscode.TreeView<ChainGrepNode>,
    chainGrepProvider?: ChainGrepDataProvider
) {
    const chainGrepContents = getChainGrepContents();
    const chainGrepMap = getChainGrepMap();

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
                        const { lines, stats } = await executeChainSearch(
                            sourceUri,
                            chain
                        );
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

        revealChainNode(node.docUri, chainTreeView, chainGrepProvider);
    } else {
        const sourceDoc = await vscode.workspace.openTextDocument(
            node.sourceUri
        );
        await vscode.window.showTextDocument(sourceDoc, { preview: false });
    }
}

export async function closeNode(
    node: ChainGrepNode,
    chainGrepProvider: ChainGrepDataProvider,
    bookmarkProvider?: BookmarkProvider
) {
    const chainGrepMap = getChainGrepMap();
    const chainGrepContents = getChainGrepContents();
    const bookmarkProv = bookmarkProvider || new BookmarkProvider();

    const nodesToRemove = collectNodeAndDescendants(node);

    for (const nodeToRemove of nodesToRemove) {
        if (nodeToRemove.docUri) {
            chainGrepMap.delete(nodeToRemove.docUri);
            chainGrepContents.delete(nodeToRemove.docUri);
        }
    }

    chainGrepProvider.removeNode(node);
    bookmarkProv.refresh();
    savePersistentState();
}

export async function refreshAndOpenNode(
    node: ChainGrepNode,
    chainGrepProvider?: ChainGrepDataProvider,
    bookmarkProvider?: BookmarkProvider,
    chainTreeView?: vscode.TreeView<ChainGrepNode>
) {
    const chainGrepMap = getChainGrepMap();
    const bookmarkProv = bookmarkProvider || new BookmarkProvider();

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

        await executeChainSearchAndUpdateEditor(
            sourceUri,
            chain,
            newChainEditor,
            bookmarkProv
        );

        await synchronizeExistingBookmarks(
            sourceUri.toString(),
            node.docUri,
            bookmarkProv
        );

        bookmarkProv.refresh();

        revealChainNode(node.docUri, chainTreeView, chainGrepProvider);

        vscode.window.showInformationMessage("Refreshed successfully.");
    } catch {
        vscode.window.showInformationMessage(
            "Unable to refresh the chain doc."
        );
    }
}

export async function recoverFailedChainGrepFiles(
    bookmarkProvider?: BookmarkProvider
) {
    const chainGrepMap = getChainGrepMap();
    const chainGrepContents = getChainGrepContents();
    const bookmarkProv = bookmarkProvider || new BookmarkProvider();

    const visibleEditors = vscode.window.visibleTextEditors;

    for (const editor of visibleEditors) {
        const uri = editor.document.uri;

        if (uri.scheme === "chaingrep") {
            const content = editor.document.getText();
            if (content === "Loading Chain Grep results..." || content === "") {
                const uriStr = uri.toString();
                if (
                    chainGrepMap.has(uriStr) &&
                    !chainGrepContents.has(uriStr)
                ) {
                    const chainInfo = chainGrepMap.get(uriStr)!;

                    vscode.window.showInformationMessage(
                        "Recovering Chain Grep file..."
                    );

                    const { lines, stats } = await executeChainSearch(
                        chainInfo.sourceUri,
                        chainInfo.chain
                    );
                    const header = buildChainDetailedHeader(
                        chainInfo.chain,
                        stats
                    );
                    let newContent = "";
                    if (isDetailedChainDocEnabled()) {
                        newContent = header + "\n\n" + lines.join("\n");
                    } else {
                        newContent = lines.join("\n");
                    }

                    chainGrepContents.set(uriStr, newContent);

                    await vscode.commands.executeCommand(
                        "workbench.action.files.revert"
                    );

                    const doc = await vscode.workspace.openTextDocument(uri);
                    bookmarkProv.synchronizeBookmarks(uriStr, doc);
                }
            }
        }
    }
}

export async function closeAllNodes(
    chainGrepProvider: ChainGrepDataProvider,
    bookmarkProvider?: BookmarkProvider
) {
    const chainGrepMap = getChainGrepMap();
    const chainGrepContents = getChainGrepContents();
    const bookmarkProv = bookmarkProvider || new BookmarkProvider();

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

    bookmarkProv.refresh();
    savePersistentState();
    vscode.window.showInformationMessage(`Cleared all results`);
}

export function revealChainNode(
    docUri: string,
    chainTreeView?: vscode.TreeView<ChainGrepNode>,
    chainGrepProvider?: ChainGrepDataProvider
) {
    if (!chainTreeView?.visible || !chainGrepProvider) {
        return;
    }

    let nodeToReveal: ChainGrepNode | undefined;

    if (docUri.startsWith("chaingrep:")) {
        nodeToReveal = chainGrepProvider.docUriToNode.get(docUri);
    } else {
        nodeToReveal = chainGrepProvider.findRootNodeBySourceUri(docUri);
    }

    if (nodeToReveal && chainTreeView) {
        try {
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
