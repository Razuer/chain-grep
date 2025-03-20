import * as vscode from "vscode";
import * as path from "path";
import { Bookmark } from "./interfaces";
import { getChainGrepMap } from "../services/stateService";

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
        super(getBookmarkLabel(bookmark, type), collapsibleState);

        this.type = type;
        this.children = children;
        this.sourceFileReference = false;

        if (children) {
            for (const child of children) {
                child.parent = this;
            }
        }

        if (type === BookmarkNodeType.Bookmark) {
            this.setupBookmarkNode(bookmark);
        } else {
            this.setupCategoryNode();
        }

        this.contextValue = this.getContextValue();
    }

    private setupBookmarkNode(bookmark: Bookmark) {
        this.tooltip = this.getBookmarkTooltip(bookmark);

        if (this.parent && this.parent.type === BookmarkNodeType.Category && !bookmark.docUri) {
            this.sourceFileReference = true;
            this.label = "Source File";
            this.iconPath = new vscode.ThemeIcon("file-code");
            this.description = `Line ${bookmark.lineNumber + 1}`;
            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
            return;
        }

        if (this.sourceFileReference === true) {
            this.iconPath = new vscode.ThemeIcon("file-code");
            try {
                const fileName = path.basename(vscode.Uri.parse(bookmark.sourceUri).fsPath);
                this.label = fileName;
                this.description = `Line ${bookmark.lineNumber + 1}`;
            } catch {
                this.label = "File";
                this.description = `Line ${bookmark.lineNumber + 1}`;
            }
            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
        } else if (bookmark.docUri && bookmark.docUri.startsWith("chaingrep:")) {
            this.iconPath = new vscode.ThemeIcon("link");

            try {
                const chainGrepMap = getChainGrepMap();
                const chainInfo = chainGrepMap.get(bookmark.docUri);

                if (chainInfo && chainInfo.chain && chainInfo.chain.length > 0) {
                    const lastQuery = chainInfo.chain[chainInfo.chain.length - 1];
                    const queryType = lastQuery.type;
                    const query = lastQuery.query.substring(0, 15) + (lastQuery.query.length > 15 ? "..." : "");
                    this.label = `[${queryType === "text" ? "T" : "R"}] "${query}"`;
                    this.description = `Line ${bookmark.lineNumber + 1}`;
                } else {
                    this.label = "Chain Grep";
                    this.description = `Line ${bookmark.lineNumber + 1}`;
                }
            } catch (e) {
                this.label = "Chain Grep";
                this.description = `Line ${bookmark.lineNumber + 1}`;
            }

            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
        } else {
            if (this.parent && this.parent.type === BookmarkNodeType.FileRoot) {
                if (bookmark.label) {
                    this.label = bookmark.label;
                } else if (bookmark.lineText) {
                    this.label =
                        bookmark.lineText.length > 40 ? bookmark.lineText.substring(0, 40) + "..." : bookmark.lineText;
                } else {
                    this.label = "Line " + (bookmark.lineNumber + 1);
                }
                this.iconPath = new vscode.ThemeIcon("bookmark");
            } else if (!bookmark.docUri) {
                this.label = "Source File";
                this.iconPath = new vscode.ThemeIcon("file-code");
                this.description = `Line ${bookmark.lineNumber + 1}`;
            }

            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
        }
    }

    private setupCategoryNode() {
        if (this.type === BookmarkNodeType.FileRoot) {
            this.iconPath = new vscode.ThemeIcon("file-code");
            this.tooltip = "File with bookmarks";

            if (this.children && this.children.length > 0) {
                this.description = `${this.children.length} bookmarks`;
            }
        } else if (this.type === BookmarkNodeType.Category) {
            if ((this as any).isFileNode === true) {
                this.iconPath = new vscode.ThemeIcon("file-code");
                this.tooltip = "File with bookmarks";

                try {
                    const fileName = path.basename(vscode.Uri.parse(this.bookmark.sourceUri).fsPath);
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

    private getBookmarkTooltip(bookmark: Bookmark): string {
        let sourcePath = "";
        try {
            sourcePath = bookmark.sourceUri ? vscode.Uri.parse(bookmark.sourceUri).fsPath : "";
            sourcePath = path.basename(sourcePath);
        } catch {
            sourcePath = bookmark.sourceUri;
        }

        const lines = [];

        lines.push(`Line ${bookmark.lineNumber + 1}: ${bookmark.lineText}`);
        lines.push("");

        lines.push(`File: ${sourcePath}`);

        if (bookmark.timestamp) {
            const date = new Date(bookmark.timestamp);
            lines.push(`Created: ${date.toLocaleString()}`);
        }

        if (bookmark.context?.occurrenceIndex !== undefined) {
            lines.push(`Occurrence: ${bookmark.context.occurrenceIndex + 1}`);
        }

        return lines.join("\n");
    }

    private getBookmarkDescription(bookmark: Bookmark): string {
        if (this.type === BookmarkNodeType.FileRoot) {
            return "";
        }

        if (this.sourceFileReference) {
            return `Line ${bookmark.lineNumber + 1}`;
        }

        if (this.type === BookmarkNodeType.Bookmark) {
            if (!bookmark.docUri || bookmark.docUri === "") {
                if (!bookmark.docUri) {
                    return "Source File";
                }

                if (bookmark.label) {
                    return bookmark.label;
                } else if (bookmark.lineText) {
                    return bookmark.lineText.length > 40
                        ? bookmark.lineText.substring(0, 40) + "..."
                        : bookmark.lineText;
                } else {
                    return "Line " + (bookmark.lineNumber + 1);
                }
            }
            return "";
        } else if (this.type === BookmarkNodeType.Category) {
            return "";
        }

        return "";
    }

    private getContextValue(): string {
        switch (this.type) {
            case BookmarkNodeType.FileRoot:
                return "fileRoot";
            case BookmarkNodeType.Category:
                return "category";
            case BookmarkNodeType.Bookmark:
                return "bookmark";
            default:
                return "";
        }
    }
}

function getBookmarkLabel(bookmark: Bookmark, type: BookmarkNodeType): string {
    if (type === BookmarkNodeType.FileRoot) {
        try {
            const parsedUri = vscode.Uri.parse(bookmark.sourceUri);
            const fileName = path.basename(parsedUri.fsPath);
            return fileName;
        } catch {
            return path.basename(bookmark.sourceUri);
        }
    } else if (type === BookmarkNodeType.Category) {
        if (bookmark.label) {
            return bookmark.label;
        }

        return bookmark.lineText.length > 60 ? bookmark.lineText.substring(0, 57) + "..." : bookmark.lineText;
    } else if (type === BookmarkNodeType.Bookmark) {
        if (!bookmark.docUri || bookmark.docUri === "") {
            if (!bookmark.docUri) {
                return "Source File";
            }

            if (bookmark.label) {
                return bookmark.label;
            } else if (bookmark.lineText) {
                return bookmark.lineText.length > 40 ? bookmark.lineText.substring(0, 40) + "..." : bookmark.lineText;
            } else {
                return "Line " + (bookmark.lineNumber + 1);
            }
        }
        return "";
    } else {
        return "";
    }
}
