import * as vscode from "vscode";
import * as path from "path";
import { HighlightNode, HighlightNodeType } from "../models/highlightNode";
import {
    getGlobalHighlights,
    getLocalHighlightMap,
    removeHighlightForTextGlobal,
    clearHighlightsLocal,
    getLocalHighlightKey,
    getExistingLocalHighlightState,
    clearHighlightsGlobal,
    getHighlightColor,
} from "../services/highlightService";

export class HighlightProvider implements vscode.TreeDataProvider<HighlightNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<HighlightNode | undefined | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<HighlightNode | undefined | void> = this._onDidChangeTreeData.event;

    private globalRootNode: HighlightNode;
    private filesRootNode: HighlightNode;

    constructor(private chainGrepMap: Map<string, any>) {
        this.globalRootNode = new HighlightNode(
            "Global Highlights",
            vscode.TreeItemCollapsibleState.Collapsed,
            HighlightNodeType.GlobalRoot
        );

        this.filesRootNode = new HighlightNode(
            "File Highlights",
            vscode.TreeItemCollapsibleState.Collapsed,
            HighlightNodeType.FilesRoot
        );

        this.updateNodeDescriptions();
    }

    refresh(): void {
        this.updateNodeDescriptions();
        this._onDidChangeTreeData.fire();
    }

    private updateNodeDescriptions(): void {
        const globalHighlights = getGlobalHighlights();
        const globalCount = globalHighlights ? globalHighlights.filter((h) => h !== undefined).length : 0;
        this.globalRootNode.setDescription(
            globalCount > 0 ? `${globalCount} highlight${globalCount !== 1 ? "s" : ""}` : ""
        );

        const localHighlightMap = getLocalHighlightMap();

        if (!localHighlightMap || localHighlightMap.size === 0) {
            this.filesRootNode.setDescription("");
            return;
        }

        let filesWithHighlights = 0;
        for (const [_, highlightState] of localHighlightMap.entries()) {
            if (highlightState && highlightState.words) {
                const hasHighlights = highlightState.words.some((word) => word !== undefined);
                if (hasHighlights) {
                    filesWithHighlights++;
                }
            }
        }

        this.filesRootNode.setDescription(
            filesWithHighlights > 0 ? `${filesWithHighlights} file${filesWithHighlights !== 1 ? "s" : ""}` : ""
        );
    }

    getTreeItem(element: HighlightNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HighlightNode): Thenable<HighlightNode[]> {
        if (!element) {
            return Promise.resolve([this.globalRootNode, this.filesRootNode]);
        }

        if (element === this.globalRootNode) {
            return Promise.resolve(this.buildGlobalHighlightNodes());
        }

        if (element === this.filesRootNode) {
            return Promise.resolve(this.buildFileHighlightNodes());
        }

        if (element.type === HighlightNodeType.FileItem) {
            return Promise.resolve(element.children);
        }

        return Promise.resolve([]);
    }

    getParent(element: HighlightNode): vscode.ProviderResult<HighlightNode> {
        return element.parent;
    }

    private buildGlobalHighlightNodes(): HighlightNode[] {
        const globalHighlights = getGlobalHighlights();
        if (!globalHighlights || globalHighlights.length === 0) {
            return [];
        }

        const nodes: HighlightNode[] = [];
        for (let i = 0; i < globalHighlights.length; i++) {
            const highlightText = globalHighlights[i];
            if (highlightText) {
                const node = new HighlightNode(
                    highlightText,
                    vscode.TreeItemCollapsibleState.None,
                    HighlightNodeType.HighlightItem,
                    highlightText,
                    undefined,
                    i,
                    true
                );
                nodes.push(node);
            }
        }
        return nodes;
    }

    private buildFileHighlightNodes(): HighlightNode[] {
        const localHighlightMap = getLocalHighlightMap();
        if (!localHighlightMap || localHighlightMap.size === 0) {
            return [];
        }

        const fileNodes: HighlightNode[] = [];

        for (const [docUri, highlightState] of localHighlightMap.entries()) {
            if (!highlightState || !highlightState.words || highlightState.words.length === 0) {
                continue;
            }

            const fileHighlights = highlightState.words.filter((word) => word !== undefined);
            if (fileHighlights.length === 0) {
                continue;
            }

            let fileName = docUri;
            try {
                const uri = vscode.Uri.parse(docUri);
                fileName = path.basename(uri.path);
            } catch (error) {}

            const fileNode = new HighlightNode(
                fileName,
                vscode.TreeItemCollapsibleState.Collapsed,
                HighlightNodeType.FileItem,
                undefined,
                docUri
            );

            for (let i = 0; i < highlightState.words.length; i++) {
                const word = highlightState.words[i];
                if (word) {
                    const highlightNode = new HighlightNode(
                        word,
                        vscode.TreeItemCollapsibleState.None,
                        HighlightNodeType.HighlightItem,
                        word,
                        docUri,
                        i,
                        false
                    );
                    fileNode.addChild(highlightNode);
                }
            }

            fileNode.setDescription(
                `${fileNode.children.length} highlight${fileNode.children.length !== 1 ? "s" : ""}`
            );

            if (fileNode.children.length > 0) {
                fileNodes.push(fileNode);
            }
        }

        return fileNodes;
    }

    public removeGlobalHighlight(node: HighlightNode): void {
        if (node.text) {
            removeHighlightForTextGlobal(node.text);
            this.refresh();
        }
    }

    public clearAllGlobalHighlights(): void {
        clearHighlightsGlobal(true);
        this.refresh();
    }

    public removeFileHighlight(node: HighlightNode): void {
        if (node.text && node.fileUri) {
            const docUri = node.fileUri;
            const editor = this.findEditorForUri(docUri);

            if (editor) {
                const groupKey = getLocalHighlightKey(docUri, this.chainGrepMap);
                const state = getExistingLocalHighlightState(groupKey);

                if (state) {
                    const index = state.words.indexOf(node.text);
                    if (index !== -1) {
                        state.words[index] = undefined;
                        editor.setDecorations(state.decorations[index], []);
                    }
                }
            } else {
                const groupKey = getLocalHighlightKey(docUri, this.chainGrepMap);
                const state = getExistingLocalHighlightState(groupKey);

                if (state) {
                    const index = state.words.indexOf(node.text);
                    if (index !== -1) {
                        state.words[index] = undefined;
                    }
                }
            }

            this.refresh();
        }
    }

    public clearFileHighlights(node: HighlightNode): void {
        if (node.fileUri) {
            const docUri = node.fileUri;
            const editor = this.findEditorForUri(docUri);
            if (editor) {
                clearHighlightsLocal(editor, this.chainGrepMap);
            } else {
                const groupKey = getLocalHighlightKey(docUri, this.chainGrepMap);
                const state = getExistingLocalHighlightState(groupKey);
                if (state) {
                    state.words.fill(undefined);
                }
            }
            this.refresh();
        }
    }

    private findEditorForUri(uriStr: string): vscode.TextEditor | undefined {
        const uri = vscode.Uri.parse(uriStr);
        return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString());
    }
}
