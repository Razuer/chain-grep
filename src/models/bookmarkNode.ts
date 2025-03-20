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
        this.sourceFileReference = false; // Domyślnie nie jest odnośnikiem do pliku źródłowego

        // Ustawiamy referencje do rodzica dla dzieci
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
    }

    private setupBookmarkNode(bookmark: Bookmark) {
        this.tooltip = this.getBookmarkTooltip(bookmark);

        // Najpierw sprawdzamy, czy to odnośnik do pliku źródłowego
        if (
            this.parent &&
            this.parent.type === BookmarkNodeType.Category &&
            !bookmark.docUri
        ) {
            this.sourceFileReference = true;
            this.label = "Source File";
            this.iconPath = new vscode.ThemeIcon("file-code");
            this.description = `Line ${bookmark.lineNumber + 1}`;
            this.contextValue = "chainGrep.sourceFileRef";
            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
            return;
        }

        if (this.sourceFileReference === true) {
            // Odnośnik do pliku źródłowego powinien pokazywać nazwę pliku
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
            this.contextValue = "chainGrep.sourceFileRef";
            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
        } else if (
            bookmark.docUri &&
            bookmark.docUri.startsWith("chaingrep:")
        ) {
            // Pełna informacja dla węzłów Chain Grep
            this.iconPath = new vscode.ThemeIcon("link");

            try {
                // Próbujemy uzyskać informacje o zapytaniu z mapy chainGrepMap
                const chainGrepMap = getChainGrepMap();
                const chainInfo = chainGrepMap.get(bookmark.docUri);

                if (
                    chainInfo &&
                    chainInfo.chain &&
                    chainInfo.chain.length > 0
                ) {
                    // Mamy informacje o łańcuchu zapytań - użyjmy ostatniego zapytania
                    const lastQuery =
                        chainInfo.chain[chainInfo.chain.length - 1];
                    const queryType = lastQuery.type;
                    const query =
                        lastQuery.query.substring(0, 15) +
                        (lastQuery.query.length > 15 ? "..." : "");
                    this.label = `[${
                        queryType === "text" ? "T" : "R"
                    }] "${query}"`;
                    this.description = `Line ${bookmark.lineNumber + 1}`;
                } else {
                    // Jeśli nie mamy informacji, wyświetlamy podstawową etykietę
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
            this.contextValue = "chainGrep.bookmark";
        } else {
            // Sprawdzamy, czy to zakładka w uproszczonej strukturze
            if (this.parent && this.parent.type === BookmarkNodeType.FileRoot) {
                // Zakładka jest bezpośrednim dzieckiem węzła pliku (FileRoot) - uproszczona struktura
                if (bookmark.label) {
                    this.label = bookmark.label;
                } else if (bookmark.lineText) {
                    this.label =
                        bookmark.lineText.length > 40
                            ? bookmark.lineText.substring(0, 40) + "..."
                            : bookmark.lineText;
                } else {
                    this.label = "Line " + (bookmark.lineNumber + 1);
                }
                this.iconPath = new vscode.ThemeIcon("bookmark");
            } else if (!bookmark.docUri) {
                // Standardowa struktura z kategoriami - zakładka jako odnośnik do pliku źródłowego
                this.label = "Source File";
                this.iconPath = new vscode.ThemeIcon("file-code");
                this.description = `Line ${bookmark.lineNumber + 1}`;
                this.contextValue = "chainGrep.sourceFileRef";
            }

            this.command = {
                title: "Open Bookmark",
                command: "_chainGrep.openBookmark",
                arguments: [this],
            };
            this.contextValue = "chainGrep.bookmark";
        }
    }

    private setupCategoryNode() {
        if (this.type === BookmarkNodeType.FileRoot) {
            this.iconPath = new vscode.ThemeIcon("file-code");
            this.tooltip = "File with bookmarks";
            this.contextValue = "chainGrep.bookmarkFile";

            // Ustawiamy liczbę zakładek w description
            if (this.children && this.children.length > 0) {
                this.description = `${this.children.length} bookmarks`;
            }
        } else if (this.type === BookmarkNodeType.Category) {
            // Sprawdzamy, czy to specjalny węzeł pliku w uproszczonej strukturze
            if ((this as any).isFileNode === true) {
                this.iconPath = new vscode.ThemeIcon("file-code");
                this.tooltip = "File with bookmarks";
                this.contextValue = "chainGrep.bookmarkFile";

                try {
                    // Próbujemy pobrać nazwę pliku z uri źródłowego
                    const fileName = path.basename(
                        vscode.Uri.parse(this.bookmark.sourceUri).fsPath
                    );
                    this.label = fileName;
                } catch (e) {
                    // Jeśli się nie uda, używamy tego co już jest ustawione
                }

                // Ustawiamy liczbę zakładek w description
                if (this.children && this.children.length > 0) {
                    this.description = `${this.children.length} bookmarks`;
                }
            } else {
                // Standardowy węzeł kategorii zakładek
                this.iconPath = new vscode.ThemeIcon("bookmark");
                this.tooltip = "Bookmark with linked references";
                this.contextValue = "chainGrep.bookmarkCategory";

                if (this.children && this.children.length > 0) {
                    this.description = `${this.children.length} references`;
                }
            }
        }
    }

    private getBookmarkTooltip(bookmark: Bookmark): string {
        let sourcePath = "";
        try {
            sourcePath = bookmark.sourceUri
                ? vscode.Uri.parse(bookmark.sourceUri).fsPath
                : "";
            sourcePath = path.basename(sourcePath);
        } catch {
            sourcePath = bookmark.sourceUri;
        }

        const lines = [];

        // Add bookmark line with line number
        lines.push(`Line ${bookmark.lineNumber + 1}: ${bookmark.lineText}`);
        lines.push("");

        // Add file information
        lines.push(`File: ${sourcePath}`);

        // Add creation time
        if (bookmark.timestamp) {
            const date = new Date(bookmark.timestamp);
            lines.push(`Created: ${date.toLocaleString()}`);
        }

        // Dodaj informację o indeksie wystąpienia, jeśli istnieje
        if (bookmark.context?.occurrenceIndex !== undefined) {
            lines.push(`Occurrence: ${bookmark.context.occurrenceIndex + 1}`);
        }

        return lines.join("\n");
    }

    private getBookmarkDescription(bookmark: Bookmark): string {
        // Dla węzła pliku źródłowego (główny węzeł)
        if (this.type === BookmarkNodeType.FileRoot) {
            // Description jest już ustawiony w setupCategoryNode
            return "";
        }

        // Dla węzła odniesienia do pliku źródłowego wewnątrz zakładki
        if (this.sourceFileReference) {
            return `Line ${bookmark.lineNumber + 1}`;
        }

        // Dla zwykłych zakładek (liści w drzewie)
        if (this.type === BookmarkNodeType.Bookmark) {
            // Dla zakładek w uproszczonej strukturze (bezpośrednich dzieci FileRoot) wyświetlamy treść linii
            if (!bookmark.docUri || bookmark.docUri === "") {
                // Jeśli to odnośnik do pliku źródłowego w kategorii, zawsze wyświetlamy "Source File"
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
            // Dla innych węzłów Bookmark (jak Chain Grep) etykiety są ustawiane później w setupBookmarkNode
            return "";
        }
        // Dla węzłów kategorii zakładek
        else if (this.type === BookmarkNodeType.Category) {
            return "";
        }

        return "";
    }
}

function getBookmarkLabel(bookmark: Bookmark, type: BookmarkNodeType): string {
    if (type === BookmarkNodeType.FileRoot) {
        try {
            const parsedUri = vscode.Uri.parse(bookmark.sourceUri);
            const fileName = path.basename(parsedUri.fsPath);
            // Dla węzła pliku zwracamy tylko nazwę pliku, informacja o liczbie zakładek jest w description
            return fileName;
        } catch {
            return path.basename(bookmark.sourceUri);
        }
    } else if (type === BookmarkNodeType.Category) {
        // Sprawdzamy, czy to węzeł pliku w uproszczonej strukturze
        // Nie możemy tu sprawdzić właściwości isFileNode, bo funkcja jest wywoływana przed jej ustawieniem
        // Dlatego po prostu zwracamy treść linii, a właściwa nazwa pliku będzie ustawiona później w setupCategoryNode

        // Dla węzła kategorii (zakładki) używamy jej etykiety lub treści linii
        if (bookmark.label) {
            return bookmark.label;
        }

        // Truncate long line text for better display
        return bookmark.lineText.length > 60
            ? bookmark.lineText.substring(0, 57) + "..."
            : bookmark.lineText;
    } else if (type === BookmarkNodeType.Bookmark) {
        // Dla zakładek w uproszczonej strukturze (bezpośrednich dzieci FileRoot) wyświetlamy treść linii
        if (!bookmark.docUri || bookmark.docUri === "") {
            // Jeśli to odnośnik do pliku źródłowego w kategorii, zawsze wyświetlamy "Source File"
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
        // Dla innych węzłów Bookmark (jak Chain Grep) etykiety są ustawiane później w setupBookmarkNode
        return "";
    } else {
        return "";
    }
}
