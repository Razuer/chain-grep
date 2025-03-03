import * as vscode from "vscode";
import * as path from "path";

interface ChainGrepQuery {
    type: "text" | "regex";
    query: string;
    flags?: string;
    inverted: boolean;
    caseSensitive?: boolean;
}

interface ChainGrepChain {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
}

interface LocalHighlightState {
    decorations: vscode.TextEditorDecorationType[];
    words: (string | undefined)[];
    next: number;
}

class ChainGrepNode extends vscode.TreeItem {
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

class ChainGrepDataProvider implements vscode.TreeDataProvider<ChainGrepNode> {
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
        savePersistentState();
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
        savePersistentState();
    }

    removeNode(node: ChainGrepNode) {
        const nodesToRemove = this.collectNodeAndDescendants(node);

        for (const nodeToRemove of nodesToRemove) {
            if (nodeToRemove.docUri) {
                this.docUriToNode.delete(nodeToRemove.docUri);
                chainGrepMap.delete(nodeToRemove.docUri);
                chainGrepContents.delete(nodeToRemove.docUri);
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
        savePersistentState();
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

class ChainGrepFSProvider implements vscode.FileSystemProvider {
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
    private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;

    private initialized = false;
    private pendingRequests: vscode.Uri[] = [];

    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }

    public markInitialized(): void {
        this.initialized = true;
        for (const uri of this.pendingRequests) {
            this._onDidChangeFile.fire([
                {
                    type: vscode.FileChangeType.Created,
                    uri,
                },
            ]);
        }
        this.pendingRequests = [];
    }

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const content = chainGrepContents.get(uri.toString());

        if (content === undefined) {
            if (!this.initialized) {
                this.pendingRequests.push(uri);
                return {
                    type: vscode.FileType.File,
                    ctime: Date.now(),
                    mtime: Date.now(),
                    size: 0,
                };
            }
            throw vscode.FileSystemError.FileNotFound();
        }

        return toStat(content);
    }

    readDirectory(_uri: vscode.Uri): [string, vscode.FileType][] {
        return [];
    }

    createDirectory(_uri: vscode.Uri): void {}

    readFile(uri: vscode.Uri): Uint8Array {
        const content = chainGrepContents.get(uri.toString());

        if (!content && chainGrepMap.has(uri.toString())) {
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Restoring Chain Grep results...",
                    cancellable: false,
                },
                async () => {
                    const chainInfo = chainGrepMap.get(uri.toString())!;
                    const { lines, stats } = await executeChainSearch(chainInfo.sourceUri, chainInfo.chain);
                    const header = buildChainDetailedHeader(chainInfo.chain, stats);
                    let newContent = "";
                    if (isDetailedChainDocEnabled()) {
                        newContent = header + "\n\n" + lines.join("\n");
                    } else {
                        newContent = lines.join("\n");
                    }
                    chainGrepContents.set(uri.toString(), newContent);
                    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
                }
            );

            return Buffer.from("Loading Chain Grep results...", "utf8");
        }

        if (!content) {
            throw vscode.FileSystemError.FileNotFound();
        }

        return Buffer.from(content, "utf8");
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): void {
        chainGrepContents.set(uri.toString(), Buffer.from(content).toString("utf8"));
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(uri: vscode.Uri, _options: { recursive: boolean }): void {
        chainGrepContents.delete(uri.toString());
        chainGrepMap.delete(uri.toString());
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {}
}

const CHAIN_GREP_SCHEME = "chaingrep";
const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

let extensionContext: vscode.ExtensionContext;
let globalHighlightDecorations: vscode.TextEditorDecorationType[] = [];
let globalHighlightWords: (string | undefined)[] = [];
let globalNextHighlight = 0;

const chainGrepMap: Map<string, ChainGrepChain> = new Map();
const chainGrepContents: Map<string, string> = new Map();
const localHighlightMap = new Map<string, LocalHighlightState>();
const chainGrepProvider = new ChainGrepDataProvider();

function loadConfiguredPalette(): string {
    const config = vscode.workspace.getConfiguration("chainGrep");
    const userPalette = config.get<string>("colours");
    if (userPalette && userPalette.trim()) {
        return userPalette;
    } else {
        return DEFAULT_COLOURS;
    }
}

function areRandomColorsEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("randomColors") === true;
}

function isDetailedChainDocEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("detailedChainDoc") === true;
}

function isCleanupLoggingEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("cleanupLogging") === true;
}

function isChainGrepUri(uri: string | vscode.Uri): boolean {
    if (typeof uri === "string") {
        return uri.startsWith(`${CHAIN_GREP_SCHEME}:/`);
    } else {
        return uri.scheme === CHAIN_GREP_SCHEME;
    }
}

function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function debounce<F extends (...args: any[]) => any>(func: F, waitFor: number): (...args: Parameters<F>) => void {
    let timeout: NodeJS.Timeout | null = null;

    return function (...args: Parameters<F>): void {
        if (timeout !== null) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), waitFor);
    };
}

const debouncedSavePersistentState = debounce(() => {
    const chainData = Array.from(chainGrepMap.entries()).map(([uri, data]) => [
        uri,
        { chain: data.chain, sourceUri: data.sourceUri.toString() },
    ]);
    const contentsData = Array.from(chainGrepContents.entries());

    const persistentHighlights = {
        globalHighlightWords,
        localHighlights: Array.from(localHighlightMap.entries()).map(([key, state]) => [
            key,
            { words: state.words, next: state.next },
        ]),
    };

    extensionContext.workspaceState.update("chainGrepState", {
        chainData,
        contentsData,
        persistentHighlights,
    });

    console.log("Chain Grep: State saved");
}, 1000);

function savePersistentState() {
    debouncedSavePersistentState();
}

function loadPersistentState(context: vscode.ExtensionContext) {
    const stored = context.workspaceState.get<any>("chainGrepState");
    if (!stored) {
        return;
    }

    if (stored.chainData) {
        for (const [uri, data] of stored.chainData) {
            chainGrepMap.set(uri, {
                chain: data.chain,
                sourceUri: vscode.Uri.parse(data.sourceUri),
            });
        }
    }
    if (stored.contentsData) {
        for (const [uri, content] of stored.contentsData) {
            chainGrepContents.set(uri, content);
        }
    }
    if (stored.persistentHighlights) {
        if (stored.persistentHighlights.globalHighlightWords) {
            globalHighlightWords = stored.persistentHighlights.globalHighlightWords;
        }
        if (stored.persistentHighlights.localHighlights) {
            for (const [key, stateObj] of stored.persistentHighlights.localHighlights) {
                const state = getLocalHighlightState(key);
                state.words = stateObj.words;
                state.next = stateObj.next;
            }
        }
    }

    rebuildTreeViewFromState();
}

function rebuildTreeViewFromState() {
    const entriesBySource = new Map<string, Map<string, ChainGrepQuery[]>>();

    for (const [docUri, chainInfo] of chainGrepMap.entries()) {
        const sourceUriStr = chainInfo.sourceUri.toString();
        if (!entriesBySource.has(sourceUriStr)) {
            entriesBySource.set(sourceUriStr, new Map());
        }
        entriesBySource.get(sourceUriStr)!.set(docUri, chainInfo.chain);
    }

    for (const [sourceUriStr, docEntries] of entriesBySource.entries()) {
        const docEntryPairs = Array.from(docEntries.entries());

        docEntryPairs.sort((a, b) => a[1].length - b[1].length);

        for (const [docUri, chain] of docEntryPairs) {
            const lastQuery = chain[chain.length - 1];
            const label = lastQuery ? lastQuery.query : "Unknown";

            let bestParentDocUri = "";
            let maxMatchLength = 0;

            for (const [otherDocUri, otherChain] of docEntries) {
                if (otherDocUri !== docUri && chain.length > otherChain.length && otherChain.length > maxMatchLength) {
                    let isPrefix = true;
                    for (let i = 0; i < otherChain.length; i++) {
                        if (JSON.stringify(otherChain[i]) !== JSON.stringify(chain[i])) {
                            isPrefix = false;
                            break;
                        }
                    }

                    if (isPrefix) {
                        maxMatchLength = otherChain.length;
                        bestParentDocUri = otherDocUri;
                    }
                }
            }

            if (bestParentDocUri) {
                chainGrepProvider.addSubChain(bestParentDocUri, label, chain, docUri);
            } else {
                chainGrepProvider.addRootChain(sourceUriStr, label, chain, docUri);
            }
        }
    }

    chainGrepProvider.refresh();
}

function toStat(content: string): vscode.FileStat {
    return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: Buffer.byteLength(content, "utf8"),
    };
}

function initGlobalHighlightDecorations() {
    let palette = loadConfiguredPalette();
    let globalColoursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );
    if (areRandomColorsEnabled()) {
        globalColoursArr = shuffleArray(globalColoursArr);
    }
    globalHighlightDecorations = [];
    globalHighlightWords = [];

    globalColoursArr.forEach(([bg, fg]) => {
        globalHighlightDecorations.push(
            vscode.window.createTextEditorDecorationType({
                backgroundColor: bg,
                color: fg,
                borderRadius: "4px",
            })
        );
        globalHighlightWords.push(undefined);
    });

    globalNextHighlight = globalHighlightDecorations.length - 1;
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chooseNextGlobalHighlight(): number {
    let idx = globalNextHighlight;
    const start = globalNextHighlight;
    do {
        if (!globalHighlightWords[idx]) {
            globalNextHighlight = idx - 1;
            if (globalNextHighlight < 0) {
                globalNextHighlight = globalHighlightDecorations.length - 1;
            }
            return idx;
        }
        idx -= 1;
        if (idx < 0) {
            idx = globalHighlightDecorations.length - 1;
        }
    } while (idx !== start);

    const ret = globalNextHighlight;
    globalNextHighlight = ret - 1;
    if (globalNextHighlight < 0) {
        globalNextHighlight = globalHighlightDecorations.length - 1;
    }
    return ret;
}

function addHighlightGlobal(editor: vscode.TextEditor, text: string) {
    removeHighlightForTextGlobal(text);
    const idx = chooseNextGlobalHighlight();
    globalHighlightWords[idx] = text;
    applyHighlightForTextGlobal(editor, text, idx);
    savePersistentState();
}

function applyHighlightForTextGlobal(editor: vscode.TextEditor, text: string, idx: number) {
    const fullText = editor.document.getText();
    const regex = new RegExp(escapeRegExp(text), "g");
    const decorationOptions: vscode.DecorationOptions[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fullText)) !== null) {
        const startPos = editor.document.positionAt(match.index);
        const endPos = editor.document.positionAt(match.index + text.length);
        decorationOptions.push({ range: new vscode.Range(startPos, endPos) });
    }
    editor.setDecorations(globalHighlightDecorations[idx], decorationOptions);
}

function removeHighlightForTextGlobal(text: string) {
    const idx = globalHighlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }
    for (const ed of vscode.window.visibleTextEditors) {
        ed.setDecorations(globalHighlightDecorations[idx], []);
    }
    globalHighlightWords[idx] = undefined;
    savePersistentState();
}

function toggleHighlightGlobal() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selectionText = getSelectedTextOrWord(editor);
    if (!selectionText) {
        return;
    }

    const idx = globalHighlightWords.findIndex((w) => w === selectionText);
    if (idx === -1) {
        addHighlightGlobal(editor, selectionText);
    } else {
        removeHighlightForTextGlobal(selectionText);
    }
    reapplyAllGlobalHighlights();
}

function clearHighlightsGlobal(showMessage = true) {
    if (globalHighlightWords.every((w) => w === undefined)) {
        if (showMessage) {
            vscode.window.showInformationMessage("Chain Grep: No global highlights to clear");
        }
        return;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        globalHighlightDecorations.forEach((dec) => {
            ed.setDecorations(dec, []);
        });
    }
    globalHighlightWords.fill(undefined);
    globalNextHighlight = globalHighlightDecorations.length - 1;
    savePersistentState();

    if (showMessage) {
        vscode.window.showInformationMessage("Chain Grep: Cleared all global highlights");
    }
}

function reapplyAllGlobalHighlights() {
    for (const ed of vscode.window.visibleTextEditors) {
        reapplyHighlightsGlobal(ed);
    }
}

function reapplyHighlightsGlobal(editor: vscode.TextEditor) {
    const fullText = editor.document.getText();
    const wordsWithIndex = globalHighlightWords.map((word, idx) => ({ word, idx })).filter((item) => item.word);
    if (!wordsWithIndex.length) {
        return;
    }
    const pattern = "(" + wordsWithIndex.map((item) => escapeRegExp(item.word!)).join("|") + ")";
    const regex = new RegExp(pattern, "g");
    const decorationOptions: { [idx: number]: vscode.DecorationOptions[] } = {};
    for (const item of wordsWithIndex) {
        decorationOptions[item.idx] = [];
    }
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fullText)) !== null) {
        const matchedText = match[0];
        const i = globalHighlightWords.findIndex((w) => w === matchedText);
        if (i !== -1) {
            const startPos = editor.document.positionAt(match.index);
            const endPos = editor.document.positionAt(match.index + matchedText.length);
            decorationOptions[i].push({
                range: new vscode.Range(startPos, endPos),
            });
        }
    }
    for (const idxStr in decorationOptions) {
        const i = Number(idxStr);
        editor.setDecorations(globalHighlightDecorations[i], decorationOptions[i]);
    }
}

function getSelectedTextOrWord(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;
    if (!selection.isEmpty) {
        return editor.document.getText(selection);
    }
    const wordRange = editor.document.getWordRangeAtPosition(selection.start);
    return wordRange ? editor.document.getText(wordRange) : undefined;
}

function getLocalHighlightState(groupKey: string): LocalHighlightState {
    let existing = localHighlightMap.get(groupKey);
    if (!existing) {
        const newDecs = createHighlightDecorationsFromColours();
        existing = {
            decorations: newDecs,
            words: new Array(newDecs.length).fill(undefined),
            next: 0,
        };
        localHighlightMap.set(groupKey, existing);
    }
    return existing;
}

function createHighlightDecorationsFromColours(): vscode.TextEditorDecorationType[] {
    let palette = loadConfiguredPalette();
    let coloursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );
    if (areRandomColorsEnabled()) {
        coloursArr = shuffleArray(coloursArr);
    }
    return coloursArr.map(([bg, fg]) =>
        vscode.window.createTextEditorDecorationType({
            backgroundColor: bg,
            color: fg,
            borderRadius: "4px",
        })
    );
}

function getLocalHighlightKey(docUri: string): string {
    if (chainGrepMap.has(docUri)) {
        const chainInfo = chainGrepMap.get(docUri)!;
        return chainInfo.sourceUri.toString();
    }
    return docUri;
}

function chooseNextLocalHighlight(state: LocalHighlightState): number {
    const start = state.next;
    let idx = start;
    do {
        if (!state.words[idx]) {
            return idx;
        }
        idx = (idx + 1) % state.decorations.length;
    } while (idx !== start);
    return idx;
}

function addHighlightLocal(editor: vscode.TextEditor, text: string) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);
    removeHighlightForTextLocal(docUri, text);
    const idx = chooseNextLocalHighlight(state);
    state.words[idx] = text;
    state.next = (idx + 1) % state.decorations.length;
    applyHighlightForTextLocal(editor, text, idx);
    savePersistentState();
}

function applyHighlightForTextLocal(editor: vscode.TextEditor, text: string, idx: number) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);

    function decorateSingle(ed: vscode.TextEditor) {
        if (getLocalHighlightKey(ed.document.uri.toString()) !== groupKey) {
            return;
        }
        const fullText = ed.document.getText();
        const regex = new RegExp(escapeRegExp(text), "g");
        const decoOpts: vscode.DecorationOptions[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(fullText)) !== null) {
            const startPos = ed.document.positionAt(match.index);
            const endPos = ed.document.positionAt(match.index + text.length);
            decoOpts.push({ range: new vscode.Range(startPos, endPos) });
        }
        ed.setDecorations(state.decorations[idx], decoOpts);
    }

    decorateSingle(editor);

    for (const ed of vscode.window.visibleTextEditors) {
        if (ed === editor) {
            continue;
        }
        if (getLocalHighlightKey(ed.document.uri.toString()) === groupKey) {
            decorateSingle(ed);
        }
    }
}

function removeHighlightForTextLocal(docUri: string, text: string) {
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);
    const idx = state.words.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        if (getLocalHighlightKey(ed.document.uri.toString()) === groupKey) {
            ed.setDecorations(state.decorations[idx], []);
        }
    }
    state.words[idx] = undefined;
    state.next = idx;
    savePersistentState();
}

function toggleHighlightLocal() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const text = getSelectedTextOrWord(editor);
    if (!text) {
        return;
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);
    const idx = state.words.findIndex((w) => w === text);
    if (idx === -1) {
        addHighlightLocal(editor, text);
    } else {
        removeHighlightForTextLocal(docUri, text);
    }
}

function clearHighlightsLocal() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);

    for (const ed of vscode.window.visibleTextEditors) {
        if (getLocalHighlightKey(ed.document.uri.toString()) === groupKey) {
            state.decorations.forEach((dec) => {
                ed.setDecorations(dec, []);
            });
        }
    }

    state.words.fill(undefined);
    state.next = 0;
    savePersistentState();
}

function reapplyHighlightsLocal(editor: vscode.TextEditor) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);

    for (let i = 0; i < state.words.length; i++) {
        const w = state.words[i];
        if (w) {
            applyHighlightForTextLocal(editor, w, i);
        }
    }
}

function applyHighlightsToOpenEditors() {
    reapplyAllGlobalHighlights();

    for (const editor of vscode.window.visibleTextEditors) {
        reapplyHighlightsLocal(editor);
    }

    console.log("Chain Grep: Applied saved highlights to open editors");
}

async function validateChain(queries: ChainGrepQuery[]): Promise<string[]> {
    const errors: string[] = [];
    queries.forEach((q, index) => {
        if (q.type === "regex") {
            let flags = q.flags || "";
            if (!flags.includes("s")) {
                flags += "s";
                q.flags = flags;
            }
            try {
                new RegExp(q.query, flags);
            } catch {
                errors.push(`Step ${index + 1}: Invalid regex '${q.query}' with flags '${flags}'`);
            }
        }
    });
    return errors;
}

async function executeChainSearch(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[]
): Promise<{ lines: string[]; stats: any }> {
    const validationErrors = await validateChain(chain);
    if (validationErrors.length) {
        vscode.window.showInformationMessage("Validation errors found: " + validationErrors.join("; "));
        return { lines: [], stats: {} };
    }

    let sourceDoc: vscode.TextDocument;
    try {
        sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    } catch {
        vscode.window.showInformationMessage("Unable to open source document.");
        return { lines: [], stats: {} };
    }

    const lines: string[] = [];
    for (let i = 0; i < sourceDoc.lineCount; i++) {
        lines.push(sourceDoc.lineAt(i).text);
    }

    let filtered = lines;
    const stats = {
        totalLines: lines.length,
        steps: [] as { step: number; query: string; matchCount: number }[],
    };

    for (let i = 0; i < chain.length; i++) {
        const query = chain[i];
        const before = filtered.length;
        filtered = applyChainQuery(filtered, query);
        stats.steps.push({
            step: i + 1,
            query: query.query,
            matchCount: filtered.length,
        });
    }

    return { lines: filtered, stats };
}

function applyChainQuery(lines: string[], query: ChainGrepQuery): string[] {
    if (query.type === "text") {
        return lines.filter((line) => {
            const textLine = query.caseSensitive ? line : line.toLowerCase();
            const textQuery = query.caseSensitive ? query.query : query.query.toLowerCase();
            const match = textLine.includes(textQuery);
            return query.inverted ? !match : match;
        });
    } else {
        let flags = query.flags || "";
        if (!query.caseSensitive && !flags.includes("i")) {
            flags += "i";
        }
        let regex: RegExp;
        try {
            regex = new RegExp(query.query, flags);
        } catch {
            vscode.window.showInformationMessage("Invalid regular expression in chain.");
            return lines;
        }
        return lines.filter((line) => (query.inverted ? !regex.test(line) : regex.test(line)));
    }
}

function getChainForEditor(editor: vscode.TextEditor): {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
} {
    const docUri = editor.document.uri.toString();
    if (chainGrepMap.has(docUri)) {
        return chainGrepMap.get(docUri)!;
    }
    return { chain: [], sourceUri: editor.document.uri };
}

function buildChainDetailedHeader(chain: ChainGrepQuery[], stats?: any): string {
    const lines: string[] = ["--- Chain Grep Steps ---"];
    chain.forEach((q, i) => {
        let step = `${i + 1}. `;
        if (q.type === "text") {
            step += `[Text] Search for: "${q.query}"`;
        } else {
            step += `[Regex] Search for: "${q.query}"`;
            if (q.flags) {
                step += ` with flags: "${q.flags}"`;
            }
        }
        if (q.inverted) {
            step += " (Inverted)";
        }
        step += q.caseSensitive ? " (Case Sensitive)" : " (Case Insensitive)";

        if (stats && stats.steps && stats.steps[i]) {
            step += ` → ${stats.steps[i].matchCount} matches`;
        }

        lines.push(step);
    });

    if (stats) {
        const finalCount = stats.steps.length > 0 ? stats.steps[stats.steps.length - 1].matchCount : 0;
        lines.push(
            `--- Results: ${finalCount} matches (${((finalCount / stats.totalLines) * 100).toFixed(1)}% of source) ---`
        );
    } else {
        lines.push("-------------------------");
    }

    return lines.join("\n");
}

function buildChainPath(chain: ChainGrepQuery[]): string {
    return chain
        .map((q) => {
            const prefix = q.type === "text" ? "T" : "R";
            const invertMark = q.inverted ? "!" : "";
            const caseMark = q.caseSensitive ? "C" : "";
            let shortQuery = q.query;
            if (shortQuery.length > 15) {
                shortQuery = shortQuery.substring(0, 15) + "...";
            }
            return `${prefix}${invertMark}${caseMark}[${shortQuery}]`;
        })
        .join("->");
}

async function executeChainSearchAndDisplayResults(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    parentDocUri?: string,
    label?: string
) {
    const { lines: results, stats } = await executeChainSearch(sourceUri, chain);
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found.");
    } else {
        vscode.window.setStatusBarMessage(
            `Chain Grep: Found ${results.length} matches (${((results.length / stats.totalLines) * 100).toFixed(
                1
            )}% of source)`,
            5000
        );
    }

    const header = buildChainDetailedHeader(chain, stats);
    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + results.join("\n");
    } else {
        content = results.join("\n");
    }

    const sourceFilename = path.basename(sourceUri.fsPath);
    const extension = path.extname(sourceFilename);
    const baseName = path.basename(sourceFilename, extension);

    const chainDescriptor = buildChainPath(chain);

    let docName = `[${baseName}] : ${chainDescriptor}${extension}`;

    if (docName.length > 60) {
        docName = docName.slice(0, 60) + "..." + extension;
    }

    const docUri = vscode.Uri.parse(`${CHAIN_GREP_SCHEME}:///${docName}`);

    chainGrepContents.set(docUri.toString(), content);
    chainGrepMap.set(docUri.toString(), { chain, sourceUri });

    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
    });
    reapplyHighlightsLocal(editor);

    const nodeLabel = label || chain[chain.length - 1].query;
    if (parentDocUri) {
        chainGrepProvider.addSubChain(parentDocUri, nodeLabel, chain, docUri.toString());
    } else {
        chainGrepProvider.addRootChain(sourceUri.toString(), nodeLabel, chain, docUri.toString());
    }
}

async function executeChainSearchAndUpdateEditor(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[],
    editor: vscode.TextEditor
) {
    const { lines, stats } = await executeChainSearch(sourceUri, chain);
    if (!lines.length) {
        vscode.window.showInformationMessage("No matches found after refresh.");
        return;
    }

    const header = buildChainDetailedHeader(chain, stats);

    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + lines.join("\n");
    } else {
        content = lines.join("\n");
    }

    chainGrepContents.set(editor.document.uri.toString(), content);

    await vscode.commands.executeCommand("workbench.action.files.revert");

    let oldViewColumn = editor.viewColumn || vscode.ViewColumn.One;

    const doc = await vscode.workspace.openTextDocument(editor.document.uri);
    const newEd = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: oldViewColumn,
    });
    reapplyHighlightsLocal(newEd);
}

function isRegexValid(str: string): boolean {
    if (/^\/.*\/?[igm]{0,3}$/.test(str)) {
        return true;
    }
    let slashCount = 0;
    for (let i = 0; i < str.length; i++) {
        if (str.charAt(i) === "/") {
            slashCount++;
        } else {
            if (slashCount === 1) {
                return false;
            }
            slashCount = 0;
        }
    }
    return slashCount !== 1;
}

async function showQueryAndOptionsQuickInput(defaultQuery?: string, searchType: "text" | "regex" = "text") {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = searchType === "text" ? "Chain Grep | Text Search" : "Chain Grep | Regex Search";

    quickPick.placeholder =
        searchType === "text" ? "Enter search query here..." : "Enter regex pattern (e.g. foo|bar, \\bword\\b)...";

    quickPick.ignoreFocusOut = true;

    if (defaultQuery) {
        quickPick.value = defaultQuery;
    }

    let invertSelected = false;
    let caseSensitiveSelected = false;

    quickPick.buttons = [
        {
            iconPath: new vscode.ThemeIcon("arrow-swap"),
            tooltip: "Invert (Off)",
        },
        {
            iconPath: new vscode.ThemeIcon("case-sensitive"),
            tooltip: "Case Sensitive (Off)",
        },
    ];

    quickPick.onDidTriggerButton((button) => {
        if (button.tooltip?.startsWith("Invert")) {
            invertSelected = !invertSelected;
        } else if (button.tooltip?.startsWith("Case Sensitive")) {
            caseSensitiveSelected = !caseSensitiveSelected;
        }

        quickPick.buttons = [
            {
                iconPath: new vscode.ThemeIcon(invertSelected ? "check" : "arrow-swap"),
                tooltip: `Invert (${invertSelected ? "On" : "Off"})`,
            },
            {
                iconPath: new vscode.ThemeIcon(caseSensitiveSelected ? "check" : "case-sensitive"),
                tooltip: `Case Sensitive (${caseSensitiveSelected ? "On" : "Off"})`,
            },
        ];
    });

    return new Promise<{ query: string; options: string[] } | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
            const query = quickPick.value;
            const options: string[] = [];
            if (invertSelected) {
                options.push("Invert");
            }
            if (caseSensitiveSelected) {
                options.push("Case Sensitive");
            }
            quickPick.hide();
            resolve({ query, options });
        });
        quickPick.onDidHide(() => {
            resolve(undefined);
        });
        quickPick.show();
    });
}

async function openNode(node: ChainGrepNode) {
    if (node.docUri) {
        if (!chainGrepContents.has(node.docUri)) {
            const chainDoc = chainGrepMap.get(node.docUri);
            if (chainDoc) {
                vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: "Regenerating chain grep results...",
                        cancellable: false,
                    },
                    async () => {
                        const { chain, sourceUri } = chainDoc;
                        const { lines, stats } = await executeChainSearch(sourceUri, chain);
                        const header = buildChainDetailedHeader(chain, stats);
                        let content = "";
                        if (isDetailedChainDocEnabled()) {
                            content = header + "\n\n" + lines.join("\n");
                        } else {
                            content = lines.join("\n");
                        }
                        chainGrepContents.set(node.docUri!, content);
                        savePersistentState();
                    }
                );
            }
        }

        const docUri = vscode.Uri.parse(node.docUri);
        const doc = await vscode.workspace.openTextDocument(docUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    } else {
        const sourceDoc = await vscode.workspace.openTextDocument(node.sourceUri);
        await vscode.window.showTextDocument(sourceDoc, { preview: false });
    }
}

async function closeNode(node: ChainGrepNode) {
    console.log("ChainGrep: Fully removing node and all data from tree");
    chainGrepProvider.removeNode(node);
}

async function refreshAndOpen(node: ChainGrepNode) {
    if (!node.docUri) {
        vscode.window.showInformationMessage("Can't refresh root node.");
        return;
    }

    const chainDocInfo = chainGrepMap.get(node.docUri);
    if (!chainDocInfo) {
        vscode.window.showInformationMessage("No chain doc info found.");
        return;
    }

    const { chain, sourceUri } = chainDocInfo;

    try {
        const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
        await vscode.window.showTextDocument(sourceDoc, { preview: false });
        await vscode.commands.executeCommand("workbench.action.files.revert");

        const docUri = vscode.Uri.parse(node.docUri);
        const chainDoc = await vscode.workspace.openTextDocument(docUri);
        const newChainEditor = await vscode.window.showTextDocument(chainDoc, {
            preview: false,
        });

        await executeChainSearchAndUpdateEditor(sourceUri, chain, newChainEditor);

        vscode.window.showInformationMessage("Refreshed successfully.");
    } catch {
        vscode.window.showInformationMessage("Unable to refresh the chain doc.");
    }
}

async function recoverFailedChainGrepFiles() {
    const visibleEditors = vscode.window.visibleTextEditors;

    for (const editor of visibleEditors) {
        const uri = editor.document.uri;

        if (uri.scheme === CHAIN_GREP_SCHEME) {
            const content = editor.document.getText();
            if (content === "Loading Chain Grep results..." || content === "") {
                const uriStr = uri.toString();
                if (chainGrepMap.has(uriStr) && !chainGrepContents.has(uriStr)) {
                    const chainInfo = chainGrepMap.get(uriStr)!;

                    vscode.window.showInformationMessage("Recovering Chain Grep file...");

                    const { lines, stats } = await executeChainSearch(chainInfo.sourceUri, chainInfo.chain);
                    const header = buildChainDetailedHeader(chainInfo.chain, stats);
                    let newContent = "";
                    if (isDetailedChainDocEnabled()) {
                        newContent = header + "\n\n" + lines.join("\n");
                    } else {
                        newContent = lines.join("\n");
                    }

                    chainGrepContents.set(uriStr, newContent);

                    await vscode.commands.executeCommand("workbench.action.files.revert");
                }
            }
        }
    }
}

function getCleanupInterval(): number {
    const config = vscode.workspace.getConfiguration("chainGrep");
    const minutes = config.get<number>("cleanupInterval") ?? 5;
    return minutes * 60 * 1000;
}

function cleanupUnusedResources(showNotifications: boolean = false): number {
    const visibleUris = vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString());

    let cleanedCount = 0;

    for (const contentUri of chainGrepContents.keys()) {
        if (!chainGrepMap.has(contentUri) && !visibleUris.includes(contentUri)) {
            chainGrepContents.delete(contentUri);
            cleanedCount++;

            if (isCleanupLoggingEnabled() || showNotifications) {
                console.log(`ChainGrep: Cleaned up orphaned content: ${contentUri}`);
            }
        }
    }

    if (cleanedCount > 0) {
        savePersistentState();

        if (isCleanupLoggingEnabled() || showNotifications) {
            console.log(`ChainGrep: Background cleanup removed ${cleanedCount} orphaned resources`);
        }

        if (showNotifications) {
            vscode.window.showInformationMessage(`Chain Grep: Cleaned up ${cleanedCount} orphaned resources`);
        }
    } else if (showNotifications) {
        vscode.window.showInformationMessage("Chain Grep: No orphaned resources found");
    }

    return cleanedCount;
}

async function closeAllNodes() {
    const roots = Array.from(chainGrepProvider.getAllRoots());

    if (roots.length === 0) {
        vscode.window.showInformationMessage("Chain Grep: No results to clear");
        return;
    }

    for (const node of roots) {
        chainGrepProvider.removeNode(node);
    }

    vscode.window.showInformationMessage(`Chain Grep: Cleared all results`);
}

function clearAllLocalHighlights() {
    if (localHighlightMap.size === 0) {
        vscode.window.showInformationMessage("Chain Grep: No chained highlights to clear");
        return;
    }

    let clearedCount = 0;

    for (const [groupKey, state] of localHighlightMap.entries()) {
        if (state.words.some((w) => w !== undefined)) {
            clearedCount++;

            for (const ed of vscode.window.visibleTextEditors) {
                if (getLocalHighlightKey(ed.document.uri.toString()) === groupKey) {
                    state.decorations.forEach((dec) => {
                        ed.setDecorations(dec, []);
                    });
                }
            }

            state.words.fill(undefined);
            state.next = 0;
        }
    }

    if (clearedCount > 0) {
        savePersistentState();
        vscode.window.showInformationMessage(`Chain Grep: Cleared chained highlights for ${clearedCount} document(s)`);
    } else {
        vscode.window.showInformationMessage("Chain Grep: No chained highlights found to clear");
    }
}

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;

    const chainGrepFs = new ChainGrepFSProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(CHAIN_GREP_SCHEME, chainGrepFs, {
            isReadonly: false,
        })
    );

    initGlobalHighlightDecorations();

    loadPersistentState(context);

    applyHighlightsToOpenEditors();

    chainGrepFs.markInitialized();

    const treeView = vscode.window.createTreeView("chainGrepView", {
        treeDataProvider: chainGrepProvider,
        showCollapseAll: true,
    });

    treeView.onDidChangeVisibility((e) => {
        if (e.visible) {
            chainGrepProvider.refresh();

            recoverFailedChainGrepFiles();
        }
    });

    context.subscriptions.push(treeView);

    cleanupUnusedResources(false);

    let cleanupInterval: NodeJS.Timeout | undefined;
    const intervalMs = getCleanupInterval();

    if (intervalMs > 0) {
        cleanupInterval = setInterval(() => cleanupUnusedResources(false), intervalMs);
        if (isCleanupLoggingEnabled()) {
            console.log(`ChainGrep: Scheduled cleanup every ${intervalMs / 60000} minutes`);
        }
    } else if (isCleanupLoggingEnabled()) {
        console.log(`ChainGrep: Automatic cleanup disabled`);
    }

    const openNodeCmd = vscode.commands.registerCommand("_chainGrep.openNode", (node: ChainGrepNode) => {
        openNode(node);
    });

    const closeNodeCmd = vscode.commands.registerCommand("_chainGrep.closeNode", (node: ChainGrepNode) => {
        closeNode(node);
    });

    const refreshAndOpenCmd = vscode.commands.registerCommand(
        "_chainGrep.refreshAndOpenNode",
        (node: ChainGrepNode) => {
            refreshAndOpen(node);
        }
    );

    const closeAllNodesCmd = vscode.commands.registerCommand("chainGrep.closeAllNodes", closeAllNodes);

    const clearAllLocalHighlightsCmd = vscode.commands.registerCommand(
        "chainGrep.clearAllLocalHighlights",
        clearAllLocalHighlights
    );

    const clearAllGlobalHighlightsCmd = vscode.commands.registerCommand("_chainGrep.clearAllGlobalHighlights", () =>
        clearHighlightsGlobal(true)
    );

    const toggleHighlightCmd = vscode.commands.registerTextEditorCommand("chainGrep.toggleHighlight", () => {
        toggleHighlightLocal();
    });

    const clearHighlightsCmd = vscode.commands.registerTextEditorCommand("chainGrep.clearHighlights", () => {
        clearHighlightsLocal();
    });

    const toggleHighlightGlobalCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.toggleHighlightGlobal",
        () => {
            toggleHighlightGlobal();
        }
    );

    const clearHighlightsGlobalCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.clearHighlightsGlobal",
        () => {
            clearHighlightsGlobal(false);
        }
    );

    const grepTextCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepText", async (editor) => {
        const input = await showQueryAndOptionsQuickInput(undefined, "text");
        if (!input?.query) {
            return;
        }

        const inverted = input.options.includes("Invert");
        const caseSensitive = input.options.includes("Case Sensitive");
        const { chain, sourceUri } = getChainForEditor(editor);

        const newQuery: ChainGrepQuery = {
            type: "text",
            query: input.query,
            inverted,
            caseSensitive,
        };
        const newChain = [...chain, newQuery];

        const docUri = editor.document.uri.toString();
        let parentDocUri: string | undefined;
        if (chainGrepMap.has(docUri)) {
            parentDocUri = docUri;
        }

        await executeChainSearchAndDisplayResults(sourceUri, newChain, parentDocUri, input.query);
    });

    const grepRegexCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepRegex", async (editor) => {
        const input = await showQueryAndOptionsQuickInput(undefined, "regex");
        if (!input?.query) {
            return;
        }

        const inverted = input.options.includes("Invert");
        const caseSensitive = input.options.includes("Case Sensitive");

        if (!isRegexValid(input.query)) {
            vscode.window.showInformationMessage("Invalid regular expression input (illegal single slash).");
            return;
        }

        let pattern: string;
        let flags = "";
        if (input.query.startsWith("/") && input.query.lastIndexOf("/") > 0) {
            const lastSlash = input.query.lastIndexOf("/");
            pattern = input.query.substring(1, lastSlash);
            flags = input.query.substring(lastSlash + 1);
        } else {
            pattern = input.query;
        }
        pattern = pattern.replace(/\/\//g, "/");

        const { chain, sourceUri } = getChainForEditor(editor);
        const newQuery: ChainGrepQuery = {
            type: "regex",
            query: pattern,
            flags,
            inverted,
            caseSensitive,
        };
        const newChain = [...chain, newQuery];

        const docUri = editor.document.uri.toString();
        let parentDocUri: string | undefined;
        if (chainGrepMap.has(docUri)) {
            parentDocUri = docUri;
        }

        await executeChainSearchAndDisplayResults(sourceUri, newChain, parentDocUri, input.query);
    });

    const grepSelectionCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepSelection", async (editor) => {
        const selText = editor.document.getText(editor.selection).trim();
        const input = await showQueryAndOptionsQuickInput(selText || "", "text");
        if (!input?.query) {
            return;
        }

        const inverted = input.options.includes("Invert");
        const caseSensitive = input.options.includes("Case Sensitive");
        const { chain, sourceUri } = getChainForEditor(editor);

        const newQuery: ChainGrepQuery = {
            type: "text",
            query: input.query,
            inverted,
            caseSensitive,
        };
        const newChain = [...chain, newQuery];

        const docUri = editor.document.uri.toString();
        let parentDocUri: string | undefined;
        if (chainGrepMap.has(docUri)) {
            parentDocUri = docUri;
        }

        await executeChainSearchAndDisplayResults(sourceUri, newChain, parentDocUri, input.query);
    });

    const refreshChainCmd = vscode.commands.registerTextEditorCommand("chainGrep.refresh", async (chainEditor) => {
        const chainDocUri = chainEditor.document.uri;
        const docUriStr = chainDocUri.toString();
        if (!chainGrepMap.has(docUriStr)) {
            vscode.window.showInformationMessage("No chain grep found for this document.");
            return;
        }
        const chainInfo = chainGrepMap.get(docUriStr)!;
        const sourceUri = chainInfo.sourceUri;
        try {
            const sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
            await vscode.window.showTextDocument(sourceDoc, {
                preview: false,
            });

            await vscode.commands.executeCommand("workbench.action.files.revert");

            const chainDoc = await vscode.workspace.openTextDocument(chainDocUri);
            const newChainEditor = await vscode.window.showTextDocument(chainDoc, {
                preview: false,
            });
            await executeChainSearchAndUpdateEditor(sourceUri, chainInfo.chain, newChainEditor);
        } catch {
            vscode.window.showInformationMessage("Unable to refresh the source document.");
        }
    });

    const closeDocHandler = vscode.workspace.onDidCloseTextDocument((doc) => {
        const docUri = doc.uri;

        if (docUri.scheme === CHAIN_GREP_SCHEME) {
            const uriString = docUri.toString();
            console.log(`ChainGrep: Chain grep file closed: ${uriString}`);

            const inContents = chainGrepContents.has(uriString);

            console.log(`ChainGrep: File exists in contents: ${inContents}`);

            if (inContents) {
                chainGrepContents.delete(uriString);
                console.log(`ChainGrep: Content deleted from chainGrepContents, but chain info preserved`);
                savePersistentState();
            }
        }
    });

    const tabCloseListener = vscode.window.tabGroups.onDidChangeTabs((e) => {
        for (const tab of e.closed) {
            if (tab.input instanceof vscode.TabInputText) {
                const uri = tab.input.uri;

                if (uri.scheme === CHAIN_GREP_SCHEME) {
                    const uriString = uri.toString();
                    console.log(`ChainGrep: Tab closed for document: ${uriString}`);

                    const inContents = chainGrepContents.has(uriString);

                    console.log(`ChainGrep: File exists in contents: ${inContents}`);

                    if (inContents) {
                        chainGrepContents.delete(uriString);
                        console.log(`ChainGrep: Content deleted from chainGrepContents, chain info preserved`);
                        savePersistentState();
                    }
                }
            }
        }
    });

    context.subscriptions.push(
        openNodeCmd,
        closeNodeCmd,
        refreshAndOpenCmd,
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                reapplyHighlightsLocal(editor);
                reapplyHighlightsGlobal(editor);
            }
        }),
        toggleHighlightCmd,
        clearHighlightsCmd,
        toggleHighlightGlobalCmd,
        clearHighlightsGlobalCmd,
        grepTextCmd,
        grepRegexCmd,
        grepSelectionCmd,
        refreshChainCmd,
        cleanupInterval ? new vscode.Disposable(() => clearInterval(cleanupInterval)) : new vscode.Disposable(() => {}),
        closeDocHandler,
        tabCloseListener,
        closeAllNodesCmd,
        clearAllLocalHighlightsCmd,
        clearAllGlobalHighlightsCmd
    );

    const forceCleanupCmd = vscode.commands.registerCommand("chainGrep.forceCleanup", async () => {
        const visibleUris = new Set(vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString()));

        let cleanedCount = 0;
        for (const contentUri of chainGrepContents.keys()) {
            if (isChainGrepUri(contentUri) && !visibleUris.has(contentUri)) {
                chainGrepContents.delete(contentUri);
                cleanedCount++;
            }
        }

        if (cleanedCount > 0) {
            console.log(`ChainGrep: Force cleaned ${cleanedCount} documents`);
            savePersistentState();
            vscode.window.showInformationMessage(`Chain Grep: Cleaned up ${cleanedCount} documents`);
        } else {
            vscode.window.showInformationMessage("Chain Grep: No documents needed cleanup");
        }
    });

    context.subscriptions.push(forceCleanupCmd);

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("chainGrep.cleanupInterval")) {
                if (cleanupInterval) {
                    clearInterval(cleanupInterval);
                    cleanupInterval = undefined;
                }

                const newIntervalMs = getCleanupInterval();
                if (newIntervalMs > 0) {
                    cleanupInterval = setInterval(() => cleanupUnusedResources(false), newIntervalMs);
                    if (isCleanupLoggingEnabled()) {
                        console.log(`ChainGrep: Updated cleanup schedule to every ${newIntervalMs / 60000} minutes`);
                    }
                } else if (isCleanupLoggingEnabled()) {
                    console.log(`ChainGrep: Automatic cleanup disabled`);
                }
            }
        })
    );
}

export function deactivate() {
    cleanupUnusedResources();
    savePersistentState();
}
