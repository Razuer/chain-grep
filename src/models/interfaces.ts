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

export interface Bookmark {
    id: string;
    lineNumber: number;
    lineText: string;
    docUri: string;
    sourceUri: string;
    label?: string;
    timestamp: number;
    linkedBookmarkId?: string;

    context?: {
        beforeLines?: string[];
        afterLines?: string[];
        occurrenceIndex?: number;
        relativePosition?: number;
    };
}
