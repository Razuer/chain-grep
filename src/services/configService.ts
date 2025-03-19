import * as vscode from "vscode";

const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

export function loadConfiguredPalette(): string {
    const config = vscode.workspace.getConfiguration("chainGrep");
    const userPalette = config.get<string>("colours");
    if (userPalette && userPalette.trim()) {
        return userPalette;
    } else {
        return DEFAULT_COLOURS;
    }
}

export function areRandomColorsEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("randomColors") === true;
}

export function isDetailedChainDocEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("detailedChainDoc") === true;
}

export function isCleanupLoggingEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("cleanupLogging") === true;
}

export function getMaxBaseNameLength(): number {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<number>("maxBaseNameLength") ?? 70;
}

export function getMaxChainDescriptorLength(): number {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<number>("maxChainDescriptorLength") ?? 30;
}

export function getCleanupInterval(): number {
    const config = vscode.workspace.getConfiguration("chainGrep");
    const minutes = config.get<number>("cleanupInterval") ?? 5;
    return minutes * 60 * 1000;
}

export function areScrollbarIndicatorsEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<boolean>("showScrollbarIndicators") !== false; // Default to true if not specified
}

export function isRegexValid(str: string): boolean {
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

export function getBookmarkColor(): string {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<string>("bookmarkColor") || "#3794FF";
}
