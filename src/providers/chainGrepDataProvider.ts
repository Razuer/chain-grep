import * as vscode from "vscode";
import { ChainGrepNode } from "../models/chainGrepNode";
import { ChainGrepQuery } from "../models/interfaces";

export class ChainGrepDataProvider implements vscode.TreeDataProvider<ChainGrepNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<ChainGrepNode | undefined | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<ChainGrepNode | undefined | void> = this._onDidChangeTreeData.event;

    private fileRoots: Map<string, ChainGrepNode> = new Map();
    private docUriToNode: Map<string, ChainGrepNode> = new Map();

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ChainGrepNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: ChainGrepNode): Thenable<ChainGrepNode[]> {
        if (!element) {
            const roots = Array.from(this.fileRoots.values());
            return Promise.resolve(roots);
        } else {
            return Promise.resolve(element.children);
        }
    }

    addRootChain(sourceUri: string, label: string, chain: ChainGrepQuery[], docUri: string) {
        let root = this.fileRoots.get(sourceUri);
        if (!root) {
            const filename = this.extractFilenameFromUri(sourceUri);
            root = new ChainGrepNode(
                filename,
                vscode.TreeItemCollapsibleState.Expanded,
                [],
                vscode.Uri.parse(sourceUri)
            );
            this.fileRoots.set(sourceUri, root);
        }

        const lastQuery = chain[chain.length - 1];
        const prefix = lastQuery && lastQuery.type === "text" ? "[T]" : "[R]";

        let flagsStr = "";
        if (lastQuery) {
            const flags: string[] = [];
            if (lastQuery.inverted) {
                flags.push("invert");
            }
            if (lastQuery.caseSensitive) {
                flags.push("case");
            }
            if (flags.length) {
                flagsStr = ` (${flags.join(", ")})`;
            }
        }

        const displayLabel = `${prefix} "${label}"${flagsStr}`;

        const childNode = new ChainGrepNode(
            displayLabel,
            vscode.TreeItemCollapsibleState.None,
            chain,
            vscode.Uri.parse(sourceUri),
            root,
            docUri
        );
        this.docUriToNode.set(docUri, childNode);
        root.children.push(childNode);
        root.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
        this.refresh();
    }

    addSubChain(parentDocUri: string, label: string, chain: ChainGrepQuery[], docUri: string) {
        const parentNode = this.docUriToNode.get(parentDocUri);
        if (!parentNode) {
            this.addRootChain(parentDocUri, label, chain, docUri);
            return;
        }
        parentNode.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;

        const lastQuery = chain[chain.length - 1];
        const prefix = lastQuery && lastQuery.type === "text" ? "[T]" : "[R]";

        let flagsStr = "";
        if (lastQuery) {
            const flags: string[] = [];
            if (lastQuery.inverted) {
                flags.push("invert");
            }
            if (lastQuery.caseSensitive) {
                flags.push("case");
            }
            if (flags.length) {
                flagsStr = ` (${flags.join(", ")})`;
            }
        }

        const displayLabel = `${prefix} "${label}"${flagsStr}`;

        const childNode = new ChainGrepNode(
            displayLabel,
            vscode.TreeItemCollapsibleState.None,
            chain,
            parentNode.sourceUri,
            parentNode,
            docUri
        );
        this.docUriToNode.set(docUri, childNode);
        parentNode.children.push(childNode);
        this.refresh();
    }

    removeNode(node: ChainGrepNode) {
        const nodesToRemove = this.collectNodeAndDescendants(node);

        for (const nodeToRemove of nodesToRemove) {
            if (nodeToRemove.docUri) {
                this.docUriToNode.delete(nodeToRemove.docUri);
            }
        }

        if (node.parent) {
            node.parent.children = node.parent.children.filter((c) => c !== node);

            if (node.parent.children.length === 0) {
                node.parent.collapsibleState = vscode.TreeItemCollapsibleState.None;
            }
        } else if (node.docUri === undefined) {
            for (const [key, val] of this.fileRoots.entries()) {
                if (val === node) {
                    this.fileRoots.delete(key);
                    break;
                }
            }
        }

        this.refresh();
    }

    private collectNodeAndDescendants(node: ChainGrepNode): ChainGrepNode[] {
        const result: ChainGrepNode[] = [node];
        for (const child of node.children) {
            result.push(...this.collectNodeAndDescendants(child));
        }
        return result;
    }

    private extractFilenameFromUri(uriStr: string): string {
        try {
            const u = vscode.Uri.parse(uriStr);
            const segments = u.path.split("/");
            return segments[segments.length - 1] || uriStr;
        } catch {
            return uriStr;
        }
    }

    getAllRoots(): ChainGrepNode[] {
        return Array.from(this.fileRoots.values());
    }
}
