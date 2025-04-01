import * as vscode from "vscode";

export enum HighlightNodeType {
    GlobalRoot = "globalRoot",
    FilesRoot = "filesRoot",
    FileItem = "fileItem",
    HighlightItem = "highlightItem",
}

export class HighlightNode extends vscode.TreeItem {
    public readonly children: HighlightNode[] = [];
    public parent?: HighlightNode;

    constructor(
        labelText: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: HighlightNodeType,
        public readonly text?: string,
        public readonly fileUri?: string,
        public readonly colorIndex?: number,
        public readonly isGlobal: boolean = false
    ) {
        super(labelText, collapsibleState);
        this.setupNodeAppearance();
    }

    addChild(child: HighlightNode) {
        child.parent = this;
        this.children.push(child);
    }

    setDescription(value: string) {
        this.description = value;
    }

    private setupNodeAppearance() {
        this.contextValue = this.type;

        switch (this.type) {
            case HighlightNodeType.GlobalRoot:
                this.iconPath = new vscode.ThemeIcon("globe");
                break;
            case HighlightNodeType.FilesRoot:
                this.iconPath = new vscode.ThemeIcon("files");
                break;
            case HighlightNodeType.FileItem:
                this.iconPath = new vscode.ThemeIcon("file");
                this.contextValue = HighlightNodeType.FileItem;
                if (this.children.length > 0) {
                    this.description = `${this.children.length} highlight${this.children.length !== 1 ? "s" : ""}`;
                }
                break;
            case HighlightNodeType.HighlightItem:
                this.contextValue = this.isGlobal ? "globalHighlightItem" : "fileHighlightItem";
                this.iconPath = new vscode.ThemeIcon("whole-word");
                this.description = "";
                this.tooltip = this.getTooltip();
                this.command = undefined;
                break;
        }
    }

    private getTooltip(): string {
        if (!this.text) {
            return "";
        }

        const lines = [`Highlight: "${this.text}"`];

        if (this.isGlobal) {
            lines.push("Type: Global highlight");
        } else if (this.fileUri) {
            try {
                const uri = vscode.Uri.parse(this.fileUri);
                const fileName = uri.path.split("/").pop() || this.fileUri;
                lines.push(`File: ${fileName}`);
            } catch {
                lines.push(`File: ${this.fileUri}`);
            }
            lines.push("Type: File-specific highlight");
        }

        return lines.join("\n");
    }
}
