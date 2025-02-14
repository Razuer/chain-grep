import * as vscode from "vscode";

// Represents a single query in the chain grep process.
interface ChainGrepQuery {
    type: "text" | "regex";
    query: string;
    flags?: string;
    inverted: boolean;
    caseSensitive?: boolean;
}

// Represents the entire chain of queries for a given chain doc, plus the URI of the source file.
interface ChainGrepChain {
    chain: ChainGrepQuery[];
    sourceUri: vscode.Uri;
}

// Maps chain doc URIs to their chain state.
const chainGrepMap: Map<string, ChainGrepChain> = new Map();

// Default highlight colors and border/text styles.
const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

// Global highlighting state.
let globalHighlightDecorations: vscode.TextEditorDecorationType[] = [];
let globalHighlightWords: (string | undefined)[] = [];
let globalNextHighlight = 0;

// Holds highlight info for local (file-based or chain-based) highlighting.
interface LocalHighlightState {
    decorations: vscode.TextEditorDecorationType[];
    words: (string | undefined)[];
    next: number;
}

// Maps a group key (source doc or chain doc) to local highlight info.
const localHighlightMap = new Map<string, LocalHighlightState>();

// Creates VS Code decoration types from the default colors.
function createHighlightDecorationsFromColours(): vscode.TextEditorDecorationType[] {
    const coloursArr = DEFAULT_COLOURS.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );
    return coloursArr.map(([bg, fg]) =>
        vscode.window.createTextEditorDecorationType({
            backgroundColor: bg,
            color: fg,
            borderRadius: "4px",
        })
    );
}

// If a doc is a chain doc, return the URI of its source doc.
// Otherwise, return docUri itself.
function getLocalHighlightKey(docUri: string): string {
    if (chainGrepMap.has(docUri)) {
        const chainInfo = chainGrepMap.get(docUri)!;
        return chainInfo.sourceUri.toString();
    }
    return docUri;
}

// Escapes a string so it can safely be used in a regular expression.
function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns the selected text if any, otherwise the word under cursor.
function getSelectedTextOrWord(editor: vscode.TextEditor): string | undefined {
    const selection = editor.selection;
    if (!selection.isEmpty) {
        return editor.document.getText(selection);
    }
    const wordRange = editor.document.getWordRangeAtPosition(selection.start);
    return wordRange ? editor.document.getText(wordRange) : undefined;
}

// Sets up decorations for global highlighting (using colors from the end first).
function initGlobalHighlightDecorations() {
    const globalColoursArr = DEFAULT_COLOURS.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );
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

    // Start picking colors from the last index.
    globalNextHighlight = globalHighlightDecorations.length - 1;
}

// Finds the next free global decoration index from the end to the beginning.
function chooseNextGlobalHighlight(): number {
    let idx = globalNextHighlight;
    let start = globalNextHighlight;
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

    // If all are used, just reuse current.
    const ret = globalNextHighlight;
    globalNextHighlight = ret - 1;
    if (globalNextHighlight < 0) {
        globalNextHighlight = globalHighlightDecorations.length - 1;
    }
    return ret;
}

// Adds a global highlight for the given text.
function addHighlightGlobal(editor: vscode.TextEditor, text: string) {
    removeHighlightForTextGlobal(text);
    const idx = chooseNextGlobalHighlight();
    globalHighlightWords[idx] = text;
    applyHighlightForTextGlobal(editor, text, idx);
}

// Highlights the given text with a specific decoration index in a single editor.
function applyHighlightForTextGlobal(
    editor: vscode.TextEditor,
    text: string,
    idx: number
) {
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

// Removes a global highlight for the given text in all open editors.
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

// Toggles global highlighting of the currently selected text.
function toggleHighlightGlobal() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const text = getSelectedTextOrWord(editor);
    if (!text) {
        return;
    }
    const idx = globalHighlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        addHighlightGlobal(editor, text);
    } else {
        removeHighlightForTextGlobal(text);
    }
    reapplyAllGlobalHighlights();
}

// Clears all global highlights from all open editors.
function clearHighlightsGlobal() {
    for (const ed of vscode.window.visibleTextEditors) {
        globalHighlightDecorations.forEach((decoration) => {
            ed.setDecorations(decoration, []);
        });
    }
    globalHighlightWords.fill(undefined);
    globalNextHighlight = globalHighlightDecorations.length - 1;
}

// Reapplies all global highlights in all currently visible editors.
function reapplyAllGlobalHighlights() {
    for (const ed of vscode.window.visibleTextEditors) {
        reapplyHighlightsGlobal(ed);
    }
}

// Recreates decorations for global highlights in a single editor.
function reapplyHighlightsGlobal(editor: vscode.TextEditor) {
    const fullText = editor.document.getText();
    const wordsWithIndex = globalHighlightWords
        .map((word, idx) => ({ word, idx }))
        .filter((item) => item.word);
    if (!wordsWithIndex.length) {
        return;
    }
    const pattern =
        "(" +
        wordsWithIndex.map((item) => escapeRegExp(item.word!)).join("|") +
        ")";
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
            const endPos = editor.document.positionAt(
                match.index + matchedText.length
            );
            decorationOptions[i].push({
                range: new vscode.Range(startPos, endPos),
            });
        }
    }
    for (const idxStr in decorationOptions) {
        const i = Number(idxStr);
        editor.setDecorations(
            globalHighlightDecorations[i],
            decorationOptions[i]
        );
    }
}

// Retrieves or creates local highlighting state for a given groupKey.
function getLocalHighlightState(groupKey: string): LocalHighlightState {
    const existing = localHighlightMap.get(groupKey);
    if (existing) {
        return existing;
    }
    const newDecorations = createHighlightDecorationsFromColours();
    const newState: LocalHighlightState = {
        decorations: newDecorations,
        words: new Array(newDecorations.length).fill(undefined),
        next: 0,
    };
    localHighlightMap.set(groupKey, newState);
    return newState;
}

// Chooses the next available index for local highlighting.
function chooseNextLocalHighlight(state: LocalHighlightState): number {
    const start = state.next;
    let idx = state.next;
    do {
        if (!state.words[idx]) {
            return idx;
        }
        idx = (idx + 1) % state.decorations.length;
    } while (idx !== start);
    return idx;
}

// Adds a local highlight for the given text in the current group.
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

// Applies local highlight for the specified text/index in all visible editors of the same group.
function applyHighlightForTextLocal(
    editor: vscode.TextEditor,
    text: string,
    idx: number
) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri);
    const state = getLocalHighlightState(groupKey);

    function decorateSingle(ed: vscode.TextEditor) {
        if (getLocalHighlightKey(ed.document.uri.toString()) !== groupKey) {
            return;
        }
        const fullText = ed.document.getText();
        const regex = new RegExp(escapeRegExp(text), "g");
        const decorationOptions: vscode.DecorationOptions[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(fullText)) !== null) {
            const startPos = ed.document.positionAt(match.index);
            const endPos = ed.document.positionAt(match.index + text.length);
            decorationOptions.push({
                range: new vscode.Range(startPos, endPos),
            });
        }
        ed.setDecorations(state.decorations[idx], decorationOptions);
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

// Removes local highlight for the given text in all visible editors of the same group.
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

// Toggles local highlighting of the currently selected text.
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

// Clears all local highlights in the current editor's group.
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
            state.decorations.forEach((decoration) => {
                ed.setDecorations(decoration, []);
            });
        }
    }

    state.words.fill(undefined);
    state.next = 0;
}

// Re-applies local highlights for the current editor and all in the same group.
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

// Executes the chain queries against the source file and returns matched lines.
async function executeChainSearch(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[]
): Promise<string[]> {
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

// Returns the chain info for the given editor, if any.
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

// Applies a single query (text or regex) to an array of lines.
function applyChainQuery(lines: string[], query: ChainGrepQuery): string[] {
    if (query.type === "text") {
        return lines.filter((line) => {
            const textLine = query.caseSensitive ? line : line.toLowerCase();
            const textQuery = query.caseSensitive
                ? query.query
                : query.query.toLowerCase();
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
            vscode.window.showInformationMessage(
                "Invalid regular expression in chain."
            );
            return lines;
        }
        return lines.filter((line) =>
            query.inverted ? !regex.test(line) : regex.test(line)
        );
    }
}

// Builds a summary line describing the entire chain.
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

// Builds a multiline header describing each step in the chain.
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

// Performs chain search, creates a new untitled doc, and displays results.
async function executeChainSearchAndDisplayResults(
    sourceUri: vscode.Uri,
    chain: ChainGrepQuery[]
) {
    const results = await executeChainSearch(sourceUri, chain);
    if (!results.length) {
        vscode.window.showInformationMessage("No matches found.");
        return;
    }
    const summary = buildChainSummary(chain);
    const header = buildChainDetailedHeader(chain);
    const content = summary + "\n" + header + "\n\n" + results.join("\n");

    await vscode.commands.executeCommand(
        "workbench.action.files.newUntitledFile"
    );
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        await editor.edit((eb) => {
            eb.insert(new vscode.Position(0, 0), content);
        });
        chainGrepMap.set(editor.document.uri.toString(), { chain, sourceUri });
        reapplyHighlightsLocal(editor);
    }
}

// Refreshes the chain doc with updated search results and re-applies highlights.
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
    const summary = buildChainSummary(chain);
    const header = buildChainDetailedHeader(chain);
    const content = summary + "\n" + header + "\n\n" + results.join("\n");

    const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
    );
    await editor.edit((eb) => {
        eb.replace(fullRange, content);
    });
    reapplyHighlightsLocal(editor);
}

// Checks if a string looks like a valid regex.
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

// Shows a quick input for the user to type a search query and toggle some options.
async function showQueryAndOptionsQuickInput(
    defaultQuery?: string
): Promise<{ query: string; options: string[] } | undefined> {
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
        if (button.tooltip && button.tooltip.startsWith("Invert")) {
            invertSelected = !invertSelected;
        } else if (
            button.tooltip &&
            button.tooltip.startsWith("Case Sensitive")
        ) {
            caseSensitiveSelected = !caseSensitiveSelected;
        }
        quickPick.buttons = [
            {
                iconPath: new vscode.ThemeIcon(
                    invertSelected ? "check" : "circle-outline"
                ),
                tooltip: `Invert (${invertSelected ? "On" : "Off"})`,
            },
            {
                iconPath: new vscode.ThemeIcon(
                    caseSensitiveSelected ? "check" : "circle-outline"
                ),
                tooltip: `Case Sensitive (${
                    caseSensitiveSelected ? "On" : "Off"
                })`,
            },
        ];
    });

    return new Promise((resolve) => {
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

// Extension entry point.
export function activate(context: vscode.ExtensionContext) {
    initGlobalHighlightDecorations();

    const toggleHighlightCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.toggleHighlight",
        () => {
            toggleHighlightLocal();
        }
    );

    const clearHighlightsCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.clearHighlights",
        () => {
            clearHighlightsLocal();
        }
    );

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

    const findTextCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.findText",
        async (editor) => {
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
            await executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    const findRegexCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.findRegex",
        async (editor) => {
            const input = await showQueryAndOptionsQuickInput();
            if (!input?.query) {
                return;
            }
            const inverted = input.options.includes("Invert");
            const caseSensitive = input.options.includes("Case Sensitive");
            if (!isRegexValid(input.query)) {
                vscode.window.showInformationMessage(
                    "Invalid regular expression input (illegal single slash)."
                );
                return;
            }
            let pattern: string;
            let flags = "";
            if (
                input.query.startsWith("/") &&
                input.query.lastIndexOf("/") > 0
            ) {
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
            await executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    const grepSelectionCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.grepSelection",
        async (editor) => {
            const selection = editor.selection;
            let selText = editor.document.getText(selection).trim();
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
            await executeChainSearchAndDisplayResults(sourceUri, newChain);
        }
    );

    const refreshChainCmd = vscode.commands.registerTextEditorCommand(
        "chainGrep.refresh",
        async (chainEditor) => {
            const chainDocUri = chainEditor.document.uri;
            const docUri = chainDocUri.toString();
            if (!chainGrepMap.has(docUri)) {
                vscode.window.showInformationMessage(
                    "No chain grep found for this document."
                );
                return;
            }
            const chainInfo = chainGrepMap.get(docUri)!;
            const sourceUri = chainInfo.sourceUri;
            try {
                const sourceDoc = await vscode.workspace.openTextDocument(
                    sourceUri
                );
                await vscode.window.showTextDocument(sourceDoc, {
                    preview: false,
                });

                await vscode.commands.executeCommand(
                    "workbench.action.files.revert"
                );

                const chainDoc = await vscode.workspace.openTextDocument(
                    chainDocUri
                );
                const newChainEditor = await vscode.window.showTextDocument(
                    chainDoc,
                    {
                        preview: false,
                    }
                );
                await executeChainSearchAndUpdateEditor(
                    sourceUri,
                    chainInfo.chain,
                    newChainEditor
                );
            } catch {
                vscode.window.showInformationMessage(
                    "Unable to refresh the source document."
                );
            }
        }
    );

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor) {
                reapplyHighlightsLocal(editor);
                reapplyHighlightsGlobal(editor);
            }
        })
    );

    context.subscriptions.push(
        toggleHighlightCmd,
        clearHighlightsCmd,
        toggleHighlightGlobalCmd,
        clearHighlightsGlobalCmd,
        findTextCmd,
        findRegexCmd,
        grepSelectionCmd,
        refreshChainCmd
    );
}

// Called when the extension is deactivated.
export function deactivate() {}
