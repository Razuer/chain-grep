import * as vscode from "vscode";
import { LocalHighlightState } from "../models/interfaces";
import { ColorQueue } from "./colorQueue";
import { loadConfiguredPalette, areRandomColorsEnabled, areScrollbarIndicatorsEnabled } from "./configService";
import { escapeRegExp } from "../utils/utils";

let highlightDecorations: vscode.TextEditorDecorationType[] = [];

let globalHighlightWords: (string | undefined)[] = [];
let globalHighlightColorMap: Map<string, number> = new Map();
let globalColorIndexes: number[] = [];
let globalColorQueue: ColorQueue;

const localHighlightMap = new Map<string, LocalHighlightState>();
const localHighlightColorMaps: Map<string, Map<string, number>> = new Map();
const localColorIndexMaps: Map<string, number[]> = new Map();
const localColorQueues = new Map<string, ColorQueue>();

function darkenColor(color: string, factor: number): string {
    if (!color.startsWith("#")) {
        return color;
    }

    let r = parseInt(color.slice(1, 3), 16);
    let g = parseInt(color.slice(3, 5), 16);
    let b = parseInt(color.slice(5, 7), 16);

    r = Math.floor(r * factor);
    b = Math.floor(b * factor);
    g = Math.floor(g * factor);

    r = Math.max(0, r);
    g = Math.max(0, g);
    b = Math.max(0, b);

    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

export function initHighlightDecorations() {
    let palette = loadConfiguredPalette();
    let globalColoursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );

    highlightDecorations.forEach((decoration) => decoration.dispose());

    highlightDecorations = [];

    if (globalHighlightWords.length === 0) {
        globalHighlightWords = [];
    }

    globalColorQueue = new ColorQueue(globalColoursArr.length, areRandomColorsEnabled(), true);

    const showScrollbarIndicators = areScrollbarIndicatorsEnabled();

    globalColoursArr.forEach(([bg, fg]) => {
        const borderColor = darkenColor(bg, 0.8);

        const decorationOptions: vscode.DecorationRenderOptions = {
            backgroundColor: bg,
            color: fg,
            borderWidth: "1px 0px",
            borderStyle: "solid none",
            borderColor: "var(--vscode-editor-background)",
            borderRadius: "4px",
            isWholeLine: false,
            fontWeight: "bold",
        };

        if (showScrollbarIndicators) {
            decorationOptions.overviewRulerColor = bg;
            decorationOptions.overviewRulerLane = vscode.OverviewRulerLane.Right;
        }

        highlightDecorations.push(vscode.window.createTextEditorDecorationType(decorationOptions));
        if (globalHighlightWords.length < highlightDecorations.length) {
            globalHighlightWords.push(undefined);
        }
    });
}

export const initGlobalHighlightDecorations = initHighlightDecorations;

function chooseNextGlobalHighlight(): number {
    return globalColorQueue.getNextIndex();
}

export function addHighlightGlobal(editor: vscode.TextEditor, text: string) {
    removeHighlightForTextGlobal(text);

    const idx = chooseNextGlobalHighlight();

    globalHighlightWords[idx] = text;
    globalHighlightColorMap.set(text, idx);
    applyHighlightForTextGlobal(editor, text, idx);
}

function applyHighlightForTextGlobal(editor: vscode.TextEditor, text: string, idx: number) {
    if (idx >= highlightDecorations.length) {
        console.error(`Chain Grep: Invalid highlight index ${idx}, max is ${highlightDecorations.length - 1}`);
        return;
    }

    const fullText = editor.document.getText();
    const regex = new RegExp(escapeRegExp(text), "g");
    const decorationOptions: vscode.DecorationOptions[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(fullText)) !== null) {
        const startPos = editor.document.positionAt(match.index);
        const endPos = editor.document.positionAt(match.index + text.length);
        decorationOptions.push({ range: new vscode.Range(startPos, endPos) });
    }
    editor.setDecorations(highlightDecorations[idx], decorationOptions);
}

export function removeHighlightForTextGlobal(text: string) {
    const idx = globalHighlightWords.findIndex((w) => w === text);
    if (idx === -1) {
        return;
    }
    for (const ed of vscode.window.visibleTextEditors) {
        ed.setDecorations(highlightDecorations[idx], []);
    }
    globalHighlightWords[idx] = undefined;

    if (globalColorQueue) {
        globalColorQueue.releaseIndex(idx);
    }
}

export function toggleHighlightGlobal(
    editor: vscode.TextEditor,
    selectionText: string | undefined,
    chainGrepMap: Map<string, any>
) {
    if (!selectionText) {
        return;
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getExistingLocalHighlightState(groupKey) || createLocalHighlightState(groupKey);
    const localIdx = state.words.findIndex((w) => w === selectionText);

    if (localIdx !== -1) {
        removeHighlightForTextLocal(docUri, selectionText, chainGrepMap);
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
        highlightDecorations.forEach((dec) => {
            ed.setDecorations(dec, []);
        });
    }
    globalHighlightWords.fill(undefined);
    globalHighlightColorMap.clear();

    if (globalColorQueue) {
        globalColorQueue = new ColorQueue(highlightDecorations.length, areRandomColorsEnabled(), true);
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
    const wordsWithIndex = globalHighlightWords
        .map((word, idx) => ({ word, idx }))
        .filter((item) => item.word !== undefined);

    if (!wordsWithIndex.length) {
        return;
    }

    for (const { word, idx } of wordsWithIndex) {
        if (word && idx < highlightDecorations.length) {
            applyHighlightForTextGlobal(editor, word, idx);
        }
    }
}

export function getLocalHighlightKey(docUri: string, chainGrepMap: Map<string, any>): string {
    if (chainGrepMap.has(docUri)) {
        const chainInfo = chainGrepMap.get(docUri)!;
        return chainInfo.sourceUri.toString();
    }
    return docUri;
}

export function hasLocalHighlightState(groupKey: string): boolean {
    return localHighlightMap.has(groupKey);
}

export function getExistingLocalHighlightState(groupKey: string): LocalHighlightState | undefined {
    return localHighlightMap.get(groupKey);
}

export function createLocalHighlightState(groupKey: string): LocalHighlightState {
    const newDecs = createHighlightDecorationsFromColours(groupKey);
    const newState = {
        decorations: newDecs,
        words: new Array(newDecs.length).fill(undefined),
        next: 0,
    };
    localHighlightMap.set(groupKey, newState);
    return newState;
}

function createHighlightDecorationsFromColours(groupKey: string): vscode.TextEditorDecorationType[] {
    let palette = loadConfiguredPalette();
    let coloursArr = palette.split(",").map((pair) =>
        pair
            .trim()
            .split(":")
            .map((c) => c.trim())
    );

    localColorQueues.set(groupKey, new ColorQueue(coloursArr.length, areRandomColorsEnabled(), false));

    const showScrollbarIndicators = areScrollbarIndicatorsEnabled();

    return coloursArr.map(([bg, fg]) => {
        const decorationOptions: vscode.DecorationRenderOptions = {
            backgroundColor: bg,
            color: fg,
            borderWidth: "1px 0px",
            borderStyle: "solid none",
            borderColor: "var(--vscode-editor-background)",
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
        const stateExists = hasLocalHighlightState(groupKey);
        let decoLength = 10;

        if (stateExists) {
            const state = getExistingLocalHighlightState(groupKey);
            if (state) {
                decoLength = state.decorations.length;
            }
        }

        localColorQueues.set(groupKey, new ColorQueue(decoLength, areRandomColorsEnabled()));
    }

    return localColorQueues.get(groupKey)!.getNextIndex();
}

export function addHighlightLocal(editor: vscode.TextEditor, text: string, chainGrepMap: Map<string, any>) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);

    removeHighlightForTextLocal(docUri, text, chainGrepMap);

    const state = localHighlightMap.get(groupKey) || createLocalHighlightState(groupKey);

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
    const state = getExistingLocalHighlightState(groupKey);

    if (!state) {
        console.error(`Chain Grep: No highlight state found for group ${groupKey} when trying to apply highlight`);
        return;
    }

    if (idx >= state.decorations.length) {
        console.error(
            `Chain Grep: Invalid local highlight index ${idx} for group ${groupKey}, max is ${
                state.decorations.length - 1
            }`
        );
        return;
    }

    function decorateSingle(ed: vscode.TextEditor, decorations: vscode.TextEditorDecorationType[]) {
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
        ed.setDecorations(decorations[idx], decoOpts);
    }

    decorateSingle(editor, state.decorations);

    for (const ed of vscode.window.visibleTextEditors) {
        if (ed === editor) {
            continue;
        }
        if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) === groupKey) {
            decorateSingle(ed, state.decorations);
        }
    }
}

export function removeHighlightForTextLocal(docUri: string, text: string, chainGrepMap: Map<string, any>) {
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getExistingLocalHighlightState(groupKey);

    if (!state) {
        return;
    }

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

    const globalHighlightIndex = globalHighlightWords.findIndex((w) => w === text);
    if (globalHighlightIndex !== -1) {
        removeHighlightForTextGlobal(text);
    }

    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getExistingLocalHighlightState(groupKey);

    if (!state || state.words.findIndex((w) => w === text) === -1) {
        addHighlightLocal(editor, text, chainGrepMap);
    } else {
        removeHighlightForTextLocal(docUri, text, chainGrepMap);
    }
}

export function clearHighlightsLocal(editor: vscode.TextEditor, chainGrepMap: Map<string, any>) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getExistingLocalHighlightState(groupKey);

    if (!state) {
        return;
    }

    for (const ed of vscode.window.visibleTextEditors) {
        if (getLocalHighlightKey(ed.document.uri.toString(), chainGrepMap) === groupKey) {
            state.decorations.forEach((dec) => {
                ed.setDecorations(dec, []);
            });
        }
    }

    if (localHighlightColorMaps.has(groupKey)) {
        localHighlightColorMaps.get(groupKey)!.clear();
    }

    if (localColorQueues.has(groupKey)) {
        localColorQueues.set(groupKey, new ColorQueue(state.decorations.length, areRandomColorsEnabled(), false));
    }

    state.words.fill(undefined);
    state.next = 0;

    localHighlightMap.delete(groupKey);
    console.log(`Chain Grep: Removed empty highlight group after clearing: ${groupKey}`);
}

export function reapplyHighlightsLocal(editor: vscode.TextEditor, chainGrepMap: Map<string, any>) {
    const docUri = editor.document.uri.toString();
    const groupKey = getLocalHighlightKey(docUri, chainGrepMap);
    const state = getExistingLocalHighlightState(groupKey);

    if (!state) {
        return;
    }

    for (let i = 0; i < state.words.length; i++) {
        const word = state.words[i];
        if (word && i < state.decorations.length) {
            applyHighlightForTextLocal(editor, word, i, chainGrepMap);
        }
    }
}

export function applyHighlightsToOpenEditors(chainGrepMap: Map<string, any>) {
    try {
        if (highlightDecorations.length === 0) {
            console.log("Chain Grep: Initializing global highlights before applying");
            initHighlightDecorations();
        }

        reapplyAllGlobalHighlights();

        for (const editor of vscode.window.visibleTextEditors) {
            reapplyHighlightsLocal(editor, chainGrepMap);
        }

        console.log("Chain Grep: Successfully applied highlights to all open editors");
        return true;
    } catch (error) {
        console.error("Chain Grep: Error applying highlights to editors", error);
        return false;
    }
}

export function clearAllLocalHighlights(chainGrepMap: Map<string, any>): number {
    if (localHighlightMap.size === 0) {
        vscode.window.showInformationMessage("Chain Grep: No chained highlights to clear");
        return 0;
    }

    let clearedCount = 0;
    const keysToRemove: string[] = [];

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

            if (localHighlightColorMaps.has(groupKey)) {
                localHighlightColorMaps.get(groupKey)!.clear();
            }

            if (localColorQueues.has(groupKey)) {
                localColorQueues.set(
                    groupKey,
                    new ColorQueue(state.decorations.length, areRandomColorsEnabled(), false)
                );
            }

            state.words.fill(undefined);
            state.next = 0;

            keysToRemove.push(groupKey);
        } else {
            keysToRemove.push(groupKey);
        }
    }

    for (const key of keysToRemove) {
        localHighlightMap.delete(key);

        if (localHighlightColorMaps.has(key)) {
            localHighlightColorMaps.delete(key);
        }

        if (localColorQueues.has(key)) {
            localColorQueues.delete(key);
        }

        if (localColorIndexMaps.has(key)) {
            localColorIndexMaps.delete(key);
        }

        console.log(`Chain Grep: Removed highlight group for ${key}`);
    }

    if (clearedCount > 0) {
        vscode.window.showInformationMessage(`Chain Grep: Cleared chained highlights for ${clearedCount} document(s)`);
    } else {
        vscode.window.showInformationMessage("Chain Grep: No chained highlights found to clear");
    }

    return clearedCount;
}

export function getHighlightState() {
    const state = {
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

    return state;
}

export function restoreHighlightState(state: any) {
    try {
        if (!state) {
            console.log("Chain Grep: No highlight state to restore");
            return;
        }

        if (highlightDecorations.length === 0) {
            console.log("Chain Grep: Creating decorations before restoring state");
            initHighlightDecorations();
        }

        if (state.globalHighlightWords) {
            const words = state.globalHighlightWords.slice(0, highlightDecorations.length);
            while (globalHighlightWords.length < words.length) {
                globalHighlightWords.push(undefined);
            }
            for (let i = 0; i < words.length; i++) {
                if (words[i] && words[i].trim() !== "") {
                    globalHighlightWords[i] = words[i];
                } else {
                    globalHighlightWords[i] = undefined;
                }
            }

            const definedWords = words.filter(
                (w: string | undefined): w is string => w !== undefined && w !== null && w.trim() !== ""
            );

            if (definedWords.length > 0) {
                console.log(`Chain Grep: Restored ${definedWords.length} global highlight words`);
            }
        }

        if (state.localHighlights) {
            let restoredGroupCount = 0;
            const isMap =
                state.localHighlights instanceof Map ||
                (typeof state.localHighlights[Symbol.iterator] === "function" &&
                    typeof state.localHighlights.delete === "function");

            const localHighlightsMap = isMap ? state.localHighlights : new Map(state.localHighlights);

            for (const [key, stateObj] of localHighlightsMap) {
                const hasActiveHighlights =
                    Array.isArray(stateObj.words) &&
                    stateObj.words.some(
                        (word: string | undefined) => word !== undefined && word !== null && word.trim() !== ""
                    );

                if (hasActiveHighlights) {
                    const localState = createLocalHighlightState(key);
                    localState.words = stateObj.words;
                    localState.next = stateObj.next;
                    restoredGroupCount++;
                } else {
                    if (isMap) {
                        localHighlightsMap.delete(key);
                    } else if (Array.isArray(state.localHighlights)) {
                        state.localHighlights = state.localHighlights.filter(([k]: [string, any]) => k !== key);
                    }
                    if (localHighlightMap.has(key)) {
                        localHighlightMap.delete(key);
                    }
                    console.log(`Chain Grep: Removed empty local highlight group for ${key}`);
                }
            }
            console.log(`Chain Grep: Restored local highlights for ${restoredGroupCount} groups`);

            removeEmptyHighlightGroups();
        }

        if (state.globalHighlightColorMap) {
            globalHighlightColorMap = new Map(state.globalHighlightColorMap);
        }

        if (state.localHighlightColorMaps) {
            for (const [key, mapData] of state.localHighlightColorMaps) {
                if (localHighlightMap.has(key)) {
                    localHighlightColorMaps.set(key, new Map(mapData));
                }
            }
        }

        if (state.globalColorIndexes) {
            globalColorIndexes = state.globalColorIndexes;
        }

        if (state.localColorIndexMaps) {
            for (const [key, indexes] of state.localColorIndexMaps) {
                if (localHighlightMap.has(key)) {
                    localColorIndexMaps.set(key, indexes);
                }
            }
        }

        if (state.globalColorQueue) {
            if (!globalColorQueue) {
                globalColorQueue = new ColorQueue(highlightDecorations.length, areRandomColorsEnabled());
            }
            globalColorQueue.setIndexes(state.globalColorQueue);
        }

        if (state.localColorQueues) {
            for (const [key, indexes] of state.localColorQueues) {
                if (localHighlightMap.has(key)) {
                    const queue = localColorQueues.get(key) || new ColorQueue(indexes.length, areRandomColorsEnabled());
                    queue.setIndexes(indexes);
                    localColorQueues.set(key, queue);
                }
            }
        }

        console.log("Chain Grep: Successfully restored highlight state");
    } catch (error) {
        console.error("Chain Grep: Error restoring highlight state", error);
    }
}

export function resetAllHighlightDecorations(chainGrepMap: Map<string, any>, clearHighlights: boolean = false): void {
    console.log(`Chain Grep: Resetting all highlight decorations (clearHighlights: ${clearHighlights})`);

    try {
        highlightDecorations.forEach((decoration) => decoration.dispose());

        for (const [groupKey, state] of localHighlightMap.entries()) {
            state.decorations.forEach((decoration) => decoration.dispose());
        }

        if (clearHighlights) {
            const savedGlobalWords = [...globalHighlightWords];
            const savedLocalStates = new Map<string, { words: (string | undefined)[]; next: number }>();

            for (const [groupKey, state] of localHighlightMap.entries()) {
                savedLocalStates.set(groupKey, {
                    words: [...state.words],
                    next: state.next,
                });
            }

            globalHighlightWords = [];
            globalHighlightColorMap.clear();

            localHighlightMap.clear();
            localHighlightColorMaps.clear();
            localColorIndexMaps.clear();
            localColorQueues.clear();

            initHighlightDecorations();

            if (!clearHighlights) {
                for (let i = 0; i < Math.min(savedGlobalWords.length, globalHighlightWords.length); i++) {
                    globalHighlightWords[i] = savedGlobalWords[i];

                    const word = savedGlobalWords[i];
                    if (word !== undefined) {
                        globalHighlightColorMap.set(word, i);
                    }
                }

                for (const [groupKey, savedState] of savedLocalStates.entries()) {
                    // Tworzymy nowy stan dla każdej zapisanej grupy
                    const state = createLocalHighlightState(groupKey);
                    for (let i = 0; i < Math.min(savedState.words.length, state.words.length); i++) {
                        state.words[i] = savedState.words[i];
                    }
                    state.next = savedState.next;

                    if (!localHighlightColorMaps.has(groupKey)) {
                        localHighlightColorMaps.set(groupKey, new Map<string, number>());
                    }
                    for (let i = 0; i < savedState.words.length; i++) {
                        const word = savedState.words[i];
                        if (word) {
                            localHighlightColorMaps.get(groupKey)!.set(word, i);
                        }
                    }
                }
            }
        } else {
            initHighlightDecorations();

            for (const [groupKey, state] of localHighlightMap.entries()) {
                const newDecs = createHighlightDecorationsFromColours(groupKey);
                state.decorations = newDecs;
            }
        }

        applyHighlightsToOpenEditors(chainGrepMap);
        console.log("Chain Grep: Successfully reset and reapplied all highlight decorations");
    } catch (error) {
        console.error("Chain Grep: Error resetting highlight decorations", error);
    }
}

function removeEmptyHighlightGroups(): number {
    let removedCount = 0;
    const keysToRemove: string[] = [];

    for (const [groupKey, state] of localHighlightMap.entries()) {
        if (!state.words.some((word) => word !== undefined)) {
            keysToRemove.push(groupKey);
        }
    }

    for (const key of keysToRemove) {
        localHighlightMap.delete(key);

        if (localHighlightColorMaps.has(key)) {
            localHighlightColorMaps.delete(key);
        }

        if (localColorQueues.has(key)) {
            localColorQueues.delete(key);
        }

        if (localColorIndexMaps.has(key)) {
            localColorIndexMaps.delete(key);
        }

        removedCount++;
        console.log(`Chain Grep: Removed empty highlight group for key: ${key}`);
    }

    if (removedCount > 0) {
        console.log(`Chain Grep: Removed ${removedCount} empty highlight groups`);
    }

    return removedCount;
}
