import * as vscode from "vscode";
import { ChainGrepQuery } from "./interfaces";

export class ChainGrepNode extends vscode.TreeItem {
    children: ChainGrepNode[] = [];
    parent?: ChainGrepNode;
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
    docUri?: string;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        chain: ChainGrepQuery[],
        sourceUri: vscode.Uri,
        parent?: ChainGrepNode,
        docUri?: string
    ) {
        super(label, collapsibleState);
        this.chain = chain;
        this.sourceUri = sourceUri;
        this.parent = parent;
        this.docUri = docUri;

        if (!docUri) {
            this.contextValue = "chainGrep.fileRoot";
            this.command = {
                title: "Open Source",
                command: "_chainGrep.openNode",
                arguments: [this],
            };
        } else {
            this.contextValue = "chainGrep.chainNode";
            this.command = {
                title: "Open Chain",
                command: "_chainGrep.openNode",
                arguments: [this],
            };
        }
    }
}
