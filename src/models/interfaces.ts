import * as vscode from "vscode";

export interface ChainGrepQuery {
    type: "text" | "regex";
    query: string;
    flags?: string;
    inverted: boolean;
    caseSensitive?: boolean;
}

export interface ChainGrepChain {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
}

export interface LocalHighlightState {
    decorations: vscode.TextEditorDecorationType[];
    words: (string | undefined)[];
    next: number;
}
