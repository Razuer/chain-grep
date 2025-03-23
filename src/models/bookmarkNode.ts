import * as vscode from "vscode";
import * as path from "path";
import { Bookmark } from "./interfaces";
import { getChainGrepMap } from "../services/stateService";
import { buildChainPath } from "../utils/utils";

export enum BookmarkNodeType {
    Category = "category",
    Bookmark = "bookmark",
    FileRoot = "fileRoot",
}

export class BookmarkNode extends vscode.TreeItem {
    public readonly type: BookmarkNodeType;
    public readonly children?: BookmarkNode[];
    public sourceFileReference?: boolean;
    public parent?: BookmarkNode;

    constructor(
        public readonly bookmark: Bookmark,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        type: BookmarkNodeType = BookmarkNodeType.Bookmark,
        children?: BookmarkNode[]
    ) {
        super(BookmarkNode.getLabel(bookmark, type), collapsibleState);

        this.type = type;
        this.children = children;
        this.sourceFileReference = false;

        if (children) {
            for (const child of children) {
                child.parent = this;
            }
        }

        this.setupNode();
        this.contextValue = this.getContextValue();
    }

    private setupNode() {
        if (this.type === BookmarkNodeType.Bookmark) {
            this.setupBookmarkNode();
        } else {
            this.setupCategoryNode();
        }
    }

    private setupBookmarkNode() {
        const bookmark = this.bookmark;
        this.tooltip = this.getBookmarkTooltip();

        // Source file reference within a category
        if (
            this.parent &&
            this.parent.type === BookmarkNodeType.Category &&
            !bookmark.docUri
        ) {
            this.sourceFileReference = true;
            this.label = "Source File";
            this.iconPath = new vscode.ThemeIcon("file-code");
            this.description = `Line ${bookmark.lineNumber + 1}`;
            this.setOpenCommand();
            return;
        }

        // Already marked as source file reference
        if (this.sourceFileReference) {
            this.iconPath = new vscode.ThemeIcon("file-code");
            try {
                const fileName = path.basename(
                    vscode.Uri.parse(bookmark.sourceUri).fsPath
                );
                this.label = fileName;
                this.description = `Line ${bookmark.lineNumber + 1}`;
            } catch {
                this.label = "File";
                this.description = `Line ${bookmark.lineNumber + 1}`;
            }
            this.setOpenCommand();
            return;
        }

        // Chain grep document bookmark
        if (bookmark.docUri && bookmark.docUri.startsWith("chaingrep:")) {
            this.iconPath = new vscode.ThemeIcon("link");
            this.setChainGrepLabel();
            this.setOpenCommand();
            return;
        }

        // Regular bookmark
        const isFileRoot = this.parent?.type === BookmarkNodeType.FileRoot;
        this.label = this.getFormattedLabel();
        this.iconPath = new vscode.ThemeIcon("bookmark");

        if (!isFileRoot && !bookmark.docUri) {
            this.description = `Line ${bookmark.lineNumber + 1}`;
        }

        this.setOpenCommand();
    }

    private setChainGrepLabel() {
        try {
            const chainGrepMap = getChainGrepMap();
            const chainInfo = chainGrepMap.get(this.bookmark.docUri);

            if (chainInfo && chainInfo.chain && chainInfo.chain.length > 0) {
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

    private setOpenCommand() {
        this.command = {
            title: "Open Bookmark",
            command: "_chainGrep.openBookmark",
            arguments: [this],
        };
    }

    private setupCategoryNode() {
        if (this.type === BookmarkNodeType.FileRoot) {
            this.iconPath = new vscode.ThemeIcon("file-code");
            this.tooltip = "File with bookmarks";

            if (this.children && this.children.length > 0) {
                this.description = `${this.children.length} bookmarks`;
            }
            return;
        }

        if (this.type === BookmarkNodeType.Category) {
            if ((this as any).isFileNode === true) {
                this.iconPath = new vscode.ThemeIcon("file-code");
                this.tooltip = "File with bookmarks";

                try {
                    const fileName = path.basename(
                        vscode.Uri.parse(this.bookmark.sourceUri).fsPath
                    );
                    this.label = fileName;
                } catch (e) {}

                if (this.children && this.children.length > 0) {
                    this.description = `${this.children.length} bookmarks`;
                }
            } else {
                this.iconPath = new vscode.ThemeIcon("bookmark");
                this.tooltip = "Bookmark with linked references";

                if (this.children && this.children.length > 0) {
                    this.description = `${this.children.length} references`;
                }
            }
        }
    }

    private getBookmarkTooltip(): string {
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

    private getFormattedLabel(): string {
        const bookmark = this.bookmark;
        if (bookmark.label) {
            return bookmark.label;
        }

        if (bookmark.lineText) {
            return bookmark.lineText.length > 40
                ? bookmark.lineText.substring(0, 40) + "..."
                : bookmark.lineText;
        }

        return "Line " + (bookmark.lineNumber + 1);
    }

    private getContextValue(): string {
        return this.type;
    }

    static getLabel(bookmark: Bookmark, type: BookmarkNodeType): string {
        if (type === BookmarkNodeType.FileRoot) {
            try {
                return path.basename(
                    vscode.Uri.parse(bookmark.sourceUri).fsPath
                );
            } catch {
                return path.basename(bookmark.sourceUri);
            }
        }

        if (type === BookmarkNodeType.Category) {
            if (bookmark.label) {
                return bookmark.label;
            }

            return bookmark.lineText.length > 60
                ? bookmark.lineText.substring(0, 57) + "..."
                : bookmark.lineText;
        }

        if (type === BookmarkNodeType.Bookmark) {
            if (!bookmark.docUri || bookmark.docUri === "") {
                if (!bookmark.docUri) {
                    return "Source File";
                }

                if (bookmark.label) {
                    return bookmark.label;
                }

                if (bookmark.lineText) {
                    return bookmark.lineText.length > 40
                        ? bookmark.lineText.substring(0, 40) + "..."
                        : bookmark.lineText;
                }

                return "Line " + (bookmark.lineNumber + 1);
            }
        }

        return "";
    }
}
