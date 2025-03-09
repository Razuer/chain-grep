import * as vscode from "vscode";
import { toStat } from "../utils/utils";

export class ChainGrepFSProvider implements vscode.FileSystemProvider {
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
    private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;

    private initialized = false;
    private pendingRequests: vscode.Uri[] = [];

    constructor(private chainGrepContents: Map<string, string>, private chainGrepMap: Map<string, any>) {
        this._onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        this.onDidChangeFile = this._onDidChangeFile.event;
    }

    public markInitialized(): void {
        if (this.initialized) {
            return;
        }

        this.initialized = true;

        if (this.pendingRequests.length > 0) {
            this._onDidChangeFile.fire(
                this.pendingRequests.map((uri) => ({
                    type: vscode.FileChangeType.Created,
                    uri,
                }))
            );
            this.pendingRequests = [];
        }
    }

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const content = this.chainGrepContents.get(uri.toString());

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
        const uriString = uri.toString();
        const content = this.chainGrepContents.get(uriString);

        if (!content && this.chainGrepMap.has(uriString)) {
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Restoring Chain Grep results...",
                    cancellable: false,
                },
                async () => {
                    this._onDidChangeFile.fire([
                        {
                            type: vscode.FileChangeType.Changed,
                            uri,
                        },
                    ]);
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
        this.chainGrepContents.set(uri.toString(), Buffer.from(content).toString("utf8"));
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }

    delete(uri: vscode.Uri, _options: { recursive: boolean }): void {
        const uriString = uri.toString();
        this.chainGrepContents.delete(uriString);
        this.chainGrepMap.delete(uriString);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {}

    public notifyFileChanged(uri: vscode.Uri): void {
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }
}
