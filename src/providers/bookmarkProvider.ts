import * as vscode from "vscode";
import * as path from "path";
import { Bookmark } from "../models/interfaces";
import { BookmarkNode, BookmarkNodeType } from "../models/bookmarkNode";
import { getBookmarkColor } from "../services/configService";
import { getChainGrepMap } from "../services/stateService";
import { ChainGrepDataProvider } from "./chainGrepDataProvider";

interface BookmarkCache {
    fileLineCache: Map<string, Map<number, string[]>>;
    contentHashCache: Map<string, string>;
    documentTimestamps: Map<string, number>;
}

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

    private chainGrepProvider: ChainGrepDataProvider | undefined;
    private chainGrepTreeView: vscode.TreeView<any> | undefined;
    private bookmarkTreeView: vscode.TreeView<any> | undefined;

    private lastUpdateTimestamp: number = 0;
    private updateThrottleTime: number = 100;
    private pendingRefresh: boolean = false;

    constructor() {
        this.getChainInfo = () => undefined;

        this.bookmarkDecorationType = this.createBookmarkDecorationType();
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
                        focus: false,
                        expand: true,
                    });
                }
            } else {
                const rootNode = this.chainGrepProvider.findRootNodeBySourceUri(docUri);
                if (rootNode) {
                    this.chainGrepTreeView.reveal(rootNode, {
                        select: true,
                        focus: false,
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

        return vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
            borderWidth: "1px 0px 1px 0px",
            borderStyle: "solid",
            borderColor: bookmarkColor,
            after: {
                contentText: "❰",
                color: bookmarkColor,
                margin: "0 0 0 0.5em",
                fontWeight: "bold",
            },
            overviewRulerColor: bookmarkColor,
            overviewRulerLane: vscode.OverviewRulerLane.Full,
            before: {
                contentText: "❱",
                color: bookmarkColor,
                margin: "0 0.5em 0 0",
                fontWeight: "bold",
            },
            light: {
                backgroundColor: `${bookmarkColor}22`,
                fontWeight: "bold",
            },
            dark: {
                backgroundColor: `${bookmarkColor}22`,
                fontWeight: "bold",
            },
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: BookmarkNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: BookmarkNode): Thenable<BookmarkNode[]> {
        if (element?.type === BookmarkNodeType.Category && element.children) {
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
                const sourceBookmarks = bookmarksInFile.filter((b) => b.docUri === "");

                if (sourceBookmarks.length === 0) {
                    continue;
                }

                const chainGrepBookmarks = bookmarksInFile.filter((b) => b.docUri !== "");
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
                                BookmarkNodeType.Bookmark
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
                                BookmarkNodeType.Bookmark
                            );

                            sourceFileNode.sourceFileReference = true;

                            locationNodes.push(sourceFileNode);
                        }

                        const chainBookmarks = bookmarksForCategory.filter((b) => b.docUri !== "");
                        for (const chainBookmark of chainBookmarks) {
                            const chainNode = new BookmarkNode(
                                chainBookmark,
                                vscode.TreeItemCollapsibleState.None,
                                BookmarkNodeType.Bookmark
                            );

                            locationNodes.push(chainNode);
                        }

                        locationNodes.sort((a, b) => {
                            if (a.sourceFileReference === true && b.sourceFileReference !== true) {
                                return -1;
                            }
                            if (a.sourceFileReference !== true && b.sourceFileReference === true) {
                                return 1;
                            }
                            return 0;
                        });

                        if (locationNodes.length > 0) {
                            const categoryNode = new BookmarkNode(
                                mainBookmark,
                                vscode.TreeItemCollapsibleState.Collapsed,
                                BookmarkNodeType.Category,
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

    private removeAllLinkedBookmarks(bookmark: Bookmark): void {
        const allBookmarks = Array.from(this.bookmarks.values());

        const relatedBookmarks = allBookmarks.filter((b) => {
            return (
                b.sourceUri === bookmark.sourceUri &&
                b.id !== bookmark.id &&
                (bookmark.docUri !== "" || b.docUri !== "") &&
                (b.lineText === bookmark.lineText || b.linkedBookmarkId === bookmark.id)
            );
        });

        for (const relatedBookmark of relatedBookmarks) {
            this.removeBookmark(relatedBookmark.id);
        }
    }

    clearBookmarks(sourceUri: string): void {
        const bookmarkIds = this.sourceUriToBookmarks.get(sourceUri);
        if (bookmarkIds) {
            bookmarkIds.forEach((id) => this.bookmarks.delete(id));
            this.sourceUriToBookmarks.delete(sourceUri);
            this.refresh();
            this.applyBookmarkDecorations();
        }
    }

    clearBookmarksFromDocument(docUri: string): void {
        const bookmarksToRemove = Array.from(this.bookmarks.values())
            .filter((b) => b.docUri === docUri)
            .map((b) => b.id);

        bookmarksToRemove.forEach((id) => {
            const bookmark = this.bookmarks.get(id);
            if (bookmark) {
                this.bookmarks.delete(id);

                const sourceBookmarks = this.sourceUriToBookmarks.get(bookmark.sourceUri);
                if (sourceBookmarks) {
                    const index = sourceBookmarks.indexOf(id);
                    if (index !== -1) {
                        sourceBookmarks.splice(index, 1);
                    }

                    if (sourceBookmarks.length === 0) {
                        this.sourceUriToBookmarks.delete(bookmark.sourceUri);
                    }
                }
            }
        });

        if (bookmarksToRemove.length > 0) {
            this.refresh();
            this.applyBookmarkDecorations();
        }
    }

    clearBookmarksFromFile(sourceUri: string): void {
        const bookmarksToRemove = Array.from(this.bookmarks.values()).filter((b) => b.sourceUri === sourceUri);

        for (const bookmark of bookmarksToRemove) {
            this.removeBookmark(bookmark.id);
        }

        if (this.sourceUriToBookmarks.has(sourceUri)) {
            this.sourceUriToBookmarks.delete(sourceUri);
        }

        this.refresh();

        this.reapplyAllBookmarkDecorations();
    }

    clearAllBookmarks(): void {
        this.bookmarks.clear();
        this.sourceUriToBookmarks.clear();
        this.docLineToBookmarks.clear();
        this.sourceLineToBookmarks.clear();

        this.clearCache();

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
            const isSourceFile = !docUri.startsWith("chaingrep:");
            const decorations: vscode.DecorationOptions[] = [];
            let validBookmarks: Bookmark[] = [];

            const lineCount = editor.document.lineCount;

            if (isSourceFile) {
                const directBookmarks = Array.from(this.bookmarks.values()).filter(
                    (b) => b.sourceUri === docUri && b.docUri === ""
                );

                const linkedBookmarks = Array.from(this.bookmarks.values()).filter(
                    (b) => b.sourceUri === docUri && b.docUri !== ""
                );

                validBookmarks = [...directBookmarks, ...linkedBookmarks];

                for (const bookmark of directBookmarks) {
                    try {
                        if (bookmark.lineNumber >= 0 && bookmark.lineNumber < lineCount) {
                            const line = editor.document.lineAt(bookmark.lineNumber);
                            const decoration: vscode.DecorationOptions = {
                                range: line.range,
                                hoverMessage: this.getBookmarkHoverMessage(bookmark),
                            };
                            decorations.push(decoration);
                        }
                    } catch (err) {
                        console.error(`Error creating decoration for bookmark at line ${bookmark.lineNumber}:`, err);
                    }
                }
            } else {
                validBookmarks = Array.from(this.bookmarks.values()).filter((b) => b.docUri === docUri);

                for (const bookmark of validBookmarks) {
                    try {
                        if (bookmark.lineNumber >= 0 && bookmark.lineNumber < lineCount) {
                            const line = editor.document.lineAt(bookmark.lineNumber);
                            const decoration: vscode.DecorationOptions = {
                                range: line.range,
                                hoverMessage: this.getBookmarkHoverMessage(bookmark),
                            };
                            decorations.push(decoration);
                        }
                    } catch (err) {
                        console.error(`Error creating decoration for bookmark at line ${bookmark.lineNumber}:`, err);
                    }
                }
            }

            try {
                editor.setDecorations(this.bookmarkDecorationType, []);
            } catch (e) {
                console.error("Error clearing decorations:", e);
                return;
            }

            if (decorations.length > 0) {
                setTimeout(() => {
                    try {
                        if (editor && !editor.document.isClosed) {
                            editor.setDecorations(this.bookmarkDecorationType, decorations);
                        }
                    } catch (e) {
                        console.error("Error applying decorations with delay:", e);
                    }
                }, 100);
            }

            if (editor === vscode.window.activeTextEditor) {
                this.updateEditorHasBookmarkContext(editor, validBookmarks);
            }
        } catch (error) {
            console.error("Error applying bookmark decorations:", error);
        }
    }

    private updateEditorHasBookmarkContext(editor: vscode.TextEditor, bookmarks: Bookmark[]): void {
        const lineNumber = editor.selection.active.line;
        const docUri = editor.document.uri.toString();
        const isChainGrepDoc = docUri.startsWith("chaingrep:");

        let hasBookmark = isChainGrepDoc
            ? this.hasBookmarkAtLine(docUri, lineNumber)
            : this.hasSourceBookmarkAtLine(docUri, lineNumber);

        if (!hasBookmark && !isChainGrepDoc) {
            const sourceBookmarks = this.getSourceBookmarksAtLine(docUri, lineNumber);
            hasBookmark = sourceBookmarks.some((b) => b.linkedBookmarkId !== undefined);
        }

        vscode.commands.executeCommand("setContext", "editorHasBookmark", hasBookmark);
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
            if (!this.docLineToBookmarks.has(bookmark.docUri)) {
                this.docLineToBookmarks.set(bookmark.docUri, new Map());
            }
            const lineMap = this.docLineToBookmarks.get(bookmark.docUri)!;
            if (!lineMap.has(bookmark.lineNumber)) {
                lineMap.set(bookmark.lineNumber, []);
            }
            const bookmarksAtLine = lineMap.get(bookmark.lineNumber)!;
            if (!bookmarksAtLine.includes(bookmark.id)) {
                bookmarksAtLine.push(bookmark.id);
            }
        }

        if (!bookmark.docUri || bookmark.docUri === "") {
            if (!this.sourceLineToBookmarks.has(bookmark.sourceUri)) {
                this.sourceLineToBookmarks.set(bookmark.sourceUri, new Map());
            }
            const lineMap = this.sourceLineToBookmarks.get(bookmark.sourceUri)!;
            if (!lineMap.has(bookmark.lineNumber)) {
                lineMap.set(bookmark.lineNumber, []);
            }
            const bookmarksAtLine = lineMap.get(bookmark.lineNumber)!;
            if (!bookmarksAtLine.includes(bookmark.id)) {
                bookmarksAtLine.push(bookmark.id);
            }
        }
    }

    private removeFromIndices(bookmark: Bookmark): void {
        if (bookmark.docUri) {
            const lineMap = this.docLineToBookmarks.get(bookmark.docUri);
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
                    this.docLineToBookmarks.delete(bookmark.docUri);
                }
            }
        }

        if (!bookmark.docUri || bookmark.docUri === "") {
            const lineMap = this.sourceLineToBookmarks.get(bookmark.sourceUri);
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
                    this.sourceLineToBookmarks.delete(bookmark.sourceUri);
                }
            }
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
        const chainInfo = this.getChainInfo(docUri);
        if (!chainInfo) {
            return;
        }

        const sourceUri = chainInfo.sourceUri.toString();

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

        for (const bookmark of bookmarksToSync) {
            try {
                if (bookmark.docUri === docUri) {
                    if (bookmark.lineNumber < document.lineCount) {
                        const newText = document.lineAt(bookmark.lineNumber).text.trim();

                        const newContentHash = this.calculateLineHash(newText);
                        const oldContentHash = this.bookmarkCache.contentHashCache.get(bookmark.id);

                        if (!oldContentHash || oldContentHash !== newContentHash) {
                            bookmark.lineText = newText;
                            this.bookmarkCache.contentHashCache.set(bookmark.id, newContentHash);

                            if (bookmark.context) {
                                const newContext = this.getLineContext(document, bookmark.lineNumber);
                                bookmark.context.beforeLines = newContext.beforeLines;
                                bookmark.context.afterLines = newContext.afterLines;
                            }

                            changed = true;

                            if (bookmark.linkedBookmarkId) {
                                const linkedBookmark = this.bookmarks.get(bookmark.linkedBookmarkId);
                                if (linkedBookmark) {
                                    await this.updateLinkedBookmark(bookmark, linkedBookmark);
                                }
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
    }

    private async updateLinkedBookmark(sourceBookmark: Bookmark, linkedBookmark: Bookmark): Promise<void> {
        const linkedDocUri = linkedBookmark.docUri || linkedBookmark.sourceUri;
        try {
            const linkedDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(linkedDocUri));

            const cacheKey = `${linkedDocUri}:${linkedBookmark.lineNumber}:${sourceBookmark.lineText}`;
            let matchingLineNumber: number | undefined;

            if (this.isCachedPositionValid(linkedBookmark)) {
                matchingLineNumber = linkedBookmark.lineNumber;
            } else {
                matchingLineNumber = await this.findBestMatchingLine(sourceBookmark, linkedDocUri);
            }

            if (
                matchingLineNumber !== undefined &&
                matchingLineNumber !== linkedBookmark.lineNumber &&
                matchingLineNumber >= 0 &&
                matchingLineNumber < linkedDoc.lineCount
            ) {
                linkedBookmark.lineNumber = matchingLineNumber;
                linkedBookmark.lineText = linkedDoc.lineAt(matchingLineNumber).text.trim();

                this.bookmarkCache.contentHashCache.set(
                    linkedBookmark.id,
                    this.calculateLineHash(linkedBookmark.lineText)
                );

                this.updateFileLinkCache(linkedBookmark);

                if (linkedBookmark.context) {
                    const newContext = this.getLineContext(linkedDoc, matchingLineNumber);
                    linkedBookmark.context.beforeLines = newContext.beforeLines;
                    linkedBookmark.context.afterLines = newContext.afterLines;
                }
            }
        } catch (error) {
            console.error("Chain Grep: Error updating linked bookmark:", error);
        }
    }

    dispose(): void {
        this.bookmarkDecorationType.dispose();
    }

    updateDecorationStyle(): void {
        this.bookmarkDecorationType.dispose();

        this.bookmarkDecorationType = this.createBookmarkDecorationType();

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
                vscode.window.showInformationMessage("No bookmark found at current line.");
                return;
            }
        }

        try {
            if (bookmark.docUri && bookmark.docUri.startsWith("chaingrep:")) {
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
            vscode.window.showErrorMessage("Failed to open bookmark. The file may have been deleted or moved.");
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

        return { beforeLines, afterLines, occurrenceIndex };
    }

    private calculateContextSimilarity(
        sourceContext: Bookmark["context"],
        targetContext: {
            beforeLines: string[];
            afterLines: string[];
            occurrenceIndex: number;
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
                this.cacheMatchingLine(bookmark, targetDocUri, bestMatch);
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
                this.cacheMatchingLine(bookmark, targetDocUri, bestMatch);
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

        const words1 = text1
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2);
        const words2 = text2
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2);

        if (words1.length === 0 || words2.length === 0) {
            return 0;
        }

        let matches = 0;
        for (const word1 of words1) {
            for (const word2 of words2) {
                if (word1 === word2 || word1.includes(word2) || word2.includes(word1)) {
                    matches++;
                    break;
                }
            }
        }

        return matches / Math.max(words1.length, words2.length);
    }

    private calculateContextScore(
        sourceBeforeLines: string[],
        sourceAfterLines: string[],
        targetBeforeLines: string[],
        targetAfterLines: string[]
    ): number {
        let score = 0;
        const beforeCount = Math.min(sourceBeforeLines.length, targetBeforeLines.length);
        const afterCount = Math.min(sourceAfterLines.length, targetAfterLines.length);

        for (let i = 0; i < beforeCount; i++) {
            const sourceLine = sourceBeforeLines[sourceBeforeLines.length - 1 - i].trim();
            const targetLine = targetBeforeLines[targetBeforeLines.length - 1 - i].trim();

            if (sourceLine === targetLine) {
                score += 1 / (i + 1);
            } else if (sourceLine.includes(targetLine) || targetLine.includes(sourceLine)) {
                score += 0.5 / (i + 1);
            }
        }

        for (let i = 0; i < afterCount; i++) {
            const sourceLine = sourceAfterLines[i].trim();
            const targetLine = targetAfterLines[i].trim();

            if (sourceLine === targetLine) {
                score += 1 / (i + 1);
            } else if (sourceLine.includes(targetLine) || targetLine.includes(sourceLine)) {
                score += 0.5 / (i + 1);
            }
        }

        return score;
    }

    public async synchronizeBookmarkToFile(bookmark: Bookmark): Promise<void> {
        if (bookmark.docUri === "") {
            return;
        }
        try {
            const chain = this.getChainInfo ? this.getChainInfo(bookmark.docUri) : undefined;
            if (!chain) {
                return;
            }

            const existingSourceBookmarks = this.findBookmarks({
                sourceUri: bookmark.sourceUri,
                docUri: null,
                occurrenceIndex: bookmark.context?.occurrenceIndex,
            });

            const existingSourceBookmark = existingSourceBookmarks.find(
                (b) =>
                    b.linkedBookmarkId === bookmark.id ||
                    (bookmark.linkedBookmarkId && bookmark.linkedBookmarkId === b.id) ||
                    b.lineText === bookmark.lineText
            );

            if (existingSourceBookmark) {
                if (existingSourceBookmark.linkedBookmarkId !== bookmark.id) {
                    existingSourceBookmark.linkedBookmarkId = bookmark.id;
                    this.addBookmark(existingSourceBookmark);
                }

                if (bookmark.linkedBookmarkId !== existingSourceBookmark.id) {
                    bookmark.linkedBookmarkId = existingSourceBookmark.id;
                    this.addBookmark(bookmark);
                }

                this.refresh();
                this.reapplyAllBookmarkDecorations();
                return;
            }

            const sourceDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(bookmark.sourceUri));
            const matchingLineNumber = await this.findBestMatchingLine(bookmark, bookmark.sourceUri);

            if (
                matchingLineNumber !== undefined &&
                matchingLineNumber >= 0 &&
                matchingLineNumber < sourceDoc.lineCount
            ) {
                const lineText = sourceDoc.lineAt(matchingLineNumber).text.trim();

                const existingBookmarksAtLine = this.findBookmarks({
                    sourceUri: bookmark.sourceUri,
                    docUri: null,
                    lineNumber: matchingLineNumber,
                    occurrenceIndex: bookmark.context?.occurrenceIndex,
                });

                if (existingBookmarksAtLine.length > 0) {
                    const existingBookmarkAtLine = existingBookmarksAtLine[0];

                    if (existingBookmarkAtLine.linkedBookmarkId !== bookmark.id) {
                        existingBookmarkAtLine.linkedBookmarkId = bookmark.id;
                        this.addBookmark(existingBookmarkAtLine);
                    }

                    if (bookmark.linkedBookmarkId !== existingBookmarkAtLine.id) {
                        bookmark.linkedBookmarkId = existingBookmarkAtLine.id;
                        this.addBookmark(bookmark);
                    }

                    this.refresh();
                    this.reapplyAllBookmarkDecorations();
                    return;
                }

                const context = this.getLineContext(sourceDoc, matchingLineNumber, 5);
                const relativePosition = matchingLineNumber / (sourceDoc.lineCount || 1);

                const sourceBookmark: Bookmark = {
                    id: `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
                    lineNumber: matchingLineNumber,
                    lineText,
                    docUri: "",
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

                this.addBookmark(sourceBookmark);

                bookmark.linkedBookmarkId = sourceBookmark.id;
                this.addBookmark(bookmark);

                this.refresh();
                this.reapplyAllBookmarkDecorations();
            }
        } catch (error) {
            console.error(`Chain Grep: Error synchronizing bookmark to file:`, error);
        }
    }

    public async synchronizeBookmarkToAllChainDocs(bookmark: Bookmark): Promise<void> {
        if (bookmark.docUri !== "") {
            return;
        }

        try {
            if (!this.getChainInfo) {
                return;
            }

            const chainGrepMap = new Map<string, any>();
            const globalChainGrepMap = getChainGrepMap();

            for (const [docUri, info] of globalChainGrepMap.entries()) {
                if (info && info.sourceUri && info.sourceUri.toString() === bookmark.sourceUri) {
                    chainGrepMap.set(docUri, info);
                }
            }

            if (chainGrepMap.size === 0) {
                return;
            }

            for (const [chainDocUri, chainInfo] of chainGrepMap.entries()) {
                const existingBookmarks = this.findBookmarks({
                    docUri: chainDocUri,
                    sourceUri: bookmark.sourceUri,
                    occurrenceIndex: bookmark.context?.occurrenceIndex,
                });

                const existingBookmark = existingBookmarks.find(
                    (b) => b.linkedBookmarkId === bookmark.id || b.lineText === bookmark.lineText
                );

                if (existingBookmark) {
                    if (existingBookmark.linkedBookmarkId !== bookmark.id) {
                        existingBookmark.linkedBookmarkId = bookmark.id;
                        this.bookmarks.set(existingBookmark.id, existingBookmark);
                    }

                    if (!bookmark.linkedBookmarkId) {
                        const currentBookmark = this.bookmarks.get(bookmark.id);
                        if (currentBookmark) {
                            currentBookmark.linkedBookmarkId = existingBookmark.id;
                            this.bookmarks.set(currentBookmark.id, currentBookmark);
                        }
                    }
                    continue;
                }

                try {
                    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(chainDocUri));
                    const matchingLineNumber = await this.findBestMatchingLine(bookmark, chainDocUri);

                    if (
                        matchingLineNumber !== undefined &&
                        matchingLineNumber >= 0 &&
                        matchingLineNumber < doc.lineCount
                    ) {
                        const bookmarksAtLine = this.findBookmarks({
                            docUri: chainDocUri,
                            lineNumber: matchingLineNumber,
                            occurrenceIndex: bookmark.context?.occurrenceIndex,
                        });

                        if (bookmarksAtLine.length > 0) {
                            const bookmarkAtLine = bookmarksAtLine[0];
                            if (!bookmarkAtLine.linkedBookmarkId) {
                                bookmarkAtLine.linkedBookmarkId = bookmark.id;
                                this.bookmarks.set(bookmarkAtLine.id, bookmarkAtLine);
                            }

                            const currentBookmark = this.bookmarks.get(bookmark.id);
                            if (currentBookmark && !currentBookmark.linkedBookmarkId) {
                                currentBookmark.linkedBookmarkId = bookmarkAtLine.id;
                                this.bookmarks.set(currentBookmark.id, currentBookmark);
                            }
                            continue;
                        }

                        const lineText = doc.lineAt(matchingLineNumber).text.trim();
                        const context = this.getLineContext(doc, matchingLineNumber, 5);
                        const relativePosition = matchingLineNumber / (doc.lineCount || 1);

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

                        this.addBookmark(chainBookmark);

                        const currentBookmark = this.bookmarks.get(bookmark.id);
                        if (currentBookmark && !currentBookmark.linkedBookmarkId) {
                            currentBookmark.linkedBookmarkId = chainBookmark.id;
                            this.bookmarks.set(currentBookmark.id, currentBookmark);
                        }
                    }
                } catch (error) {
                    console.error(`Error processing chain grep document ${chainDocUri}:`, error);
                }
            }

            this.refresh();
            this.reapplyAllBookmarkDecorations();
        } catch (error) {
            console.error("Error synchronizing bookmark to Chain Grep documents:", error);
        }
    }

    public updateEditorHasBookmarkContextOnly(editor: vscode.TextEditor): void {
        const docUri = editor.document.uri.toString();
        const isChainGrepDoc = docUri.startsWith("chaingrep:");

        const validBookmarks = isChainGrepDoc
            ? this.findBookmarks({ docUri })
            : [
                  ...this.findBookmarks({ sourceUri: docUri, docUri: null }),
                  ...this.findBookmarks({ sourceUri: docUri }),
              ];

        this.updateEditorHasBookmarkContext(editor, validBookmarks);
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

    private async createNewBookmark(
        sourceUri: string,
        docUri: string,
        lineNumber: number,
        document: vscode.TextDocument,
        label?: string
    ): Promise<Bookmark> {
        const lineText = document.lineAt(lineNumber).text.trim();
        const context = this.getLineContext(document, lineNumber, 5);
        const relativePosition = lineNumber / (document.lineCount || 1);

        const bookmarkId = `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

        const bookmark: Bookmark = {
            id: bookmarkId,
            lineNumber,
            lineText,
            docUri,
            sourceUri,
            label,
            timestamp: Date.now(),
            context: {
                beforeLines: context.beforeLines,
                afterLines: context.afterLines,
                relativePosition,
            },
        };

        return bookmark;
    }

    private async addBookmarkToSourceFile(
        bookmark: Bookmark,
        document: vscode.TextDocument,
        matchingLineNumber: number
    ): Promise<void> {
        const lineText = document.lineAt(matchingLineNumber).text.trim();
        const context = this.getLineContext(document, matchingLineNumber, 5);
        const relativePosition = matchingLineNumber / (document.lineCount || 1);

        const sourceBookmark: Bookmark = {
            id: `bookmark_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
            lineNumber: matchingLineNumber,
            lineText,
            docUri: "",
            sourceUri: bookmark.sourceUri,
            label: bookmark.label,
            timestamp: Date.now(),
            linkedBookmarkId: bookmark.id,
            context: {
                beforeLines: context.beforeLines,
                afterLines: context.afterLines,
                relativePosition,
            },
        };

        this.addBookmark(sourceBookmark);

        bookmark.linkedBookmarkId = sourceBookmark.id;
        this.bookmarks.set(bookmark.id, bookmark);
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

    private getCachedLineForBookmark(bookmark: Bookmark, targetDocUri: string): number | undefined {
        const cacheKey = `${targetDocUri}:${bookmark.lineText}:${bookmark.context?.occurrenceIndex || 0}`;
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

    private cacheMatchingLine(bookmark: Bookmark, targetDocUri: string, lineNumber: number): void {
        const cacheKey = `${targetDocUri}:${bookmark.lineText}:${bookmark.context?.occurrenceIndex || 0}`;
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

    private rebuildCache(): void {
        this.clearCache();

        for (const bookmark of this.bookmarks.values()) {
            this.addToCache(bookmark);
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
}
