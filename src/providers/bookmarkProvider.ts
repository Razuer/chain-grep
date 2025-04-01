import * as vscode from "vscode";
import * as path from "path";
import { Bookmark, BookmarkCache } from "../models/interfaces";
import { BookmarkNode, BookmarkNodeType } from "../models/bookmarkNode";
import {
    getBookmarkColor,
    areBookmarkSymbolsEnabled,
    areBookmarkLabelsEnabled,
    isStateSavingInProjectEnabled,
    isDetailedChainDocEnabled,
} from "../services/configService";
import { getChainGrepMap, getChainGrepContents } from "../services/stateService";
import { ChainGrepDataProvider } from "./chainGrepDataProvider";
import { saveBookmarksToWorkspace, savePersistentState } from "../services/stateService";
import { executeChainSearch, buildChainDetailedHeader } from "../services/searchService";

export class BookmarkProvider implements vscode.TreeDataProvider<BookmarkNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<BookmarkNode | undefined | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<BookmarkNode | undefined | void> = this._onDidChangeTreeData.event;

    private bookmarks: Map<string, Bookmark> = new Map();
    private sourceUriToBookmarks: Map<string, string[]> = new Map();

    private docLineToBookmarks: Map<string, Map<number, string[]>> = new Map();
    private sourceLineToBookmarks: Map<string, Map<number, string[]>> = new Map();

    private bookmarkCache: BookmarkCache = {
        fileLineCache: new Map(),
        contentHashCache: new Map(),
        documentTimestamps: new Map(),
    };

    private getChainInfo: (docUri: string) => any;
    private bookmarkDecorationType: vscode.TextEditorDecorationType;
    private labelDecorationType: vscode.TextEditorDecorationType;

    private chainGrepProvider: ChainGrepDataProvider | undefined;
    private chainGrepTreeView: vscode.TreeView<any> | undefined;
    private bookmarkTreeView: vscode.TreeView<any> | undefined;

    private lastUpdateTimestamp: number = 0;
    private updateThrottleTime: number = 100;
    private pendingRefresh: boolean = false;

    private bookmarkUpdateDebounceTimer: NodeJS.Timeout | undefined;
    private bookmarkUpdatePending: Set<string> = new Set();

    private readonly BOOKMARKS_FILE_NAME = "chain-grep-bookmarks.json";

    constructor() {
        this.getChainInfo = () => undefined;

        this.bookmarkDecorationType = this.createBookmarkDecorationType();
        this.labelDecorationType = this.createLabelDecorationType();
    }

    setTreeView(treeView: vscode.TreeView<any>): void {
        this.bookmarkTreeView = treeView;
    }

    setChainGrepTree(provider: ChainGrepDataProvider, treeView: vscode.TreeView<any>): void {
        this.chainGrepProvider = provider;
        this.chainGrepTreeView = treeView;
    }

    revealNodeInTree(docUri: string): void {
        if (!this.chainGrepProvider || !this.chainGrepTreeView) {
            return;
        }

        try {
            if (docUri.startsWith("chaingrep:")) {
                const node = this.chainGrepProvider.docUriToNode.get(docUri);
                if (node) {
                    this.chainGrepTreeView.reveal(node, {
                        select: true,
                        focus: true,
                        expand: true,
                    });
                }
            } else {
                const rootNode = this.chainGrepProvider.findRootNodeBySourceUri(docUri);
                if (rootNode) {
                    this.chainGrepTreeView.reveal(rootNode, {
                        select: true,
                        focus: true,
                        expand: true,
                    });
                }
            }
        } catch (error) {
            console.error(`Error revealing node in Chain Grep tree: ${error}`);
        }
    }

    private createBookmarkDecorationType(): vscode.TextEditorDecorationType {
        const bookmarkColor = getBookmarkColor();
        const showSymbols = areBookmarkSymbolsEnabled();

        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: `${bookmarkColor}22`,
            borderWidth: "1px 0px 1px 0px",
            borderStyle: "solid",
            borderColor: bookmarkColor,
            before: showSymbols
                ? {
                      contentText: "❱",
                      color: bookmarkColor,
                      margin: "0 0.5em 0 0",
                      fontWeight: "bold",
                  }
                : undefined,
            after: showSymbols
                ? {
                      contentText: "❰",
                      color: bookmarkColor,
                      margin: "0 0 0 0.5em",
                      fontWeight: "bold",
                  }
                : undefined,
            overviewRulerColor: bookmarkColor,
            overviewRulerLane: vscode.OverviewRulerLane.Full,
        });
    }

    private createLabelDecorationType(): vscode.TextEditorDecorationType {
        const showLabels = areBookmarkLabelsEnabled();

        return vscode.window.createTextEditorDecorationType({
            after: showLabels
                ? {
                      color: new vscode.ThemeColor("editorGhostText.foreground"),
                      fontStyle: "italic",
                      margin: "0 0 0 1.2em",
                  }
                : undefined,
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BookmarkNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BookmarkNode): Thenable<BookmarkNode[]> {
        if (element?.type === BookmarkNodeType.BookmarkCategory && element.children) {
            return Promise.resolve(element.children);
        }

        if (element?.type === BookmarkNodeType.FileRoot && element.children) {
            return Promise.resolve(element.children);
        }

        if (!element) {
            const allBookmarks = Array.from(this.bookmarks.values());

            if (allBookmarks.length === 0) {
                return Promise.resolve([]);
            }

            const fileToBookmarksMap = new Map<string, Bookmark[]>();

            for (const bookmark of allBookmarks) {
                if (!fileToBookmarksMap.has(bookmark.sourceUri)) {
                    fileToBookmarksMap.set(bookmark.sourceUri, []);
                }
                fileToBookmarksMap.get(bookmark.sourceUri)!.push(bookmark);
            }

            const fileNodes: BookmarkNode[] = [];

            for (const [sourceUri, bookmarksInFile] of fileToBookmarksMap.entries()) {
                const sourceBookmarks = bookmarksInFile.filter((b) => b.sourceUri === sourceUri && b.docUri === "");

                if (sourceBookmarks.length === 0) {
                    continue;
                }

                const chainGrepBookmarks = bookmarksInFile.filter((b) => b.sourceUri === sourceUri && b.docUri !== "");
                const hasChainGrepBookmarks = chainGrepBookmarks.length > 0;

                if (!hasChainGrepBookmarks) {
                    try {
                        const fileUri = vscode.Uri.parse(sourceUri);
                        const fileName = path.basename(fileUri.fsPath);

                        const bookmarkNodes: BookmarkNode[] = [];

                        for (const bookmark of sourceBookmarks) {
                            const bookmarkNode = new BookmarkNode(
                                bookmark,
                                vscode.TreeItemCollapsibleState.None,
                                BookmarkNodeType.StandaloneBookmark
                            );

                            bookmarkNodes.push(bookmarkNode);
                        }

                        bookmarkNodes.sort((a, b) => a.bookmark.lineNumber - b.bookmark.lineNumber);

                        if (bookmarkNodes.length > 0) {
                            const fileBookmark = {
                                ...bookmarkNodes[0].bookmark,
                                lineText: fileName,
                                label: undefined,
                            };

                            const fileNode = new BookmarkNode(
                                fileBookmark,
                                vscode.TreeItemCollapsibleState.Expanded,
                                BookmarkNodeType.FileRoot,
                                bookmarkNodes
                            );

                            fileNodes.push(fileNode);
                        }
                    } catch (e) {
                        console.error("Error creating file node:", e);
                    }
                } else {
                    const bookmarksByLabel = new Map<string, Bookmark[]>();

                    for (const bookmark of sourceBookmarks) {
                        const key = bookmark.label || bookmark.lineText;
                        if (!bookmarksByLabel.has(key)) {
                            bookmarksByLabel.set(key, []);
                        }
                        bookmarksByLabel.get(key)!.push(bookmark);
                    }

                    for (const bookmark of bookmarksInFile) {
                        if (bookmark.docUri && bookmark.linkedBookmarkId) {
                            const sourceBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                            if (sourceBookmark) {
                                const key = sourceBookmark.label || sourceBookmark.lineText;
                                if (bookmarksByLabel.has(key)) {
                                    bookmarksByLabel.get(key)!.push(bookmark);
                                }
                            }
                        }
                    }

                    const categoryNodes: BookmarkNode[] = [];

                    for (const [label, bookmarksForCategory] of bookmarksByLabel.entries()) {
                        const sourceBookmarksForCategory = bookmarksForCategory.filter((b) => b.docUri === "");
                        if (sourceBookmarksForCategory.length === 0) {
                            continue;
                        }

                        const mainBookmark = sourceBookmarksForCategory[0];

                        const locationNodes: BookmarkNode[] = [];

                        for (const sourceBookmark of sourceBookmarksForCategory) {
                            const sourceFileNode = new BookmarkNode(
                                { ...sourceBookmark },
                                vscode.TreeItemCollapsibleState.None,
                                BookmarkNodeType.SourceReference
                            );

                            locationNodes.push(sourceFileNode);
                        }

                        const chainBookmarks = bookmarksForCategory.filter((b) => b.docUri !== "");
                        for (const chainBookmark of chainBookmarks) {
                            const chainNode = new BookmarkNode(
                                chainBookmark,
                                vscode.TreeItemCollapsibleState.None,
                                BookmarkNodeType.ChainGrepLink
                            );

                            locationNodes.push(chainNode);
                        }

                        locationNodes.sort((a, b) => {
                            if (
                                a.type === BookmarkNodeType.SourceReference &&
                                b.type !== BookmarkNodeType.SourceReference
                            ) {
                                return -1;
                            }
                            if (
                                a.type !== BookmarkNodeType.SourceReference &&
                                b.type === BookmarkNodeType.SourceReference
                            ) {
                                return 1;
                            }
                            return 0;
                        });

                        if (locationNodes.length > 0) {
                            const categoryNode = new BookmarkNode(
                                mainBookmark,
                                vscode.TreeItemCollapsibleState.Collapsed,
                                BookmarkNodeType.BookmarkCategory,
                                locationNodes
                            );

                            categoryNodes.push(categoryNode);
                        }
                    }

                    categoryNodes.sort((a, b) => a.bookmark.lineNumber - b.bookmark.lineNumber);

                    if (categoryNodes.length > 0) {
                        try {
                            const fileUri = vscode.Uri.parse(sourceUri);
                            const fileName = path.basename(fileUri.fsPath);

                            const fileBookmark = {
                                ...categoryNodes[0].bookmark,
                                lineText: fileName,
                                label: undefined,
                            };

                            const fileNode = new BookmarkNode(
                                fileBookmark,
                                vscode.TreeItemCollapsibleState.Expanded,
                                BookmarkNodeType.FileRoot,
                                categoryNodes
                            );

                            fileNodes.push(fileNode);
                        } catch (e) {
                            console.error("Error creating file node:", e);
                        }
                    }
                }
            }

            fileNodes.sort((a, b) => {
                try {
                    const aFileName = path.basename(vscode.Uri.parse(a.bookmark.sourceUri).fsPath);
                    const bFileName = path.basename(vscode.Uri.parse(b.bookmark.sourceUri).fsPath);
                    return aFileName.localeCompare(bFileName);
                } catch (e) {
                    return 0;
                }
            });

            return Promise.resolve(fileNodes);
        }

        return Promise.resolve([]);
    }

    addBookmark(bookmark: Bookmark): void {
        const existingBookmark = this.bookmarks.get(bookmark.id);
        if (existingBookmark) {
            this.removeFromIndices(existingBookmark);

            this.bookmarks.set(bookmark.id, {
                ...existingBookmark,
                ...bookmark,
                linkedBookmarkId: bookmark.linkedBookmarkId || existingBookmark.linkedBookmarkId,
            });
        } else {
            this.bookmarks.set(bookmark.id, bookmark);
        }

        this.addToIndices(bookmark);

        if (!this.sourceUriToBookmarks.has(bookmark.sourceUri)) {
            this.sourceUriToBookmarks.set(bookmark.sourceUri, []);
        }

        const bookmarkIds = this.sourceUriToBookmarks.get(bookmark.sourceUri)!;
        if (!bookmarkIds.includes(bookmark.id)) {
            bookmarkIds.push(bookmark.id);
        }

        this.addToCache(bookmark);

        this.throttledRefresh();
        this.reapplyAllBookmarkDecorations();
    }

    removeBookmark(bookmarkId: string): void {
        const bookmark = this.bookmarks.get(bookmarkId);
        if (bookmark) {
            this.removeFromIndices(bookmark);
            this.removeFromCache(bookmark);

            if (bookmark.linkedBookmarkId) {
                const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                if (linkedBookmark && linkedBookmark.linkedBookmarkId === bookmarkId) {
                    linkedBookmark.linkedBookmarkId = undefined;
                }
            }

            this.bookmarks.delete(bookmarkId);

            const bookmarkIds = this.sourceUriToBookmarks.get(bookmark.sourceUri);
            if (bookmarkIds) {
                const index = bookmarkIds.indexOf(bookmarkId);
                if (index >= 0) {
                    bookmarkIds.splice(index, 1);
                }
                if (bookmarkIds.length === 0) {
                    this.sourceUriToBookmarks.delete(bookmark.sourceUri);
                }
            }

            this.throttledRefresh();
            this.applyBookmarkDecorations();
        }
    }

    clearBookmarks(sourceUri: string): void {
        this.clearBookmarksBy({ sourceUri }, { refreshView: true, refreshDecorations: false });
        this.applyBookmarkDecorations();
    }

    clearBookmarksFromDocument(docUri: string): void {
        this.clearBookmarksBy({ docUri }, { refreshView: true, refreshDecorations: true });
    }

    clearBookmarksFromFile(sourceUri: string): void {
        this.clearBookmarksBy({ sourceUri }, { refreshView: true, refreshDecorations: true });
    }

    async clearAllBookmarks(): Promise<void> {
        this.bookmarks.clear();
        this.sourceUriToBookmarks.clear();
        this.docLineToBookmarks.clear();
        this.sourceLineToBookmarks.clear();

        this.clearCache();

        if (isStateSavingInProjectEnabled() && vscode.workspace.workspaceFolders?.length) {
            try {
                const workspaceFolder = vscode.workspace.workspaceFolders[0];
                const vscodeUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
                const bookmarksFileUri = vscode.Uri.joinPath(vscodeUri, this.BOOKMARKS_FILE_NAME);

                try {
                    await vscode.workspace.fs.stat(bookmarksFileUri);
                    await vscode.workspace.fs.writeFile(bookmarksFileUri, Buffer.from("[]", "utf-8"));
                    console.log("ChainGrep: Bookmarks file cleared in workspace");
                } catch (error) {
                    console.log("ChainGrep: No bookmarks file found in workspace");
                }
            } catch (error) {
                console.error("ChainGrep: Error clearing bookmarks file:", error);
            }
        }

        this.refresh();
        this.reapplyAllBookmarkDecorations();
    }

    getAllBookmarks(): Bookmark[] {
        return Array.from(this.bookmarks.values());
    }

    loadFromState(bookmarks: Bookmark[]): void {
        this.bookmarks.clear();
        this.sourceUriToBookmarks.clear();
        this.docLineToBookmarks.clear();
        this.sourceLineToBookmarks.clear();
        this.clearCache();

        for (const bookmark of bookmarks) {
            this.bookmarks.set(bookmark.id, bookmark);
            this.addToIndices(bookmark);
            this.addToCache(bookmark);

            if (!this.sourceUriToBookmarks.has(bookmark.sourceUri)) {
                this.sourceUriToBookmarks.set(bookmark.sourceUri, []);
            }
            this.sourceUriToBookmarks.get(bookmark.sourceUri)!.push(bookmark.id);
        }

        for (const bookmark of bookmarks) {
            if (bookmark.linkedBookmarkId && this.bookmarks.has(bookmark.linkedBookmarkId)) {
                const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId)!;

                if (!linkedBookmark.linkedBookmarkId || !this.bookmarks.has(linkedBookmark.linkedBookmarkId)) {
                    linkedBookmark.linkedBookmarkId = bookmark.id;
                }
            }
        }

        setTimeout(() => {
            this.reapplyAllBookmarkDecorations();
        }, 200);

        this.refresh();
    }

    setChainInfoGetter(getter: (docUri: string) => any): void {
        this.getChainInfo = getter;
    }

    public reapplyAllBookmarkDecorations(): void {
        for (const editor of vscode.window.visibleTextEditors) {
            this.applyBookmarkDecorationsToEditor(editor);
        }
    }

    applyBookmarkDecorations(): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }

        this.applyBookmarkDecorationsToEditor(editor);
    }

    private applyBookmarkDecorationsToEditor(editor: vscode.TextEditor): void {
        if (!editor || editor.document.isClosed) {
            return;
        }

        try {
            const docUri = editor.document.uri.toString();
            const bookmarkDecorations: vscode.DecorationOptions[] = [];
            const labelDecorations: vscode.DecorationOptions[] = [];
            const showLabels = areBookmarkLabelsEnabled();

            const addBookmarkDecoration = (bookmark: Bookmark, lineNumber: number) => {
                try {
                    if (lineNumber >= editor.document.lineCount) {
                        return;
                    }

                    const range = new vscode.Range(
                        lineNumber,
                        0,
                        lineNumber,
                        editor.document.lineAt(lineNumber).text.length
                    );

                    const hoverMessage = this.getBookmarkHoverMessage(bookmark);

                    const decoration: vscode.DecorationOptions = {
                        range,
                        hoverMessage,
                    };
                    bookmarkDecorations.push(decoration);

                    if (showLabels && bookmark.label) {
                        const labelDecoration: vscode.DecorationOptions = {
                            range,
                            renderOptions: {
                                after: {
                                    contentText: bookmark.label,
                                },
                            },
                        };
                        labelDecorations.push(labelDecoration);
                    }
                } catch (err) {
                    console.error(`Error creating decoration for bookmark at line ${lineNumber}:`, err);
                }
            };

            const decoratedLines = new Set<number>();

            const directBookmarks = this.getBookmarksForDocument(docUri);
            for (const bookmark of directBookmarks) {
                if (bookmark.lineNumber !== undefined) {
                    addBookmarkDecoration(bookmark, bookmark.lineNumber);
                    decoratedLines.add(bookmark.lineNumber);
                }
            }

            if (editor.document.uri.scheme !== "chaingrep") {
                const sourceBookmarks = this.getBookmarksForSourceURI(docUri);
                for (const bookmark of sourceBookmarks) {
                    if (
                        bookmark.docUri === "" &&
                        bookmark.lineNumber !== undefined &&
                        !decoratedLines.has(bookmark.lineNumber)
                    ) {
                        addBookmarkDecoration(bookmark, bookmark.lineNumber);
                        decoratedLines.add(bookmark.lineNumber);
                    }
                }
            } else if (typeof this.getChainInfo === "function") {
                const chainInfo = this._getChainInfo(docUri);
                if (chainInfo && chainInfo.sourceUri) {
                    const sourceUriStr = chainInfo.sourceUri.toString();
                    const sourceBookmarks = this.getBookmarksForSourceURI(sourceUriStr);

                    for (const bookmark of sourceBookmarks) {
                        if (bookmark.docUri === "" && bookmark.lineNumber !== undefined) {
                            const bestMatch = this.getCachedLineForBookmark(bookmark, docUri);
                            if (bestMatch !== undefined && !decoratedLines.has(bestMatch)) {
                                const existingChainBookmarks = this.getBookmarksAtLine(docUri, bestMatch);
                                const hasLinkedBookmark = existingChainBookmarks.some(
                                    (b) => b.linkedBookmarkId === bookmark.id || bookmark.linkedBookmarkId === b.id
                                );

                                if (!hasLinkedBookmark) {
                                    addBookmarkDecoration(bookmark, bestMatch);
                                    decoratedLines.add(bestMatch);
                                }
                            }
                        }
                    }
                }
            }

            editor.setDecorations(this.bookmarkDecorationType, bookmarkDecorations);
            editor.setDecorations(this.labelDecorationType, labelDecorations);
        } catch (error) {
            console.error("Error applying bookmark decorations:", error);
        }
    }

    private getBookmarkHoverMessage(bookmark: Bookmark): vscode.MarkdownString {
        const hoverMessage = new vscode.MarkdownString();

        if (bookmark.label) {
            hoverMessage.appendMarkdown(`**${bookmark.label}**\n\n`);
        }

        hoverMessage.appendMarkdown(`Line: ${bookmark.lineNumber + 1}\n\n`);
        hoverMessage.appendMarkdown(`${bookmark.lineText}`);

        try {
            const sourcePath = bookmark.sourceUri ? vscode.Uri.parse(bookmark.sourceUri).fsPath : "";
            const fileName = path.basename(sourcePath);
            hoverMessage.appendMarkdown(`\n\nFile: ${fileName}`);
        } catch {
            hoverMessage.appendMarkdown(`\n\nFile: ${bookmark.sourceUri}`);
        }

        if (bookmark.timestamp) {
            const date = new Date(bookmark.timestamp);
            hoverMessage.appendMarkdown(`\n\nCreated: ${date.toLocaleString()}`);
        }

        if (bookmark.context?.occurrenceIndex !== undefined) {
            hoverMessage.appendMarkdown(`\n\nOccurrence: ${bookmark.context.occurrenceIndex + 1}`);
        }

        return hoverMessage;
    }

    private addToIndices(bookmark: Bookmark): void {
        if (bookmark.docUri) {
            this.addBookmarkToIndex(this.docLineToBookmarks, bookmark.docUri, bookmark.lineNumber, bookmark.id);
        }

        if (!bookmark.docUri || bookmark.docUri === "") {
            this.addBookmarkToIndex(this.sourceLineToBookmarks, bookmark.sourceUri, bookmark.lineNumber, bookmark.id);
        }
    }

    private removeFromIndices(bookmark: Bookmark): void {
        if (bookmark.docUri) {
            this.removeBookmarkFromIndex(this.docLineToBookmarks, bookmark.docUri, bookmark.lineNumber, bookmark.id);
        }

        if (!bookmark.docUri || bookmark.docUri === "") {
            this.removeBookmarkFromIndex(
                this.sourceLineToBookmarks,
                bookmark.sourceUri,
                bookmark.lineNumber,
                bookmark.id
            );
        }
    }

    private addBookmarkToIndex(
        indexMap: Map<string, Map<number, string[]>>,
        uri: string,
        lineNumber: number,
        bookmarkId: string
    ): void {
        if (!indexMap.has(uri)) {
            indexMap.set(uri, new Map());
        }

        const lineMap = indexMap.get(uri)!;

        if (!lineMap.has(lineNumber)) {
            lineMap.set(lineNumber, []);
        }

        const bookmarksAtLine = lineMap.get(lineNumber)!;

        if (!bookmarksAtLine.includes(bookmarkId)) {
            bookmarksAtLine.push(bookmarkId);
        }
    }

    private removeBookmarkFromIndex(
        indexMap: Map<string, Map<number, string[]>>,
        uri: string,
        lineNumber: number,
        bookmarkId: string
    ): void {
        const lineMap = indexMap.get(uri);
        if (!lineMap) {
            return;
        }

        const bookmarksAtLine = lineMap.get(lineNumber);
        if (!bookmarksAtLine) {
            return;
        }

        const index = bookmarksAtLine.indexOf(bookmarkId);
        if (index >= 0) {
            bookmarksAtLine.splice(index, 1);
        }

        if (bookmarksAtLine.length === 0) {
            lineMap.delete(lineNumber);
        }

        if (lineMap.size === 0) {
            indexMap.delete(uri);
        }
    }

    hasBookmarkAtLine(docUri: string, lineNumber: number): boolean {
        const lineMap = this.docLineToBookmarks.get(docUri);
        if (!lineMap) {
            return false;
        }

        const bookmarksAtLine = lineMap.get(lineNumber);
        return !!bookmarksAtLine && bookmarksAtLine.length > 0;
    }

    hasSourceBookmarkAtLine(sourceUri: string, lineNumber: number): boolean {
        const lineMap = this.sourceLineToBookmarks.get(sourceUri);
        if (!lineMap) {
            return false;
        }

        const bookmarksAtLine = lineMap.get(lineNumber);
        return !!bookmarksAtLine && bookmarksAtLine.length > 0;
    }

    getBookmarksAtLine(docUri: string, lineNumber: number): Bookmark[] {
        const lineMap = this.docLineToBookmarks.get(docUri);
        if (!lineMap) {
            return [];
        }

        const bookmarkIds = lineMap.get(lineNumber);
        if (!bookmarkIds || bookmarkIds.length === 0) {
            return [];
        }

        return bookmarkIds.map((id) => this.bookmarks.get(id)).filter((b): b is Bookmark => !!b);
    }

    getSourceBookmarksAtLine(sourceUri: string, lineNumber: number): Bookmark[] {
        const lineMap = this.sourceLineToBookmarks.get(sourceUri);
        if (!lineMap) {
            return [];
        }

        const bookmarkIds = lineMap.get(lineNumber);
        if (!bookmarkIds || bookmarkIds.length === 0) {
            return [];
        }

        return bookmarkIds.map((id) => this.bookmarks.get(id)).filter((b): b is Bookmark => !!b);
    }

    async synchronizeBookmarks(docUri: string, document: vscode.TextDocument): Promise<void> {
        try {
            const chainInfo = this._getChainInfo(docUri);

            if (!chainInfo || Object.keys(chainInfo).length === 0) {
                console.log("ChainGrep: No chain info found for document, skipping bookmark synchronization:", docUri);
                return;
            }

            let sourceUri: string | undefined;

            if (chainInfo[docUri] && chainInfo[docUri].sourceUri) {
                sourceUri = chainInfo[docUri].sourceUri.toString();
            } else {
                for (const key in chainInfo) {
                    if (chainInfo[key] && chainInfo[key].sourceUri) {
                        sourceUri = chainInfo[key].sourceUri.toString();
                        break;
                    }
                }
            }

            if (!sourceUri) {
                console.error("ChainGrep: sourceUri is undefined in chainInfo for", docUri);
                return;
            }

            const currentTimestamp = document.version;
            const cachedTimestamp = this.bookmarkCache.documentTimestamps.get(docUri);

            if (cachedTimestamp && cachedTimestamp === currentTimestamp) {
                return;
            }

            this.bookmarkCache.documentTimestamps.set(docUri, currentTimestamp);

            const bookmarksToSync = Array.from(this.bookmarks.values()).filter(
                (b) => b.docUri === docUri || (b.sourceUri === sourceUri && b.docUri === "")
            );

            if (bookmarksToSync.length === 0) {
                return;
            }

            let changed = false;

            const sourceBookmarks = bookmarksToSync.filter((b) => b.sourceUri === sourceUri && b.docUri === "");

            try {
                const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));

                for (const sourceBookmark of sourceBookmarks) {
                    if (sourceBookmark.lineNumber < sourceDocument.lineCount) {
                        const newText = sourceDocument.lineAt(sourceBookmark.lineNumber).text.trim();
                        const newContentHash = this.calculateLineHash(newText);
                        const oldContentHash = this.bookmarkCache.contentHashCache.get(sourceBookmark.id);

                        if (!oldContentHash || oldContentHash !== newContentHash) {
                            sourceBookmark.lineText = newText;
                            this.bookmarkCache.contentHashCache.set(sourceBookmark.id, newContentHash);

                            if (sourceBookmark.context) {
                                const newContext = this.getLineContext(sourceDocument, sourceBookmark.lineNumber);
                                sourceBookmark.context.beforeLines = newContext.beforeLines;
                                sourceBookmark.context.afterLines = newContext.afterLines;
                                sourceBookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                                sourceBookmark.context.relativePosition = newContext.relativePosition;
                            }

                            changed = true;
                        }
                    }
                }
            } catch (error) {
                console.error("Chain Grep: Error synchronizing source bookmarks:", error);
            }

            for (const bookmark of bookmarksToSync) {
                try {
                    if (bookmark.docUri === docUri) {
                        if (bookmark.lineNumber < document.lineCount) {
                            if (bookmark.linkedBookmarkId) {
                                const sourceBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                                if (sourceBookmark) {
                                    if (bookmark.lineText !== sourceBookmark.lineText) {
                                        bookmark.lineText = sourceBookmark.lineText;
                                        this.bookmarkCache.contentHashCache.set(
                                            bookmark.id,
                                            this.calculateLineHash(sourceBookmark.lineText)
                                        );

                                        if (bookmark.context && sourceBookmark.context) {
                                            bookmark.context.beforeLines = sourceBookmark.context.beforeLines;
                                            bookmark.context.afterLines = sourceBookmark.context.afterLines;
                                        }

                                        changed = true;
                                    }
                                }
                            } else {
                                const matchingSourceBookmarks = sourceBookmarks.filter(
                                    (sb) => this.calculateTextSimilarity(sb.lineText, bookmark.lineText) > 0.7
                                );

                                if (matchingSourceBookmarks.length > 0) {
                                    const closestSourceBookmark = matchingSourceBookmarks[0];
                                    bookmark.linkedBookmarkId = closestSourceBookmark.id;
                                    closestSourceBookmark.linkedBookmarkId = bookmark.id;
                                    bookmark.lineText = closestSourceBookmark.lineText;

                                    this.bookmarkCache.contentHashCache.set(
                                        bookmark.id,
                                        this.calculateLineHash(closestSourceBookmark.lineText)
                                    );

                                    changed = true;
                                }
                            }
                        } else {
                            this.removeBookmark(bookmark.id);
                            changed = true;
                        }
                    }
                } catch (error) {
                    console.error("Chain Grep: Error synchronizing bookmark:", error);
                }
            }

            if (changed) {
                this.throttledRefresh();
                this.applyBookmarkDecorations();
            }
        } catch (error) {
            console.error("ChainGrep: Error in synchronizeBookmarks:", error);
        }
    }

    private async updateLinkedBookmark(sourceBookmark: Bookmark, linkedBookmark: Bookmark): Promise<void> {
        const linkedDocUri = linkedBookmark.docUri || linkedBookmark.sourceUri;
        try {
            const linkedDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(linkedDocUri));

            linkedBookmark.lineText = sourceBookmark.lineText;
            this.bookmarkCache.contentHashCache.set(linkedBookmark.id, this.calculateLineHash(sourceBookmark.lineText));

            if (!this.isCachedPositionValid(linkedBookmark)) {
                const matchingLineNumber = await this.findBestMatchingLine(sourceBookmark, linkedDocUri);

                if (
                    matchingLineNumber !== undefined &&
                    matchingLineNumber !== linkedBookmark.lineNumber &&
                    matchingLineNumber >= 0 &&
                    matchingLineNumber < linkedDoc.lineCount
                ) {
                    linkedBookmark.lineNumber = matchingLineNumber;
                    this.updateFileLinkCache(linkedBookmark);

                    if (linkedBookmark.context) {
                        const newContext = this.getLineContext(linkedDoc, matchingLineNumber);
                        linkedBookmark.context.beforeLines = newContext.beforeLines;
                        linkedBookmark.context.afterLines = newContext.afterLines;
                        linkedBookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                        linkedBookmark.context.relativePosition = matchingLineNumber / (linkedDoc.lineCount || 1);
                    }
                }
            }

            if (sourceBookmark.context && linkedBookmark.context) {
                linkedBookmark.context.beforeLines = sourceBookmark.context.beforeLines;
                linkedBookmark.context.afterLines = sourceBookmark.context.afterLines;
            }
        } catch (error) {
            console.error("Chain Grep: Error updating linked bookmark:", error);
        }
    }

    dispose(): void {
        this.bookmarkDecorationType.dispose();
        this.labelDecorationType.dispose();
    }

    updateDecorationStyle(): void {
        this.bookmarkDecorationType.dispose();
        this.labelDecorationType.dispose();

        this.bookmarkDecorationType = this.createBookmarkDecorationType();
        this.labelDecorationType = this.createLabelDecorationType();

        this.applyBookmarkDecorations();
    }

    async openBookmark(node?: BookmarkNode): Promise<void> {
        let bookmark: Bookmark | undefined;

        if (node) {
            bookmark = node.bookmark;
        } else {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                return;
            }

            const lineNumber = editor.selection.active.line;
            const docUri = editor.document.uri.toString();

            if (docUri.startsWith("chaingrep:")) {
                bookmark = this.getBookmarksAtLine(docUri, lineNumber)[0];
            } else {
                const sourceBookmarks = this.getSourceBookmarksAtLine(docUri, lineNumber);
                if (sourceBookmarks.length > 0) {
                    bookmark = sourceBookmarks[0];
                }
            }

            if (!bookmark) {
                vscode.window.showInformationMessage("No bookmark here");
                return;
            }
        }

        try {
            if (bookmark.docUri && bookmark.docUri.startsWith("chaingrep:")) {
                const chainGrepContents = getChainGrepContents();
                const chainGrepMap = getChainGrepMap();

                if (!chainGrepContents.has(bookmark.docUri)) {
                    const chainDoc = chainGrepMap.get(bookmark.docUri);
                    if (chainDoc) {
                        await vscode.window.withProgress(
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
                                chainGrepContents.set(bookmark.docUri!, content);
                                savePersistentState();
                            }
                        );
                    }
                }

                const chainGrepUri = vscode.Uri.parse(bookmark.docUri);
                const doc = await vscode.workspace.openTextDocument(chainGrepUri);
                const editor = await vscode.window.showTextDocument(doc, {
                    preview: false,
                });

                const position = new vscode.Position(bookmark.lineNumber, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

                if (this.chainGrepTreeView?.visible) {
                    this.revealNodeInTree(bookmark.docUri);
                }
            } else {
                const sourceUri = vscode.Uri.parse(bookmark.sourceUri);
                const doc = await vscode.workspace.openTextDocument(sourceUri);
                const editor = await vscode.window.showTextDocument(doc, {
                    preview: false,
                });

                const position = new vscode.Position(bookmark.lineNumber, 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);

                if (this.chainGrepTreeView?.visible) {
                    this.revealNodeInTree(bookmark.sourceUri);
                }
            }
        } catch (error) {
            console.error(`Error opening bookmark: ${error}`);
            vscode.window.showErrorMessage(`Failed to open bookmark: ${error}`);
        }
    }

    public calculateLineHash(line: string): string {
        let hash = 0;
        if (line.length === 0) {
            return hash.toString();
        }
        for (let i = 0; i < line.length; i++) {
            const char = line.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash;
        }
        return hash.toString();
    }

    public getLineContext(
        document: vscode.TextDocument,
        lineNumber: number,
        contextLines: number = 2
    ): {
        beforeLines: string[];
        afterLines: string[];
        occurrenceIndex: number;
        relativePosition: number;
    } {
        const beforeLines: string[] = [];
        const afterLines: string[] = [];

        const startLine = Math.max(0, lineNumber - contextLines);
        for (let i = startLine; i < lineNumber; i++) {
            beforeLines.push(document.lineAt(i).text.trim());
        }

        const endLine = Math.min(document.lineCount - 1, lineNumber + contextLines);
        for (let i = lineNumber + 1; i <= endLine; i++) {
            afterLines.push(document.lineAt(i).text.trim());
        }

        const lineText = document.lineAt(lineNumber).text.trim();
        const occurrenceIndex = this.getLineOccurrenceIndex(document, lineNumber, lineText);

        const relativePosition = lineNumber / (document.lineCount || 1);

        return { beforeLines, afterLines, occurrenceIndex, relativePosition };
    }

    private calculateContextSimilarity(
        sourceContext: Bookmark["context"],
        targetContext: {
            beforeLines: string[];
            afterLines: string[];
            occurrenceIndex: number;
            relativePosition: number;
        }
    ): number {
        if (!sourceContext || !sourceContext.beforeLines || !sourceContext.afterLines) {
            return 0;
        }

        let similarity = 0;

        if (
            sourceContext.occurrenceIndex !== undefined &&
            sourceContext.occurrenceIndex === targetContext.occurrenceIndex
        ) {
            similarity += 2.0;
        }

        const beforeSimilarity = this.calculateLinesSimilarity(sourceContext.beforeLines, targetContext.beforeLines);
        const afterSimilarity = this.calculateLinesSimilarity(sourceContext.afterLines, targetContext.afterLines);

        similarity += (beforeSimilarity + afterSimilarity * 1.5) / 2.5;

        return similarity;
    }

    public async findBestMatchingLine(bookmark: Bookmark, targetDocUri: string): Promise<number | undefined> {
        const cachedLine = this.getCachedLineForBookmark(bookmark, targetDocUri);
        if (cachedLine !== undefined) {
            return cachedLine;
        }

        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetDocUri));

            if (bookmark.lineText.trim().length < 3) {
                return undefined;
            }

            interface Match {
                lineNumber: number;
                score: number;
            }

            const lineOccurrenceCache = new Map<number, number>();

            const matchingLines: {
                lineNumber: number;
                occurrenceIndex: number;
            }[] = [];

            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i).text.trim();
                if (line === bookmark.lineText) {
                    const occurrenceIndex = this.getLineOccurrenceIndex(doc, i, line);
                    lineOccurrenceCache.set(i, occurrenceIndex);
                    matchingLines.push({ lineNumber: i, occurrenceIndex });
                }
            }

            if (bookmark.context?.occurrenceIndex !== undefined && matchingLines.length > 0) {
                const exactMatch = matchingLines.find((m) => m.occurrenceIndex === bookmark.context!.occurrenceIndex);

                if (exactMatch) {
                    return exactMatch.lineNumber;
                }

                matchingLines.sort((a, b) => {
                    const diffA = Math.abs(a.occurrenceIndex - bookmark.context!.occurrenceIndex!);
                    const diffB = Math.abs(b.occurrenceIndex - bookmark.context!.occurrenceIndex!);
                    return diffA - diffB;
                });

                return matchingLines[0].lineNumber;
            }

            const exactMatches: Match[] = [];
            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i).text.trim();
                if (line === bookmark.lineText) {
                    let score = 100;

                    if (bookmark.context) {
                        if (bookmark.context.occurrenceIndex !== undefined) {
                            let currentOccurrenceIndex: number;
                            if (lineOccurrenceCache.has(i)) {
                                currentOccurrenceIndex = lineOccurrenceCache.get(i)!;
                            } else {
                                currentOccurrenceIndex = this.getLineOccurrenceIndex(doc, i, bookmark.lineText);
                                lineOccurrenceCache.set(i, currentOccurrenceIndex);
                            }

                            if (bookmark.context.occurrenceIndex === currentOccurrenceIndex) {
                                score += 150;
                            } else {
                                const indexDiff = Math.abs(bookmark.context.occurrenceIndex - currentOccurrenceIndex);
                                score -= indexDiff * 20;
                            }
                        }

                        const targetContext = this.getLineContext(doc, i);
                        const contextSimilarity = this.calculateContextSimilarity(bookmark.context, targetContext);
                        score += contextSimilarity * 50;

                        if (bookmark.context.relativePosition !== undefined) {
                            const targetPosition = i / (doc.lineCount || 1);
                            const positionDiff = Math.abs(bookmark.context.relativePosition - targetPosition);
                            score -= positionDiff * 100;
                        }
                    }

                    exactMatches.push({ lineNumber: i, score });
                }
            }

            if (exactMatches.length > 0) {
                exactMatches.sort((a, b) => b.score - a.score);
                const bestMatch = exactMatches[0].lineNumber;

                const newBookmark = {
                    ...bookmark,
                    lineNumber: bestMatch,
                    docUri: targetDocUri,
                };
                this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(bookmark.lineText));
                this.updateFileLinkCache(newBookmark);

                return bestMatch;
            }

            const fuzzyMatches: Match[] = [];
            for (let i = 0; i < doc.lineCount; i++) {
                const line = doc.lineAt(i).text.trim();
                if (line.includes(bookmark.lineText) || bookmark.lineText.includes(line)) {
                    const similarity = this.calculateTextSimilarity(bookmark.lineText, line);
                    if (similarity > 0.7) {
                        let score = similarity * 100;

                        if (bookmark.context) {
                            const targetContext = this.getLineContext(doc, i);
                            const contextSimilarity = this.calculateContextSimilarity(bookmark.context, targetContext);
                            score += contextSimilarity * 40;

                            if (bookmark.context.relativePosition !== undefined) {
                                const targetPosition = i / (doc.lineCount || 1);
                                const positionDiff = Math.abs(bookmark.context.relativePosition - targetPosition);
                                score -= positionDiff * 50;
                            }
                        }

                        fuzzyMatches.push({ lineNumber: i, score });
                    }
                }
            }

            if (fuzzyMatches.length > 0) {
                fuzzyMatches.sort((a, b) => b.score - a.score);
                const bestMatch = fuzzyMatches[0].lineNumber;

                const newBookmark = {
                    ...bookmark,
                    lineNumber: bestMatch,
                    docUri: targetDocUri,
                };
                this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(newBookmark.lineText));
                this.updateFileLinkCache(newBookmark);

                return bestMatch;
            }

            return undefined;
        } catch (error) {
            console.error("Error finding best matching line:", error);
            return undefined;
        }
    }

    private calculateTextSimilarity(text1: string, text2: string): number {
        if (!text1 || !text2) {
            return 0;
        }

        if (text1 === text2) {
            return 1.0;
        }

        const words1 = text1
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 0);

        const words2 = text2
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 0);

        if (words1.length === 0 || words2.length === 0) {
            return 0;
        }

        const set1 = new Set(words1);
        const set2 = new Set(words2);

        let intersection = 0;
        for (const word of set1) {
            if (set2.has(word)) {
                intersection++;
            }
        }

        const union = set1.size + set2.size - intersection;
        const jaccard = intersection / union;

        let levSimilarity = 0;

        if (text1.length < 100 && text2.length < 100) {
            levSimilarity = this.calculateLevenshteinSimilarity(text1, text2);
        }

        return jaccard * 0.7 + levSimilarity * 0.3;
    }

    private calculateLevenshteinSimilarity(s1: string, s2: string): number {
        const m = s1.length;
        const n = s2.length;

        if (m === 0) {
            return 0;
        }
        if (n === 0) {
            return 0;
        }

        const d: number[][] = Array(m + 1)
            .fill(null)
            .map(() => Array(n + 1).fill(0));

        for (let i = 0; i <= m; i++) {
            d[i][0] = i;
        }
        for (let j = 0; j <= n; j++) {
            d[0][j] = j;
        }

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            }
        }

        const maxLen = Math.max(m, n);
        return 1 - d[m][n] / maxLen;
    }

    public async synchronizeBookmarkToAllChainDocs(bookmark: Bookmark): Promise<void> {
        this.logBookmarkDebug(`Synchronizing bookmark to all chain docs: ${bookmark.id}, text: "${bookmark.lineText}"`);

        if (bookmark.docUri && bookmark.docUri.startsWith("chaingrep:") && bookmark.linkedBookmarkId) {
            this.logBookmarkDebug(
                `This is a chain grep bookmark, getting source bookmark: ${bookmark.linkedBookmarkId}`
            );
            const sourceBookmarks = this.findBookmarks({
                id: bookmark.linkedBookmarkId,
            });

            if (sourceBookmarks.length > 0) {
                bookmark = sourceBookmarks[0];
                this.logBookmarkDebug(
                    `Using source bookmark for synchronization: ${bookmark.id}, text: "${bookmark.lineText}"`
                );
            }
        }

        const sourceUri = bookmark.sourceUri;
        if (!sourceUri) {
            this.logBookmarkDebug(`No source URI found for bookmark: ${bookmark.id}`);
            return;
        }

        const chainInfo = this._getChainInfo(sourceUri);
        if (!chainInfo) {
            this.logBookmarkDebug(`No chain info found for source: ${sourceUri}`);
            return;
        }

        const chainDocsForSource = Object.keys(chainInfo).filter((docUri) => docUri.startsWith("chaingrep:"));
        this.logBookmarkDebug(`Found ${chainDocsForSource.length} chain docs for source: ${sourceUri}`);

        if (chainDocsForSource.length === 0) {
            return;
        }

        for (const chainDocUri of chainDocsForSource) {
            try {
                const linkedBookmarks = this.findBookmarks({
                    docUri: chainDocUri,
                    linkedBookmarkId: bookmark.id,
                });

                this.logBookmarkDebug(`Found ${linkedBookmarks.length} linked bookmarks in ${chainDocUri}`);

                if (linkedBookmarks.length > 0) {
                    for (const linkedBookmark of linkedBookmarks) {
                        const oldText = linkedBookmark.lineText;
                        linkedBookmark.lineText = bookmark.lineText;

                        linkedBookmark.lastSavedText = bookmark.lineText;

                        this.logBookmarkDebug(
                            `Updating linked bookmark ${linkedBookmark.id} text from "${oldText}" to "${linkedBookmark.lineText}"`
                        );

                        this.bookmarks.set(linkedBookmark.id, linkedBookmark);
                    }
                } else {
                    this.logBookmarkDebug(`No linked bookmarks found, trying to create a new one in ${chainDocUri}`);

                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(chainDocUri));
                        const matchingLineNumber = await this.findBestMatchingLine(bookmark, chainDocUri);

                        if (
                            matchingLineNumber !== undefined &&
                            matchingLineNumber >= 0 &&
                            matchingLineNumber < doc.lineCount
                        ) {
                            this.logBookmarkDebug(`Found matching line at ${matchingLineNumber} in ${chainDocUri}`);

                            const context = this.getLineContext(doc, matchingLineNumber, 5);
                            const relativePosition = matchingLineNumber / (doc.lineCount || 1);

                            const chainBookmark: Bookmark = {
                                id: `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                                lineNumber: matchingLineNumber,
                                lineText: bookmark.lineText,
                                lastSavedText: bookmark.lineText,
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

                            this.logBookmarkDebug(
                                `Creating new linked bookmark in ${chainDocUri}: ${chainBookmark.id}`
                            );
                            this.addBookmark(chainBookmark);

                            if (!bookmark.linkedBookmarkId) {
                                bookmark.linkedBookmarkId = chainBookmark.id;
                                this.bookmarks.set(bookmark.id, bookmark);
                                this.logBookmarkDebug(
                                    `Updated source bookmark ${bookmark.id} with link to ${chainBookmark.id}`
                                );
                            }
                        } else {
                            this.logBookmarkDebug(`Could not find matching line in ${chainDocUri}`);
                        }
                    } catch (error) {
                        console.error(
                            `ChainGrep: Error creating a bookmark match in Chain Grep document ${chainDocUri}:`,
                            error
                        );
                    }
                }

                const editors = vscode.window.visibleTextEditors.filter(
                    (e) => e.document.uri.toString() === chainDocUri
                );

                if (editors.length > 0) {
                    this.logBookmarkDebug(`Applying decorations to ${editors.length} open editors for ${chainDocUri}`);
                    for (const editor of editors) {
                        this.applyBookmarkDecorationsToEditor(editor);
                    }
                }
            } catch (error) {
                console.error(`ChainGrep: Error synchronizing bookmark to ${chainDocUri}:`, error);
            }
        }

        this.refresh();
        this.reapplyAllBookmarkDecorations();
    }

    public async synchronizeBookmarksOnFileSave(sourceUri: string, document: vscode.TextDocument): Promise<void> {
        try {
            const sourceBookmarks = this.findBookmarks({
                sourceUri: sourceUri,
                docUri: null,
            });

            this.logBookmarkDebug(`Found ${sourceBookmarks.length} source bookmarks to synchronize for ${sourceUri}`);

            if (sourceBookmarks.length === 0) {
                return;
            }

            let changed = false;

            const syncPromises: Promise<void>[] = [];

            for (const bookmark of sourceBookmarks) {
                if (bookmark.lineNumber < document.lineCount) {
                    const currentText = document.lineAt(bookmark.lineNumber).text.trim();

                    if (bookmark.lineText !== currentText) {
                        this.logBookmarkDebug(
                            `Updating source bookmark text from "${bookmark.lineText}" to "${currentText}"`
                        );
                        bookmark.lineText = currentText;
                        this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(currentText));

                        const newContext = this.getLineContext(document, bookmark.lineNumber, 5);
                        if (bookmark.context) {
                            bookmark.context.beforeLines = newContext.beforeLines;
                            bookmark.context.afterLines = newContext.afterLines;
                            bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                            bookmark.context.relativePosition = bookmark.lineNumber / (document.lineCount || 1);
                        }

                        this.addBookmark(bookmark);
                        changed = true;
                    }

                    bookmark.lastSavedText = currentText;
                    this.bookmarks.set(bookmark.id, bookmark);

                    syncPromises.push(
                        this.synchronizeBookmarkToAllChainDocs(bookmark)
                            .then(() => {
                                this.logBookmarkDebug(
                                    `Successfully synchronized bookmark ${bookmark.id} to all chain docs`
                                );
                            })
                            .catch((error) => {
                                console.error(`Error synchronizing bookmark ${bookmark.id} after file save:`, error);
                            })
                    );
                }
            }

            if (syncPromises.length > 0) {
                await Promise.all(syncPromises);
                this.logBookmarkDebug(`Completed synchronization of ${syncPromises.length} bookmarks`);

                this.refresh();
                this.reapplyAllBookmarkDecorations();
            } else if (changed) {
                this.refresh();
                this.reapplyAllBookmarkDecorations();
            }
        } catch (error) {
            console.error(`ChainGrep: Error synchronizing bookmarks on file save:`, error);
        }
    }

    public async restoreBookmarksForDocument(sourceUri: string, document: vscode.TextDocument): Promise<void> {
        try {
            const sourceBookmarks = this.findBookmarks({
                sourceUri: sourceUri,
                docUri: null,
            });

            if (sourceBookmarks.length === 0) {
                return;
            }

            let changed = false;

            for (const bookmark of sourceBookmarks) {
                if (bookmark.lastSavedText && bookmark.lineNumber < document.lineCount) {
                    const currentText = document.lineAt(bookmark.lineNumber).text.trim();

                    if (currentText !== bookmark.lineText && currentText === bookmark.lastSavedText) {
                        bookmark.lineText = bookmark.lastSavedText;

                        const newContext = this.getLineContext(document, bookmark.lineNumber, 5);
                        if (bookmark.context) {
                            bookmark.context.beforeLines = newContext.beforeLines;
                            bookmark.context.afterLines = newContext.afterLines;
                            bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                        }

                        this.bookmarks.set(bookmark.id, bookmark);
                        this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(bookmark.lineText));
                        changed = true;

                        if (bookmark.linkedBookmarkId) {
                            const linkedBookmarks = Array.from(this.bookmarks.values()).filter(
                                (b) => b.linkedBookmarkId === bookmark.id
                            );

                            for (const linkedBookmark of linkedBookmarks) {
                                linkedBookmark.lineText = bookmark.lineText;
                                this.bookmarks.set(linkedBookmark.id, linkedBookmark);
                            }
                        }

                        this.logBookmarkDebug(
                            `Restored original text for bookmark ${bookmark.id} at line ${bookmark.lineNumber} in ${sourceUri}`
                        );
                    }
                }
            }

            if (changed) {
                this.refresh();
                this.reapplyAllBookmarkDecorations();
            }
        } catch (error) {
            console.error(`ChainGrep: Error restoring bookmarks for document: ${sourceUri}`, error);
        }
    }

    private _getChainInfo(docUri?: string): any {
        if (!docUri) {
            return null;
        }

        const chainGrepMap = getChainGrepMap();

        if (!docUri.startsWith("chaingrep:")) {
            this.logBookmarkDebug(`Getting chain info for source URI: ${docUri}`);
            const chainDocsForSource = Array.from(chainGrepMap.entries())
                .filter(([, info]) => {
                    if (!info.sourceUri) {
                        return false;
                    }
                    return info.sourceUri.toString() === docUri;
                })
                .reduce((acc, [chainDocUri, info]) => {
                    acc[chainDocUri] = info;
                    return acc;
                }, {} as Record<string, any>);

            this.logBookmarkDebug(`Found ${Object.keys(chainDocsForSource).length} chain docs for source: ${docUri}`);
            return chainDocsForSource;
        }

        if (chainGrepMap.has(docUri)) {
            const info = chainGrepMap.get(docUri);

            if (!info || !info.sourceUri) {
                this.logBookmarkDebug(`Chain info found for ${docUri} but sourceUri is undefined`);
                return null;
            }

            this.logBookmarkDebug(`Found chain info for grep URI: ${docUri}, source: ${info.sourceUri.toString()}`);

            const allChainsForSource = Array.from(chainGrepMap.entries())
                .filter(([, chainInfo]) => {
                    if (!chainInfo.sourceUri || !info.sourceUri) {
                        return false;
                    }
                    return chainInfo.sourceUri.toString() === info.sourceUri.toString();
                })
                .reduce((acc, [chainDocUri, chainInfo]) => {
                    acc[chainDocUri] = chainInfo;
                    return acc;
                }, {} as Record<string, any>);

            this.logBookmarkDebug(`Found ${Object.keys(allChainsForSource).length} related chain docs`);
            return allChainsForSource;
        }

        this.logBookmarkDebug(`No chain info found for URI: ${docUri}`);
        return null;
    }

    private getCachedLineForBookmark(bookmark: Bookmark, targetDocUri: string): number | undefined {
        for (const [cachedBookmarkId, cachedHash] of this.bookmarkCache.contentHashCache.entries()) {
            const cachedBookmark = this.bookmarks.get(cachedBookmarkId);
            if (
                cachedBookmark &&
                cachedBookmark.docUri === targetDocUri &&
                cachedBookmark.lineText === bookmark.lineText &&
                cachedBookmark.context?.occurrenceIndex === bookmark.context?.occurrenceIndex
            ) {
                return cachedBookmark.lineNumber;
            }
        }
        return undefined;
    }

    private updateFileLinkCache(bookmark: Bookmark): void {
        const uri = bookmark.docUri || bookmark.sourceUri;
        const lineMap = this.bookmarkCache.fileLineCache.get(uri);

        if (lineMap) {
            for (const [line, bookmarks] of lineMap.entries()) {
                const index = bookmarks.indexOf(bookmark.id);
                if (index >= 0) {
                    bookmarks.splice(index, 1);
                    if (bookmarks.length === 0) {
                        lineMap.delete(line);
                    }
                    break;
                }
            }
        }

        if (!this.bookmarkCache.fileLineCache.has(uri)) {
            this.bookmarkCache.fileLineCache.set(uri, new Map());
        }
        const newLineMap = this.bookmarkCache.fileLineCache.get(uri)!;
        if (!newLineMap.has(bookmark.lineNumber)) {
            newLineMap.set(bookmark.lineNumber, []);
        }
        newLineMap.get(bookmark.lineNumber)!.push(bookmark.id);
    }

    private isCachedPositionValid(bookmark: Bookmark): boolean {
        const cachedHash = this.bookmarkCache.contentHashCache.get(bookmark.id);
        if (!cachedHash) {
            return false;
        }

        const currentHash = this.calculateLineHash(bookmark.lineText);
        return cachedHash === currentHash;
    }

    private throttledRefresh(): void {
        const now = Date.now();
        if (now - this.lastUpdateTimestamp > this.updateThrottleTime) {
            this.refresh();
            this.lastUpdateTimestamp = now;
            this.pendingRefresh = false;
        } else if (!this.pendingRefresh) {
            this.pendingRefresh = true;
            setTimeout(() => {
                if (this.pendingRefresh) {
                    this.refresh();
                    this.lastUpdateTimestamp = Date.now();
                    this.pendingRefresh = false;
                }
            }, this.updateThrottleTime);
        }
    }

    public findBookmarks(criteria: {
        id?: string;
        sourceUri?: string;
        docUri?: string | null;
        lineNumber?: number;
        linkedBookmarkId?: string;
        occurrenceIndex?: number;
        lineText?: string;
    }): Bookmark[] {
        let candidates: Bookmark[] = [];

        if (criteria.id) {
            const bookmark = this.bookmarks.get(criteria.id);
            return bookmark ? [bookmark] : [];
        }

        if (criteria.lineNumber !== undefined && (criteria.docUri !== undefined || criteria.sourceUri)) {
            if (criteria.docUri !== undefined) {
                const docUri = criteria.docUri === null ? "" : criteria.docUri;
                const lineMap = docUri
                    ? this.docLineToBookmarks.get(docUri)
                    : criteria.sourceUri
                    ? this.sourceLineToBookmarks.get(criteria.sourceUri)
                    : undefined;

                if (lineMap) {
                    const bookmarkIds = lineMap.get(criteria.lineNumber);
                    if (bookmarkIds && bookmarkIds.length > 0) {
                        candidates = bookmarkIds.map((id) => this.bookmarks.get(id)).filter((b): b is Bookmark => !!b);
                    }
                }
            } else if (criteria.sourceUri) {
                const lineMap = this.sourceLineToBookmarks.get(criteria.sourceUri);
                if (lineMap) {
                    const bookmarkIds = lineMap.get(criteria.lineNumber);
                    if (bookmarkIds && bookmarkIds.length > 0) {
                        candidates = bookmarkIds.map((id) => this.bookmarks.get(id)).filter((b): b is Bookmark => !!b);
                    }
                }
            }
        } else if (criteria.sourceUri) {
            const bookmarkIds = this.sourceUriToBookmarks.get(criteria.sourceUri);
            if (bookmarkIds && bookmarkIds.length > 0) {
                candidates = bookmarkIds.map((id) => this.bookmarks.get(id)).filter((b): b is Bookmark => !!b);
            }
        } else {
            candidates = Array.from(this.bookmarks.values());
        }

        return candidates.filter((b) => {
            if (criteria.docUri !== undefined) {
                const targetDocUri = criteria.docUri === null ? "" : criteria.docUri;
                if (b.docUri !== targetDocUri) {
                    return false;
                }
            }

            if (criteria.sourceUri && b.sourceUri !== criteria.sourceUri) {
                return false;
            }

            if (criteria.lineNumber !== undefined && b.lineNumber !== criteria.lineNumber) {
                return false;
            }

            if (criteria.linkedBookmarkId && b.linkedBookmarkId !== criteria.linkedBookmarkId) {
                return false;
            }

            if (
                criteria.occurrenceIndex !== undefined &&
                (!b.context || b.context.occurrenceIndex !== criteria.occurrenceIndex)
            ) {
                return false;
            }

            if (criteria.lineText && b.lineText !== criteria.lineText) {
                return false;
            }

            return true;
        });
    }

    removeBookmarksForSourceFile(sourceUri: string): void {
        const allBookmarks = Array.from(this.bookmarks.values());
        const bookmarksToRemove = allBookmarks.filter((b) => b.sourceUri === sourceUri);

        for (const bookmark of bookmarksToRemove) {
            this.removeBookmark(bookmark.id);
        }

        this.refresh();
        this.reapplyAllBookmarkDecorations();
    }

    removeBookmarkWithRelated(rootBookmarkId: string): void {
        const rootBookmark = this.bookmarks.get(rootBookmarkId);
        if (!rootBookmark) {
            return;
        }

        const allBookmarks = Array.from(this.bookmarks.values());

        const relatedBookmarks = allBookmarks.filter(
            (b) =>
                b.linkedBookmarkId === rootBookmarkId ||
                (rootBookmark.linkedBookmarkId && b.id === rootBookmark.linkedBookmarkId) ||
                (b.sourceUri === rootBookmark.sourceUri &&
                    b.lineText === rootBookmark.lineText &&
                    b.context?.occurrenceIndex === rootBookmark.context?.occurrenceIndex)
        );

        for (const bookmark of relatedBookmarks) {
            this.removeBookmark(bookmark.id);
        }

        this.removeBookmark(rootBookmarkId);

        this.refresh();
        this.reapplyAllBookmarkDecorations();
    }

    clearBookmarksBy(
        criteria: {
            sourceUri?: string;
            docUri?: string;
        },
        options: {
            refreshView?: boolean;
            refreshDecorations?: boolean;
        } = { refreshView: true, refreshDecorations: true }
    ): void {
        const { sourceUri, docUri } = criteria;
        let bookmarksToRemove: Bookmark[] = [];

        if (sourceUri && docUri) {
            bookmarksToRemove = Array.from(this.bookmarks.values()).filter(
                (b) => b.sourceUri === sourceUri && b.docUri === docUri
            );
        } else if (sourceUri) {
            bookmarksToRemove = Array.from(this.bookmarks.values()).filter((b) => b.sourceUri === sourceUri);

            if (this.sourceUriToBookmarks.has(sourceUri)) {
                this.sourceUriToBookmarks.delete(sourceUri);
            }
        } else if (docUri) {
            bookmarksToRemove = Array.from(this.bookmarks.values()).filter((b) => b.docUri === docUri);
        }

        for (const bookmark of bookmarksToRemove) {
            this.removeFromIndices(bookmark);
            this.removeFromCache(bookmark);
            this.bookmarks.delete(bookmark.id);

            if (bookmark.linkedBookmarkId) {
                const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                if (linkedBookmark && linkedBookmark.linkedBookmarkId === bookmark.id) {
                    linkedBookmark.linkedBookmarkId = undefined;
                }
            }

            const bookmarkIds = this.sourceUriToBookmarks.get(bookmark.sourceUri);
            if (bookmarkIds) {
                const index = bookmarkIds.indexOf(bookmark.id);
                if (index >= 0) {
                    bookmarkIds.splice(index, 1);
                }
                if (bookmarkIds.length === 0) {
                    this.sourceUriToBookmarks.delete(bookmark.sourceUri);
                }
            }
        }

        if (bookmarksToRemove.length > 0) {
            if (options.refreshView) {
                this.refresh();
            }

            if (options.refreshDecorations) {
                this.reapplyAllBookmarkDecorations();
            }
        }
    }

    private getBookmarksForDocument(docUri: string): Bookmark[] {
        return Array.from(this.bookmarks.values()).filter(
            (b) => b.docUri === docUri || (b.sourceUri === docUri && b.docUri === "")
        );
    }

    private getBookmarksForSourceURI(sourceUri: string): Bookmark[] {
        if (!this.sourceUriToBookmarks.has(sourceUri)) {
            return [];
        }

        const bookmarkIds = this.sourceUriToBookmarks.get(sourceUri) || [];
        return bookmarkIds.map((id) => this.bookmarks.get(id)).filter((b): b is Bookmark => !!b);
    }

    async updateBookmarkPositionsForDocument(
        document: vscode.TextDocument,
        contentChanges?: readonly vscode.TextDocumentContentChangeEvent[]
    ): Promise<boolean> {
        const documentUri = document.uri.toString();

        this.bookmarkUpdatePending.add(documentUri);

        if (this.bookmarkUpdateDebounceTimer) {
            clearTimeout(this.bookmarkUpdateDebounceTimer);
        }

        return new Promise((resolve) => {
            this.bookmarkUpdateDebounceTimer = setTimeout(async () => {
                const results = [];

                for (const uri of this.bookmarkUpdatePending) {
                    try {
                        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
                        results.push(await this.doUpdateBookmarksForDocument(doc, contentChanges));
                    } catch (error) {
                        console.error(`Error updating bookmarks for ${uri}:`, error);
                    }
                }

                this.bookmarkUpdatePending.clear();
                this.bookmarkUpdateDebounceTimer = undefined;

                resolve(results.some((r) => r));
            }, 250);
        });
    }

    private async doUpdateBookmarksForDocument(
        document: vscode.TextDocument,
        contentChanges?: readonly vscode.TextDocumentContentChangeEvent[]
    ): Promise<boolean> {
        const documentUri = document.uri.toString();
        const isSourceDocument = !documentUri.startsWith("chaingrep:");

        const sourceBookmarks = this.findBookmarks({
            sourceUri: documentUri,
            docUri: null,
        });

        if (sourceBookmarks.length === 0) {
            return false;
        }

        let changed = false;

        let affectedLines = new Set<number>();
        let lineOffsets: Array<{ line: number; delta: number }> = [];

        if (contentChanges && contentChanges.length > 0) {
            let currentOffset = 0;

            const sortedChanges = [...contentChanges].sort((a, b) => b.range.start.line - a.range.start.line);

            for (const change of sortedChanges) {
                const startLine = change.range.start.line;
                const endLine = change.range.end.line;
                const addedLines = change.text.split("\n").length - 1;
                const removedLines = endLine - startLine;
                const lineDelta = addedLines - removedLines;

                for (let i = startLine; i <= endLine; i++) {
                    affectedLines.add(i);
                }

                if (lineDelta !== 0) {
                    currentOffset += lineDelta;
                    lineOffsets.push({ line: startLine, delta: lineDelta });
                }
            }

            if (
                isSourceDocument &&
                contentChanges.length === 1 &&
                contentChanges[0].range.start.line === contentChanges[0].range.end.line &&
                !contentChanges[0].text.includes("\n")
            ) {
                const affectedLine = contentChanges[0].range.start.line;
                const bookmark = sourceBookmarks.find((b) => b.lineNumber === affectedLine);

                if (bookmark) {
                    const newText = document.lineAt(affectedLine).text.trim();
                    const newContentHash = this.calculateLineHash(newText);
                    const oldContentHash = this.bookmarkCache.contentHashCache.get(bookmark.id);

                    const similarity = this.calculateTextSimilarity(bookmark.lineText, newText);
                    if (similarity >= 0.6) {
                        if (!bookmark.lastSavedText) {
                            bookmark.lastSavedText = newText;
                        }

                        bookmark.lineText = newText;
                        this.bookmarkCache.contentHashCache.set(bookmark.id, newContentHash);

                        if (bookmark.context) {
                            const newContext = this.getLineContext(document, affectedLine);
                            bookmark.context.beforeLines = newContext.beforeLines;
                            bookmark.context.afterLines = newContext.afterLines;
                            bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                        }

                        changed = true;
                    }
                }
            }
        }

        const lineTextMap = new Map<string, number[]>();
        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i).text.trim();
            if (line.length > 0) {
                if (!lineTextMap.has(line)) {
                    lineTextMap.set(line, []);
                }
                lineTextMap.get(line)!.push(i);
            }
        }

        const foundLineCache = new Map<string, number>();

        for (const bookmark of sourceBookmarks) {
            try {
                if (contentChanges && contentChanges.length > 0) {
                    const wasAffected = affectedLines.has(bookmark.lineNumber);
                    if (!wasAffected && bookmark.lineNumber < document.lineCount) {
                        const currentText = document.lineAt(bookmark.lineNumber).text.trim();
                        if (currentText === bookmark.lineText) {
                            continue;
                        }
                    }
                }

                let matchingLineNumber: number | undefined;
                const cacheKey = bookmark.lineText;

                if (foundLineCache.has(cacheKey)) {
                    matchingLineNumber = foundLineCache.get(cacheKey);
                } else {
                    const matchingLines = lineTextMap.get(bookmark.lineText) || [];

                    if (matchingLines.length === 1) {
                        matchingLineNumber = matchingLines[0];
                    } else if (matchingLines.length > 1) {
                        if (bookmark.context?.occurrenceIndex !== undefined) {
                            const targetIndex = bookmark.context.occurrenceIndex;
                            if (matchingLines.length > targetIndex) {
                                matchingLineNumber = matchingLines[targetIndex];
                            } else {
                                matchingLines.sort((a, b) => {
                                    const distA = Math.abs(a - bookmark.lineNumber);
                                    const distB = Math.abs(b - bookmark.lineNumber);
                                    return distA - distB;
                                });
                                matchingLineNumber = matchingLines[0];
                            }
                        } else {
                            matchingLines.sort((a, b) => {
                                const distA = Math.abs(a - bookmark.lineNumber);
                                const distB = Math.abs(b - bookmark.lineNumber);
                                return distA - distB;
                            });
                            matchingLineNumber = matchingLines[0];
                        }
                    }

                    if (matchingLineNumber !== undefined) {
                        foundLineCache.set(cacheKey, matchingLineNumber);
                    }
                }

                if (matchingLineNumber === undefined) {
                    continue;
                }

                if (
                    matchingLineNumber !== bookmark.lineNumber &&
                    matchingLineNumber >= 0 &&
                    matchingLineNumber < document.lineCount
                ) {
                    this.removeFromIndices(bookmark);

                    const oldLineNumber = bookmark.lineNumber;
                    bookmark.lineNumber = matchingLineNumber;

                    this.addToIndices(bookmark);
                    this.updateFileLinkCache(bookmark);

                    if (isSourceDocument) {
                        const newText = document.lineAt(matchingLineNumber).text.trim();

                        if (!bookmark.lastSavedText) {
                            bookmark.lastSavedText = newText;
                        }

                        bookmark.lineText = newText;
                        this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(newText));

                        if (bookmark.context) {
                            const newContext = this.getLineContext(document, matchingLineNumber);
                            bookmark.context.beforeLines = newContext.beforeLines;
                            bookmark.context.afterLines = newContext.afterLines;
                            bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                            bookmark.context.relativePosition = matchingLineNumber / (document.lineCount || 1);
                        }
                    } else {
                        if (bookmark.context) {
                            bookmark.context.relativePosition = matchingLineNumber / (document.lineCount || 1);
                        }
                    }

                    changed = true;

                    setTimeout(() => {
                        if (bookmark.linkedBookmarkId) {
                            const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                            if (linkedBookmark) {
                                this.updateLinkedBookmarkPosition(bookmark, linkedBookmark)
                                    .then(() => {
                                        this.refresh();
                                        this.reapplyAllBookmarkDecorations();
                                    })
                                    .catch((error) => {
                                        console.error("Error updating linked bookmark position:", error);
                                    });
                            }
                        }
                    }, 0);
                }
            } catch (error) {
                console.error("Error updating bookmark position (exact match):", error);
            }
        }

        const bookmarksNeedingFuzzyMatch = sourceBookmarks.filter((bookmark) => {
            const exactMatches = lineTextMap.get(bookmark.lineText) || [];
            return exactMatches.length === 0;
        });

        if (bookmarksNeedingFuzzyMatch.length > 0) {
            for (const bookmark of bookmarksNeedingFuzzyMatch) {
                try {
                    if (isSourceDocument && bookmark.lineNumber < document.lineCount) {
                        const currentLineText = document.lineAt(bookmark.lineNumber).text.trim();
                        const similarity = this.calculateTextSimilarity(bookmark.lineText, currentLineText);

                        if (similarity >= 0.7) {
                            bookmark.lineText = currentLineText;
                            this.bookmarkCache.contentHashCache.set(
                                bookmark.id,
                                this.calculateLineHash(currentLineText)
                            );

                            if (bookmark.context) {
                                const newContext = this.getLineContext(document, bookmark.lineNumber);
                                bookmark.context.beforeLines = newContext.beforeLines;
                                bookmark.context.afterLines = newContext.afterLines;
                                bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                                bookmark.context.relativePosition = newContext.relativePosition;
                            }

                            changed = true;
                            continue;
                        }
                    }

                    const fuzzyMatches: {
                        lineNumber: number;
                        similarity: number;
                    }[] = [];

                    const isLargeDocument = document.lineCount > 1000;
                    const searchStart = isLargeDocument ? Math.max(0, bookmark.lineNumber - 100) : 0;
                    const searchEnd = isLargeDocument
                        ? Math.min(document.lineCount - 1, bookmark.lineNumber + 100)
                        : document.lineCount - 1;

                    for (let i = searchStart; i <= searchEnd; i++) {
                        const line = document.lineAt(i).text.trim();
                        if (line.length > 0) {
                            const containsCommonKeywords = this.hasCommonKeywords(bookmark.lineText, line);

                            if (containsCommonKeywords) {
                                const similarity = this.calculateTextSimilarity(bookmark.lineText, line);
                                if (similarity >= 0.6) {
                                    const proximityBonus =
                                        1 - (Math.abs(i - bookmark.lineNumber) / (document.lineCount || 1)) * 0.2;
                                    const adjustedSimilarity = similarity * proximityBonus;

                                    fuzzyMatches.push({
                                        lineNumber: i,
                                        similarity: adjustedSimilarity,
                                    });
                                }
                            }
                        }
                    }

                    if (fuzzyMatches.length > 0) {
                        fuzzyMatches.sort((a, b) => b.similarity - a.similarity);
                        const bestMatch = fuzzyMatches[0];

                        if (bestMatch.lineNumber !== bookmark.lineNumber) {
                            this.removeFromIndices(bookmark);
                            bookmark.lineNumber = bestMatch.lineNumber;

                            if (isSourceDocument) {
                                const newText = document.lineAt(bestMatch.lineNumber).text.trim();

                                if (!bookmark.lastSavedText) {
                                    bookmark.lastSavedText = newText;
                                }

                                bookmark.lineText = newText;
                                this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(newText));

                                if (bookmark.context) {
                                    const newContext = this.getLineContext(document, bestMatch.lineNumber);
                                    bookmark.context.beforeLines = newContext.beforeLines;
                                    bookmark.context.afterLines = newContext.afterLines;
                                    bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                                    bookmark.context.relativePosition =
                                        bestMatch.lineNumber / (document.lineCount || 1);
                                }
                            } else {
                                if (bookmark.context) {
                                    bookmark.context.relativePosition =
                                        bestMatch.lineNumber / (document.lineCount || 1);
                                }
                            }

                            this.addToIndices(bookmark);
                            this.updateFileLinkCache(bookmark);

                            changed = true;

                            setTimeout(() => {
                                if (bookmark.linkedBookmarkId) {
                                    const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                                    if (linkedBookmark) {
                                        this.updateLinkedBookmarkPosition(bookmark, linkedBookmark)
                                            .then(() => {
                                                this.refresh();
                                                this.reapplyAllBookmarkDecorations();
                                            })
                                            .catch((error) => {
                                                console.error("Error updating linked bookmark position:", error);
                                            });
                                    }
                                }
                            }, 0);
                        }
                    } else if (bookmark.lineNumber >= document.lineCount) {
                        const matchingLineNumber = await this.findBestMatchingLine(bookmark, documentUri);

                        if (
                            matchingLineNumber !== undefined &&
                            matchingLineNumber >= 0 &&
                            matchingLineNumber < document.lineCount
                        ) {
                            this.removeFromIndices(bookmark);
                            bookmark.lineNumber = matchingLineNumber;

                            if (isSourceDocument) {
                                const newText = document.lineAt(matchingLineNumber).text.trim();
                                bookmark.lineText = newText;
                                this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(newText));

                                if (bookmark.context) {
                                    const newContext = this.getLineContext(document, matchingLineNumber);
                                    bookmark.context.beforeLines = newContext.beforeLines;
                                    bookmark.context.afterLines = newContext.afterLines;
                                    bookmark.context.occurrenceIndex = newContext.occurrenceIndex;
                                    bookmark.context.relativePosition = matchingLineNumber / (document.lineCount || 1);
                                }
                            } else {
                                if (bookmark.context) {
                                    bookmark.context.relativePosition = matchingLineNumber / (document.lineCount || 1);
                                }
                            }

                            this.addToIndices(bookmark);
                            this.updateFileLinkCache(bookmark);

                            changed = true;

                            setTimeout(() => {
                                if (bookmark.linkedBookmarkId) {
                                    const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                                    if (linkedBookmark) {
                                        this.updateLinkedBookmarkPosition(bookmark, linkedBookmark)
                                            .then(() => {
                                                this.refresh();
                                                this.reapplyAllBookmarkDecorations();
                                            })
                                            .catch((error) => {
                                                console.error("Error updating linked bookmark position:", error);
                                            });
                                    }
                                }
                            }, 0);
                        }
                    }
                } catch (error) {
                    console.error("Error updating bookmark position (fuzzy match):", error);
                }
            }
        }

        if (changed) {
            setTimeout(async () => {
                this.refresh();
                this.reapplyAllBookmarkDecorations();
            }, 0);
        }

        return changed;
    }

    private async updateLinkedBookmarkPosition(sourceBookmark: Bookmark, linkedBookmark: Bookmark): Promise<void> {
        const linkedDocUri = linkedBookmark.docUri || linkedBookmark.sourceUri;
        try {
            const linkedDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(linkedDocUri));

            const matchingLineNumber = await this.findBestMatchingLine(sourceBookmark, linkedDocUri);

            if (
                matchingLineNumber !== undefined &&
                matchingLineNumber !== linkedBookmark.lineNumber &&
                matchingLineNumber >= 0 &&
                matchingLineNumber < linkedDoc.lineCount
            ) {
                linkedBookmark.lineNumber = matchingLineNumber;
                this.updateFileLinkCache(linkedBookmark);

                if (linkedBookmark.context) {
                    linkedBookmark.context.relativePosition = matchingLineNumber / (linkedDoc.lineCount || 1);
                }

                this.bookmarks.set(linkedBookmark.id, linkedBookmark);
            }
        } catch (error) {
            console.error("Chain Grep: Error updating linked bookmark position:", error);
        }
    }

    private hasCommonKeywords(text1: string, text2: string): boolean {
        if (!text1 || !text2) {
            return false;
        }

        if (text1.length < 3 || text2.length < 3) {
            return true;
        }

        if (text1.length > 100 && text2.length > 100) {
            if (text1.substring(0, 10) === text2.substring(0, 10)) {
                return true;
            }
            if (text1.substring(text1.length - 10) === text2.substring(text2.length - 10)) {
                return true;
            }
        }

        const words1 = text1
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 2);
        const words2 = text2
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/)
            .filter((w) => w.length > 2);

        if (words1.length === 0 || words2.length === 0) {
            return true;
        }

        const set1 = new Set(words1);

        for (const word of words2) {
            if (set1.has(word)) {
                return true;
            }
        }

        return false;
    }

    private logBookmarkDebug(message: string, ...args: any[]): void {
        if (vscode.workspace.getConfiguration("chainGrep").get<boolean>("debug", false)) {
            console.log(`ChainGrep: ${message}`, ...args);
        }
    }

    private calculateLinesSimilarity(sourceLines: string[], targetLines: string[]): number {
        if (!sourceLines.length || !targetLines.length) {
            return 0;
        }

        const minLength = Math.min(sourceLines.length, targetLines.length);
        let totalScore = 0;
        let possibleScore = 0;

        for (let i = 0; i < minLength; i++) {
            const weight = 1.0 - i / (minLength + 1);
            if (sourceLines[sourceLines.length - 1 - i] === targetLines[targetLines.length - 1 - i]) {
                totalScore += weight;
            }
            possibleScore += weight;
        }

        return possibleScore > 0 ? totalScore / possibleScore : 0;
    }

    private getLineOccurrenceIndex(document: vscode.TextDocument, lineNumber: number, lineText: string): number {
        if (!lineText.trim()) {
            return 0;
        }

        try {
            const targetLineText = lineText.trim();

            const lineRange = new vscode.Range(0, 0, lineNumber, 0);
            const textBeforeCurrent = document.getText(lineRange);
            const lines = textBeforeCurrent.split("\n");

            let occurrenceIndex = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim() === targetLineText) {
                    occurrenceIndex++;
                }
            }

            return occurrenceIndex;
        } catch (error) {
            console.error("Error calculating occurrence index:", error);
            return 0;
        }
    }

    private addToCache(bookmark: Bookmark): void {
        const uri = bookmark.docUri || bookmark.sourceUri;
        if (!this.bookmarkCache.fileLineCache.has(uri)) {
            this.bookmarkCache.fileLineCache.set(uri, new Map());
        }
        const lineMap = this.bookmarkCache.fileLineCache.get(uri)!;
        if (!lineMap.has(bookmark.lineNumber)) {
            lineMap.set(bookmark.lineNumber, []);
        }
        const bookmarksAtLine = lineMap.get(bookmark.lineNumber)!;
        if (!bookmarksAtLine.includes(bookmark.id)) {
            bookmarksAtLine.push(bookmark.id);
        }

        this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(bookmark.lineText));
    }

    private removeFromCache(bookmark: Bookmark): void {
        const uri = bookmark.docUri || bookmark.sourceUri;
        const lineMap = this.bookmarkCache.fileLineCache.get(uri);
        if (lineMap) {
            const bookmarksAtLine = lineMap.get(bookmark.lineNumber);
            if (bookmarksAtLine) {
                const index = bookmarksAtLine.indexOf(bookmark.id);
                if (index >= 0) {
                    bookmarksAtLine.splice(index, 1);
                }
                if (bookmarksAtLine.length === 0) {
                    lineMap.delete(bookmark.lineNumber);
                }
            }
            if (lineMap.size === 0) {
                this.bookmarkCache.fileLineCache.delete(uri);
            }
        }

        this.bookmarkCache.contentHashCache.delete(bookmark.id);
    }

    private clearCache(): void {
        this.bookmarkCache.fileLineCache.clear();
        this.bookmarkCache.contentHashCache.clear();
        this.bookmarkCache.documentTimestamps.clear();
    }

    public async revertUnsavedChanges(docUri: string): Promise<void> {
        this.logBookmarkDebug(`Reverting unsaved changes for document: ${docUri}`);
        const sourceBookmarks = this.findBookmarks({
            sourceUri: docUri,
            docUri: null,
        });

        if (sourceBookmarks.length === 0) {
            this.logBookmarkDebug(`No source bookmarks found for ${docUri} to revert.`);
            return;
        }

        let changed = false;
        for (const bookmark of sourceBookmarks) {
            if (bookmark.lastSavedText !== undefined && bookmark.lineText !== bookmark.lastSavedText) {
                this.logBookmarkDebug(
                    `Reverting bookmark ${bookmark.id} text from "${bookmark.lineText}" to "${bookmark.lastSavedText}"`
                );
                const originalText = bookmark.lineText;
                bookmark.lineText = bookmark.lastSavedText;

                this.bookmarkCache.contentHashCache.set(bookmark.id, this.calculateLineHash(bookmark.lineText));

                const linkedBookmarks = this.findBookmarks({ linkedBookmarkId: bookmark.id });
                for (const linked of linkedBookmarks) {
                    if (linked.lineText === originalText) {
                        this.logBookmarkDebug(
                            `Reverting linked bookmark ${linked.id} text to "${bookmark.lastSavedText}"`
                        );
                        linked.lineText = bookmark.lastSavedText;
                        linked.lastSavedText = bookmark.lastSavedText;
                        this.bookmarks.set(linked.id, linked);
                    }
                }

                this.bookmarks.set(bookmark.id, bookmark);
                changed = true;
            }
        }

        if (changed) {
            this.logBookmarkDebug(`Reverted text for affected bookmarks in ${docUri}. Refreshing and saving.`);
            this.refresh();
            await saveBookmarksToWorkspace(Array.from(this.bookmarks.values()));
            this.reapplyAllBookmarkDecorations();
        } else {
            this.logBookmarkDebug(`No bookmark text needed reverting for ${docUri}.`);
        }
    }
}
