import * as vscode from "vscode";
import * as path from "path";
import { Bookmark } from "../models/interfaces";
import { BookmarkNode, BookmarkNodeType } from "../models/bookmarkNode";
import { getChainGrepMap } from "./stateService";
import { BookmarkProvider } from "../providers/bookmarkProvider";

export async function addBookmarkAtCurrentLine(bookmarkProvider: BookmarkProvider): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage("No active editor.");
        return;
    }

    const docUri = editor.document.uri.toString();
    let sourceUri: string;
    let chainInfo: any;

    const CHAIN_GREP_SCHEME = "chaingrep";

    if (editor.document.uri.scheme === CHAIN_GREP_SCHEME) {
        const chainGrepMap = getChainGrepMap();
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

    let finalLabel = label;
    if (label) {
        const sourceBookmarks = existingBookmarks.filter(
            (b) =>
                b.sourceUri === sourceUri &&
                b.docUri === "" &&
                (b.label === label || (b.label && b.label.startsWith(label + " (")))
        );

        if (sourceBookmarks.length > 0) {
            const regex = new RegExp(`^${label} \\((\\d+)\\)$`);
            const existingNumbers = sourceBookmarks
                .map((b) => {
                    if (!b.label) {
                        return 0;
                    }
                    const match = b.label.match(regex);
                    return match ? parseInt(match[1], 10) : 0;
                })
                .filter((num) => !isNaN(num));

            let nextNumber = 1;
            if (existingNumbers.length > 0) {
                const maxNumber = Math.max(...existingNumbers);
                nextNumber = maxNumber + 1;
            }

            finalLabel = `${label} (${nextNumber})`;
        }
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
        label: finalLabel || undefined,
        timestamp: Date.now(),
        context: {
            beforeLines: context.beforeLines,
            afterLines: context.afterLines,
            relativePosition,
            occurrenceIndex: context.occurrenceIndex,
        },
    };

    bookmarkProvider.addBookmark(bookmark);

    try {
        if (editor.document.uri.scheme !== CHAIN_GREP_SCHEME) {
            await bookmarkProvider.synchronizeBookmarkToAllChainDocs(bookmark);
            await synchronizeBookmarksToAllExistingDocuments(sourceUri, bookmarkProvider);
            const updatedSourceBookmark = bookmarkProvider.getAllBookmarks().find((b) => b.id === bookmarkId);
            if (updatedSourceBookmark && updatedSourceBookmark.docUri !== "") {
                updatedSourceBookmark.docUri = "";
                bookmarkProvider.addBookmark(updatedSourceBookmark);
            }
        } else {
            await bookmarkProvider.synchronizeBookmarkToAllChainDocs(bookmark);

            if (bookmark.linkedBookmarkId) {
                const sourceBookmark = bookmarkProvider
                    .getAllBookmarks()
                    .find((b) => b.id === bookmark.linkedBookmarkId);

                if (sourceBookmark) {
                    await bookmarkProvider.synchronizeBookmarkToAllChainDocs(sourceBookmark);
                    await synchronizeBookmarksToAllExistingDocuments(sourceUri, bookmarkProvider);
                }
            } else {
                const potentialSourceBookmarks = bookmarkProvider.findBookmarks({
                    sourceUri: sourceUri,
                    docUri: null,
                    lineText: bookmark.lineText,
                });

                if (potentialSourceBookmarks.length > 0) {
                    const sourceBookmark = potentialSourceBookmarks[0];
                    bookmark.linkedBookmarkId = sourceBookmark.id;
                    bookmarkProvider.addBookmark(bookmark);

                    if (sourceBookmark.linkedBookmarkId !== bookmark.id) {
                        sourceBookmark.linkedBookmarkId = bookmark.id;
                        bookmarkProvider.addBookmark(sourceBookmark);
                    }

                    await bookmarkProvider.synchronizeBookmarkToAllChainDocs(sourceBookmark);
                } else {
                    console.log("ChainGrep: Creating new source bookmark for Chain Grep bookmark");

                    try {
                        const sourceDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));
                        const matchingLineNumber = await bookmarkProvider.findBestMatchingLine(bookmark, sourceUri);

                        if (matchingLineNumber !== undefined && matchingLineNumber >= 0) {
                            const sourceLineText = sourceDoc.lineAt(matchingLineNumber).text.trim();
                            const sourceContext = bookmarkProvider.getLineContext(sourceDoc, matchingLineNumber, 5);
                            const sourceRelativePosition = matchingLineNumber / (sourceDoc.lineCount || 1);

                            const sourceBookmarkId = `bookmark_${Date.now()}_${Math.random()
                                .toString(36)
                                .substring(2, 15)}`;
                            const sourceBookmark: Bookmark = {
                                id: sourceBookmarkId,
                                lineNumber: matchingLineNumber,
                                lineText: sourceLineText,
                                docUri: "",
                                sourceUri,
                                label: bookmark.label,
                                timestamp: Date.now(),
                                linkedBookmarkId: bookmark.id,
                                context: {
                                    beforeLines: sourceContext.beforeLines,
                                    afterLines: sourceContext.afterLines,
                                    relativePosition: sourceRelativePosition,
                                    occurrenceIndex: sourceContext.occurrenceIndex,
                                },
                            };

                            bookmarkProvider.addBookmark(sourceBookmark);

                            bookmark.linkedBookmarkId = sourceBookmarkId;
                            bookmarkProvider.addBookmark(bookmark);

                            await bookmarkProvider.synchronizeBookmarkToAllChainDocs(sourceBookmark);
                        }
                    } catch (error) {
                        console.error("Error creating source bookmark:", error);
                    }
                }
            }
        }
    } catch (error) {
        console.error("Error during bookmark synchronization:", error);
    }

    bookmarkProvider.refresh();

    setTimeout(() => {
        bookmarkProvider.reapplyAllBookmarkDecorations();
    }, 300);

    vscode.window.showInformationMessage("Bookmark added and synchronized.");
}

export function clearCurrentDocumentBookmarks(bookmarkProvider: BookmarkProvider): void {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        vscode.window.showInformationMessage("No active editor.");
        return;
    }

    const activeDocUri = activeEditor.document.uri.toString();

    if (activeDocUri.startsWith("chaingrep:")) {
        bookmarkProvider.clearBookmarksFromDocument(activeDocUri);
        vscode.window.showInformationMessage("Cleared bookmarks from current Chain Grep document.");
    } else {
        bookmarkProvider.clearBookmarksFromFile(activeDocUri);
        vscode.window.showInformationMessage(
            "Cleared all bookmarks from current file and related Chain Grep documents."
        );
    }
}

export async function synchronizeBookmarksToAllExistingDocuments(
    sourceUri: string,
    bookmarkProvider: BookmarkProvider
): Promise<void> {
    const chainGrepMap = getChainGrepMap();
    const chainDocsForSource = Array.from(chainGrepMap.entries())
        .filter(([, info]) => info.sourceUri.toString() === sourceUri)
        .map(([docUri]) => docUri);

    if (chainDocsForSource.length === 0) {
        return;
    }

    const sourceBookmarks = bookmarkProvider.findBookmarks({
        sourceUri: sourceUri,
        docUri: null,
    });

    try {
        const sourceDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));

        for (const sourceBookmark of sourceBookmarks) {
            if (sourceBookmark.lineNumber < sourceDoc.lineCount) {
                const currentText = sourceDoc.lineAt(sourceBookmark.lineNumber).text.trim();

                if (sourceBookmark.lineText !== currentText) {
                    sourceBookmark.lineText = currentText;

                    const newContext = bookmarkProvider.getLineContext(sourceDoc, sourceBookmark.lineNumber, 5);
                    if (sourceBookmark.context) {
                        sourceBookmark.context.beforeLines = newContext.beforeLines;
                        sourceBookmark.context.afterLines = newContext.afterLines;
                        sourceBookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                    }

                    bookmarkProvider.addBookmark(sourceBookmark);
                }
            }
        }
    } catch (error) {
        console.error(`Error updating source bookmarks before synchronization:`, error);
    }

    for (const chainDocUri of chainDocsForSource) {
        const chainInfo = chainGrepMap.get(chainDocUri);
        if (!chainInfo) {
            continue;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(chainDocUri));

            const existingChainBookmarks = bookmarkProvider.findBookmarks({
                docUri: chainDocUri,
            });

            for (const sourceBookmark of sourceBookmarks) {
                const linkedBookmark = existingChainBookmarks.find(
                    (b) =>
                        b.linkedBookmarkId === sourceBookmark.id ||
                        (b.sourceUri === sourceBookmark.sourceUri &&
                            b.lineText === sourceBookmark.lineText &&
                            b.context?.occurrenceIndex === sourceBookmark.context?.occurrenceIndex)
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

                    if (linkedBookmark.lineText !== sourceBookmark.lineText) {
                        linkedBookmark.lineText = sourceBookmark.lineText;

                        if (linkedBookmark.context && sourceBookmark.context) {
                            linkedBookmark.context.beforeLines = sourceBookmark.context.beforeLines;
                            linkedBookmark.context.afterLines = sourceBookmark.context.afterLines;
                        }

                        bookmarkProvider.addBookmark(linkedBookmark);
                    }

                    continue;
                }

                const matchingLine = await bookmarkProvider.findBestMatchingLine(sourceBookmark, chainDocUri);

                if (matchingLine !== undefined && matchingLine !== -1) {
                    const existingBookmarkAtLine = bookmarkProvider.findBookmarks({
                        docUri: chainDocUri,
                        lineNumber: matchingLine,
                        occurrenceIndex: sourceBookmark.context?.occurrenceIndex,
                    })[0];

                    if (existingBookmarkAtLine) {
                        existingBookmarkAtLine.linkedBookmarkId = sourceBookmark.id;
                        existingBookmarkAtLine.lineText = sourceBookmark.lineText;

                        const updatedSourceBookmark = {
                            ...sourceBookmark,
                            linkedBookmarkId: existingBookmarkAtLine.id,
                        };

                        bookmarkProvider.addBookmark(existingBookmarkAtLine);
                        bookmarkProvider.addBookmark(updatedSourceBookmark);
                        continue;
                    }

                    const context = bookmarkProvider.getLineContext(document, matchingLine, 5);
                    const relativePosition = matchingLine / (document.lineCount || 1);

                    const newBookmarkId = `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

                    const newBookmark: Bookmark = {
                        id: newBookmarkId,
                        lineNumber: matchingLine,
                        lineText: sourceBookmark.lineText,
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

export function removeFileBookmarks(node: BookmarkNode, bookmarkProvider: BookmarkProvider): void {
    if (node.type !== BookmarkNodeType.FileRoot) {
        vscode.window.showInformationMessage("This operation is only valid for file nodes.");
        return;
    }
    bookmarkProvider.removeBookmarksForSourceFile(node.bookmark.sourceUri);
    vscode.window.showInformationMessage("All bookmarks in file removed.");
}
