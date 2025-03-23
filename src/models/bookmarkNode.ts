import * as vscode from "vscode";
import * as path from "path";
import { Bookmark } from "./interfaces";
import { getChainGrepMap } from "../services/stateService";
import { buildChainPath } from "../utils/utils";

export enum BookmarkNodeType {
    FileRoot = "fileRoot",
    StandaloneBookmark = "standaloneBookmark",
    BookmarkCategory = "bookmarkCategory",
    SourceReference = "sourceReference",
    ChainGrepLink = "chainGrepLink",
}

export class BookmarkNode extends vscode.TreeItem {
    public readonly children?: BookmarkNode[];
    public parent?: BookmarkNode;

    constructor(
        public readonly bookmark: Bookmark,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: BookmarkNodeType,
        children?: BookmarkNode[]
    ) {
        super(BookmarkNode.getNodeLabel(bookmark, type), collapsibleState);

        this.children = children;

        if (children) {
            children.forEach((child) => {
                child.parent = this;
            });
        }

        this.setupNodeAppearance();
    }

    private setupNodeAppearance() {
        this.tooltip = this.getTooltip();
        this.contextValue = this.type;

        switch (this.type) {
            case BookmarkNodeType.FileRoot:
                this.setupFileRoot();
                break;
            case BookmarkNodeType.StandaloneBookmark:
                this.setupStandaloneBookmark();
                break;
            case BookmarkNodeType.BookmarkCategory:
                this.setupBookmarkCategory();
                break;
            case BookmarkNodeType.SourceReference:
                this.setupSourceReference();
                break;
            case BookmarkNodeType.ChainGrepLink:
                this.setupChainGrepLink();
                break;
        }
    }

    private setupFileRoot() {
        this.iconPath = new vscode.ThemeIcon("file");

        if (this.children && this.children.length > 0) {
            this.description = `${this.children.length} bookmarks`;
        }
    }

    private setupStandaloneBookmark() {
        this.iconPath = new vscode.ThemeIcon("bookmark");
        this.description = `Line ${this.bookmark.lineNumber + 1}`;
        this.command = this.createOpenCommand();
        this.contextValue = `${this.type}`;
    }

    private setupBookmarkCategory() {
        this.iconPath = new vscode.ThemeIcon("bookmark");

        if (this.children && this.children.length > 0) {
            this.description = `${this.children.length} references`;
        }
        this.contextValue = `${this.type}`;
    }

    private setupSourceReference() {
        this.iconPath = new vscode.ThemeIcon("file-symlink-file");
        this.label = "Source File";
        this.description = `Line ${this.bookmark.lineNumber + 1}`;
        this.command = this.createOpenCommand();
    }

    private setupChainGrepLink() {
        this.iconPath = new vscode.ThemeIcon("link");
        this.setChainGrepLabel();
        this.command = this.createOpenCommand();
    }

    private setChainGrepLabel() {
        try {
            const chainGrepMap = getChainGrepMap();
            const chainInfo = chainGrepMap.get(this.bookmark.docUri);

            if (chainInfo?.chain?.length > 0) {
                const chainPath = buildChainPath(chainInfo.chain);
                this.label = chainPath;
            } else {
                this.label = "Chain Grep";
            }
            this.description = `Line ${this.bookmark.lineNumber + 1}`;
        } catch (e) {
            this.label = "Chain Grep";
            this.description = `Line ${this.bookmark.lineNumber + 1}`;
        }
    }

    private createOpenCommand(): vscode.Command {
        return {
            title: "Open Bookmark",
            command: "_chainGrep.openBookmark",
            arguments: [this],
        };
    }

    private getTooltip(): string {
        const bookmark = this.bookmark;
        let sourcePath = "";

        try {
            sourcePath = bookmark.sourceUri
                ? path.basename(vscode.Uri.parse(bookmark.sourceUri).fsPath)
                : "";
        } catch {
            sourcePath = bookmark.sourceUri;
        }

        const lines = [
            `Line ${bookmark.lineNumber + 1}: ${bookmark.lineText}`,
            "",
            `File: ${sourcePath}`,
        ];

        if (bookmark.timestamp) {
            const date = new Date(bookmark.timestamp);
            lines.push(`Created: ${date.toLocaleString()}`);
        }

        if (bookmark.context?.occurrenceIndex !== undefined) {
            lines.push(`Occurrence: ${bookmark.context.occurrenceIndex + 1}`);
        }

        return lines.join("\n");
    }

    static getNodeLabel(bookmark: Bookmark, type: BookmarkNodeType): string {
        switch (type) {
            case BookmarkNodeType.FileRoot:
                try {
                    return path.basename(
                        vscode.Uri.parse(bookmark.sourceUri).fsPath
                    );
                } catch {
                    return path.basename(bookmark.sourceUri);
                }

            case BookmarkNodeType.BookmarkCategory:
                return this.formatBookmarkText(bookmark, 60);

            case BookmarkNodeType.StandaloneBookmark:
                return this.formatBookmarkText(bookmark, 40);

            case BookmarkNodeType.SourceReference:
                return "Source File";

            case BookmarkNodeType.ChainGrepLink:
                return "Chain Grep";

            default:
                return "";
        }
    }

    private static formatBookmarkText(
        bookmark: Bookmark,
        maxLength: number
    ): string {
        if (bookmark.label) {
            return bookmark.label;
        }

        if (bookmark.lineText) {
            return bookmark.lineText.length > maxLength
                ? bookmark.lineText.substring(0, maxLength - 3) + "..."
                : bookmark.lineText;
        }

        return `Line ${bookmark.lineNumber + 1}`;
    }
}
