import * as vscode from "vscode";

const DEFAULT_COLOURS =
    "#89CFF0:black, #FF6961:black, #77DD77:black, #C3A8FF:black, #FDFD96:black, #A0E7E5:black, #FFB7CE:black, #CCFF90:black, #B19CD9:black, #FF82A9:black, #A8BFFF:black, #FFDAB9:black, #A8D0FF:black, #FFE680:black, #A8E0FF:black, #FFCBA4:black, #E6A8D7:black, #FFCCD2:black, #ACE1AF:black, #FF99FF:black";

function getConfig<T>(key: string, defaultValue?: T): T {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<T>(key, defaultValue as T);
}

export function loadConfiguredPalette(): string {
    const userPalette = getConfig<string>("colours", "");
    return userPalette?.trim() ? userPalette : DEFAULT_COLOURS;
}

export function areRandomColorsEnabled(): boolean {
    return getConfig<boolean>("randomColors", false);
}

export function isDetailedChainDocEnabled(): boolean {
    return getConfig<boolean>("detailedChainDoc", true);
}

export function getMaxBaseNameLength(): number {
    return getConfig<number>("maxBaseNameLength", 70);
}

export function getMaxChainDescriptorLength(): number {
    return getConfig<number>("maxChainDescriptorLength", 30);
}

export function getCleanupInterval(): number {
    const minutes = getConfig<number>("cleanupInterval", 5);
    return minutes * 60 * 1000;
}

export function areScrollbarIndicatorsEnabled(): boolean {
    return getConfig<boolean>("showScrollbarIndicators", true);
}

export function isCleanupLoggingEnabled(): boolean {
    return getConfig<boolean>("cleanupLogging", false);
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

let statusBarItem: vscode.StatusBarItem | undefined;

export function getStatusBar(): vscode.StatusBarItem {
    if (!statusBarItem) {
        statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        statusBarItem.name = "Chain Grep";
    }
    return statusBarItem;
}

export function showStatusMessage(
    message: string,
    timeout: number = 5000
): void {
    const statusBar = getStatusBar();
    statusBar.text = `$(sync) ${message}`;
    statusBar.show();

    setTimeout(() => {
        if (statusBar.text === `$(sync) ${message}`) {
            statusBar.hide();
        }
    }, timeout);
}

export function getBookmarkColor(): string {
    const config = vscode.workspace.getConfiguration("chainGrep");
    return config.get<string>("bookmarkColor") || "#3794FF";
}
