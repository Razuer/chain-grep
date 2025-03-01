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

const chainGrepMap: Map<string, ChainGrepChain> = new Map();

const chainGrepContents: Map<string, string> = new Map();

const CHAIN_GREP_SCHEME = "chaingrep";

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

function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

let globalHighlightDecorations: vscode.TextEditorDecorationType[] = [];
let globalHighlightWords: (string | undefined)[] = [];
let globalNextHighlight = 0;

const localHighlightMap = new Map<string, LocalHighlightState>();

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
            return Promise.resolve(Array.from(this.fileRoots.values()));
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
        if (node.docUri) {
            const parent = node.parent;
            if (parent) {
                parent.children = parent.children.filter((c) => c !== node);
            }
            this.docUriToNode.delete(node.docUri);

            chainGrepMap.delete(node.docUri);
            chainGrepContents.delete(node.docUri);
        } else {
            for (const [key, val] of this.fileRoots.entries()) {
                if (val === node) {
                    this.fileRoots.delete(key);
                    break;
                }
            }
        }
        this.refresh();
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
}

class ChainGrepFSProvider implements vscode.FileSystemProvider {
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
    private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;

    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const content = chainGrepContents.get(uri.toString());
        if (content === undefined) {
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

function toStat(content: string): vscode.FileStat {
    return {
        type: vscode.FileType.File,
        ctime: Date.now(),
        mtime: Date.now(),
        size: Buffer.byteLength(content, "utf8"),
    };
}

vscode.workspace.onDidCloseTextDocument((doc) => {
    const docUri = doc.uri.toString();
    if (docUri.startsWith(`${CHAIN_GREP_SCHEME}://`)) {
        chainGrepContents.delete(docUri);
    }
});

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

function clearHighlightsGlobal() {
    for (const ed of vscode.window.visibleTextEditors) {
        globalHighlightDecorations.forEach((dec) => {
            ed.setDecorations(dec, []);
        });
    }
    globalHighlightWords.fill(undefined);
    globalNextHighlight = globalHighlightDecorations.length - 1;
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

async function executeChainSearch(sourceUri: vscode.Uri, chain: ChainGrepQuery[]): Promise<string[]> {
    const validationErrors = await validateChain(chain);
    if (validationErrors.length) {
        vscode.window.showInformationMessage("Validation errors found: " + validationErrors.join("; "));
        return [];
    }

    let sourceDoc: vscode.TextDocument;
    try {
        sourceDoc = await vscode.workspace.openTextDocument(sourceUri);
    } catch {
        vscode.window.showInformationMessage("Unable to open source document.");
        return [];
    }
    const lines: string[] = [];
    for (let i = 0; i < sourceDoc.lineCount; i++) {
        lines.push(sourceDoc.lineAt(i).text);
    }
    let filtered = lines;
    for (const query of chain) {
        filtered = applyChainQuery(filtered, query);
    }
    return filtered;
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

function buildChainSummary(chain: ChainGrepQuery[]): string {
    const parts = chain.map((q) => {
        let prefix = q.type === "text" ? "T:" : "R:";
        if (q.inverted) {
            prefix += "!";
        }
        if (q.caseSensitive) {
            prefix += "C";
        }
        let s = `'${q.query}'`;
        if (q.type === "regex" && q.flags) {
            s += ` (${q.flags})`;
        }
        return `${prefix}${s}`;
    });
    return "Chain Grep: " + parts.join(" -> ");
}

function buildChainDetailedHeader(chain: ChainGrepQuery[]): string {
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
        lines.push(step);
    });
    lines.push("-------------------------");
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
    const results = await executeChainSearch(sourceUri, chain);
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found.");
    }

    // We'll only include the detailed header if isDetailedChainDocEnabled is true.
    const header = buildChainDetailedHeader(chain);
    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + results.join("\n");
    } else {
        // if detail is disabled, only list results.
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
    const results = await executeChainSearch(sourceUri, chain);
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found after refresh.");
        return;
    }

    const header = buildChainDetailedHeader(chain);

    let content = "";
    if (isDetailedChainDocEnabled()) {
        content = header + "\n\n" + results.join("\n");
    } else {
        content = results.join("\n");
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

async function showQueryAndOptionsQuickInput(defaultQuery?: string) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.title = "Chain Grep | Toggle options -->";
    quickPick.placeholder = "Enter search query here...";
    quickPick.ignoreFocusOut = true;

    if (defaultQuery) {
        quickPick.value = defaultQuery;
    }

    let invertSelected = false;
    let caseSensitiveSelected = false;

    quickPick.buttons = [
        {
            iconPath: new vscode.ThemeIcon("circle-outline"),
            tooltip: "Invert (Off)",
        },
        {
            iconPath: new vscode.ThemeIcon("circle-outline"),
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
                iconPath: new vscode.ThemeIcon(invertSelected ? "check" : "circle-outline"),
                tooltip: `Invert (${invertSelected ? "On" : "Off"})`,
            },
            {
                iconPath: new vscode.ThemeIcon(caseSensitiveSelected ? "check" : "circle-outline"),
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
                const { chain, sourceUri } = chainDoc;
                const results = await executeChainSearch(sourceUri, chain);
                const header = buildChainDetailedHeader(chain);
                let content = "";
                if (isDetailedChainDocEnabled()) {
                    content = header + "\n\n" + results.join("\n");
                } else {
                    content = results.join("\n");
                }
                chainGrepContents.set(node.docUri, content);
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

        vscode.window.showInformationMessage("Refreshed and opened chain doc.");
    } catch {
        vscode.window.showInformationMessage("Unable to refresh the chain doc.");
    }
}

const chainGrepProvider = new ChainGrepDataProvider();

export function activate(context: vscode.ExtensionContext) {
    initGlobalHighlightDecorations();

    const chainGrepFs = new ChainGrepFSProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(CHAIN_GREP_SCHEME, chainGrepFs, {
            isReadonly: false,
        })
    );

    const treeView = vscode.window.registerTreeDataProvider("chainGrepView", chainGrepProvider);

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
            clearHighlightsGlobal();
        }
    );

    const grepTextCmd = vscode.commands.registerTextEditorCommand("chainGrep.grepText", async (editor) => {
        const input = await showQueryAndOptionsQuickInput();
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
        const input = await showQueryAndOptionsQuickInput();
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
        const input = await showQueryAndOptionsQuickInput(selText || "");
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

    context.subscriptions.push(
        treeView,
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
        refreshChainCmd
    );
}

export function deactivate() {}
