import * as vscode from "vscode";
import { LocalHighlightState } from "../models/interfaces";
import { ColorQueue } from "./colorQueue";
import { loadConfiguredPalette, areRandomColorsEnabled, areScrollbarIndicatorsEnabled } from "./configService";
import { escapeRegExp } from "../utils/utils";

// Global highlighting state
let globalHighlightDecorations: vscode.TextEditorDecorationType[] = [];
let globalHighlightWords: (string | undefined)[] = [];
let globalNextHighlight = 0;
let globalHighlightColorMap: Map<string, number> = new Map();
let globalColorIndexes: number[] = [];
let globalColorQueue: ColorQueue;

// Local highlighting state
const localHighlightMap = new Map<string, LocalHighlightState>();
const localHighlightColorMaps: Map<string, Map<string, number>> = new Map();
const localColorIndexMaps: Map<string, number[]> = new Map();
const localColorQueues = new Map<string, ColorQueue>();

export function initGlobalHighlightDecorations() {
    let palette = loadConfiguredPalette();
    let globalColoursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );

    globalHighlightDecorations = [];
    globalHighlightWords = [];

    // Create the global color queue
    globalColorQueue = new ColorQueue(globalColoursArr.length, areRandomColorsEnabled());

    const showScrollbarIndicators = areScrollbarIndicatorsEnabled();

    // Create decorations in the original order
    globalColoursArr.forEach(([bg, fg]) => {
        const decorationOptions: vscode.DecorationRenderOptions = {
            backgroundColor: bg,
            color: fg,
            borderRadius: "4px",
            isWholeLine: false,
        };

        if (showScrollbarIndicators) {
            decorationOptions.overviewRulerColor = bg;
            decorationOptions.overviewRulerLane = vscode.OverviewRulerLane.Right;
        }

        globalHighlightDecorations.push(vscode.window.createTextEditorDecorationType(decorationOptions));
        globalHighlightWords.push(undefined);
    });

    globalNextHighlight = globalHighlightDecorations.length - 1;
}

// GLOBAL HIGHLIGHTING FUNCTIONS

function chooseNextGlobalHighlight(): number {
    return globalColorQueue.getNextIndex();
}

export function addHighlightGlobal(editor: vscode.TextEditor, text: string) {
    removeHighlightForTextGlobal(text);

    // Get next color index from the queue
    const idx = chooseNextGlobalHighlight();

    globalHighlightWords[idx] = text;
    globalHighlightColorMap.set(text, idx);
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

export function removeHighlightForTextGlobal(text: string) {
    const idx = globalHighlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }
    for (const ed of vscode.window.visibleTextEditors) {
        ed.setDecorations(globalHighlightDecorations[idx], []);
    }
    globalHighlightWords[idx] = undefined;

    // Release the color back to the queue when a highlight is removed
    if (globalColorQueue) {
        globalColorQueue.releaseIndex(idx);
    }
}

export function toggleHighlightGlobal(editor: vscode.TextEditor, selectionText: string | undefined) {
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

export function clearHighlightsGlobal(showMessage = true): boolean {
    if (globalHighlightWords.every((w) => w === undefined)) {
        if (showMessage) {
            vscode.window.showInformationMessage("Chain Grep: No global highlights to clear");
        }
        return false;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        globalHighlightDecorations.forEach((dec) => {
            ed.setDecorations(dec, []);
        });
    }
    globalHighlightWords.fill(undefined);
    globalHighlightColorMap.clear(); // Clear the color map

    // Reset the global color queue when cleared
    if (globalColorQueue) {
        globalColorQueue = new ColorQueue(globalHighlightDecorations.length, areRandomColorsEnabled());
    }

    if (showMessage) {
        vscode.window.showInformationMessage("Chain Grep: Cleared all global highlights");
    }

    return true;
}

export function reapplyAllGlobalHighlights() {
    for (const ed of vscode.window.visibleTextEditors) {
        reapplyHighlightsGlobal(ed);
    }
}

export function reapplyHighlightsGlobal(editor: vscode.TextEditor) {
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

// LOCAL HIGHLIGHTING FUNCTIONS

export function getLocalHighlightKey(docUri: string, chainGrepMap: Map<string, any>): string {
    if (chainGrepMap.has(docUri)) {
        const chainInfo = chainGrepMap.get(docUri)!;
        return chainInfo.sourceUri.toString();
    }
    return docUri;
}

export function getLocalHighlightState(groupKey: string): LocalHighlightState {
    let existing = localHighlightMap.get(groupKey);
    if (!existing) {
        const newDecs = createHighlightDecorationsFromColours(groupKey);
        existing = {
            decorations: newDecs,
            words: new Array(newDecs.length).fill(undefined),
            next: 0,
        };
        localHighlightMap.set(groupKey, existing);
    }
    return existing;
}

function createHighlightDecorationsFromColours(groupKey: string): vscode.TextEditorDecorationType[] {
    let palette = loadConfiguredPalette();
    let coloursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );

    // Create a color queue for this group key
    localColorQueues.set(groupKey, new ColorQueue(coloursArr.length, areRandomColorsEnabled()));

    const showScrollbarIndicators = areScrollbarIndicatorsEnabled();

    // Create decorations in the original order
    return coloursArr.map(([bg, fg]) => {
        const decorationOptions: vscode.DecorationRenderOptions = {
            backgroundColor: bg,
            color: fg,
            borderRadius: "4px",
            isWholeLine: false,
        };

        if (showScrollbarIndicators) {
            decorationOptions.overviewRulerColor = bg;
            decorationOptions.overviewRulerLane = vscode.OverviewRulerLane.Right;
        }

        return vscode.window.createTextEditorDecorationType(decorationOptions);
    });
}

function chooseNextLocalHighlight(groupKey: string): number {
    if (!localColorQueues.has(groupKey)) {
        // This shouldn't happen because we create the queue in getLocalHighlightState
        // but just in case
        const state = getLocalHighlightState(groupKey);
        localColorQueues.set(groupKey, new ColorQueue(state.decorations.length, areRandomColorsEnabled()));
    }

    return localColorQueues.get(groupKey)!.getNextIndex();
}

export function addHighlightLocal(editor: vscode.TextEditor, text: string, chainGrepMap: Map<string, any>) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    removeHighlightForTextLocal(docUri, text, chainGrepMap);

    // Get next color index from the queue
    const idx = chooseNextLocalHighlight(groupKey);

    state.words[idx] = text;

    if (!localHighlightColorMaps.has(groupKey)) {
        localHighlightColorMaps.set(groupKey, new Map<string, number>());
    }
    localHighlightColorMaps.get(groupKey)!.set(text, idx);

    applyHighlightForTextLocal(editor, text, idx, chainGrepMap);
}

function applyHighlightForTextLocal(
    editor: vscode.TextEditor,
    text: string,
    idx: number,
    chainGrepMap: Map<string, any>
) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    function decorateSingle(ed: vscode.TextEditor) {
        if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) !== groupKey) {
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
        if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) === groupKey) {
            decorateSingle(ed);
        }
    }
}

export function removeHighlightForTextLocal(docUri: string, text: string, chainGrepMap: Map<string, any>) {
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);
    const idx = state.words.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) === groupKey) {
            ed.setDecorations(state.decorations[idx], []);
        }
    }
    state.words[idx] = undefined;

    // Release the color back to the queue
    if (localColorQueues.has(groupKey)) {
        localColorQueues.get(groupKey)!.releaseIndex(idx);
    }
}

export function toggleHighlightLocal(
    editor: vscode.TextEditor,
    text: string | undefined,
    chainGrepMap: Map<string, any>
) {
    if (!text) {
        return;
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);
    const idx = state.words.findIndex((w) => w === text);
    if (idx === -1) {
        addHighlightLocal(editor, text, chainGrepMap);
    } else {
        removeHighlightForTextLocal(docUri, text, chainGrepMap);
    }
}

export function clearHighlightsLocal(editor: vscode.TextEditor, chainGrepMap: Map<string, any>) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    for (const ed of vscode.window.visibleTextEditors) {
        if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) === groupKey) {
            state.decorations.forEach((dec) => {
                ed.setDecorations(dec, []);
            });
        }
    }

    // Clear the local color map for this group
    if (localHighlightColorMaps.has(groupKey)) {
        localHighlightColorMaps.get(groupKey)!.clear();
    }

    // Reset the local color queue for this group
    if (localColorQueues.has(groupKey)) {
        localColorQueues.set(groupKey, new ColorQueue(state.decorations.length, areRandomColorsEnabled()));
    }

    state.words.fill(undefined);
    state.next = 0;
}

export function reapplyHighlightsLocal(editor: vscode.TextEditor, chainGrepMap: Map<string, any>) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getLocalHighlightState(groupKey);

    for (let i = 0; i < state.words.length; i++) {
        const w = state.words[i];
        if (w) {
            applyHighlightForTextLocal(editor, w, i, chainGrepMap);
        }
    }
}

export function applyHighlightsToOpenEditors(chainGrepMap: Map<string, any>) {
    reapplyAllGlobalHighlights();

    for (const editor of vscode.window.visibleTextEditors) {
        reapplyHighlightsLocal(editor, chainGrepMap);
    }

    console.log("Chain Grep: Applied saved highlights to open editors");
}

export function clearAllLocalHighlights(chainGrepMap: Map<string, any>): number {
    if (localHighlightMap.size === 0) {
        vscode.window.showInformationMessage("Chain Grep: No chained highlights to clear");
        return 0;
    }

    let clearedCount = 0;

    for (const [groupKey, state] of localHighlightMap.entries()) {
        if (state.words.some((w) => w !== undefined)) {
            clearedCount++;

            for (const ed of vscode.window.visibleTextEditors) {
                if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) === groupKey) {
                    state.decorations.forEach((dec) => {
                        ed.setDecorations(dec, []);
                    });
                }
            }

            // Clear the local color map for this group
            if (localHighlightColorMaps.has(groupKey)) {
                localHighlightColorMaps.get(groupKey)!.clear();
            }

            state.words.fill(undefined);
            state.next = 0;
        }
    }

    if (clearedCount > 0) {
        vscode.window.showInformationMessage(`Chain Grep: Cleared chained highlights for ${clearedCount} document(s)`);
    } else {
        vscode.window.showInformationMessage("Chain Grep: No chained highlights found to clear");
    }

    return clearedCount;
}

// State management for highlights

export function getHighlightState() {
    return {
        globalHighlightWords,
        globalHighlightColorMap: Array.from(globalHighlightColorMap.entries()),
        globalColorIndexes,
        localHighlights: Array.from(localHighlightMap.entries()).map(([key, state]) => [
            key,
            { words: state.words, next: state.next },
        ]),
        localHighlightColorMaps: Array.from(localHighlightColorMaps.entries()).map(([key, map]) => [
            key,
            Array.from(map.entries()),
        ]),
        localColorIndexMaps: Array.from(localColorIndexMaps.entries()),
        globalColorQueue: globalColorQueue ? globalColorQueue.getIndexes() : [],
        localColorQueues: Array.from(localColorQueues.entries()).map(([key, queue]) => [key, queue.getIndexes()]),
    };
}

export function restoreHighlightState(state: any) {
    if (state.globalHighlightWords) {
        globalHighlightWords = state.globalHighlightWords;
    }
    if (state.localHighlights) {
        for (const [key, stateObj] of state.localHighlights) {
            const localState = getLocalHighlightState(key);
            localState.words = stateObj.words;
            localState.next = stateObj.next;
        }
    }
    if (state.globalHighlightColorMap) {
        globalHighlightColorMap = new Map(state.globalHighlightColorMap);
    }

    if (state.localHighlightColorMaps) {
        for (const [key, mapData] of state.localHighlightColorMaps) {
            localHighlightColorMaps.set(key, new Map(mapData));
        }
    }

    if (state.globalColorIndexes) {
        globalColorIndexes = state.globalColorIndexes;
    }

    if (state.localColorIndexMaps) {
        for (const [key, indexes] of state.localColorIndexMaps) {
            localColorIndexMaps.set(key, indexes);
        }
    }

    if (state.globalColorQueue) {
        if (!globalColorQueue) {
            globalColorQueue = new ColorQueue(globalHighlightDecorations.length, areRandomColorsEnabled());
        }
        globalColorQueue.setIndexes(state.globalColorQueue);
    }

    if (state.localColorQueues) {
        for (const [key, indexes] of state.localColorQueues) {
            const queue = localColorQueues.get(key) || new ColorQueue(indexes.length, areRandomColorsEnabled());
            queue.setIndexes(indexes);
            localColorQueues.set(key, queue);
        }
    }
}
