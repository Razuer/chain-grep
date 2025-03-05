import * as vscode from "vscode";
import { toStat } from "../utils/utils";

export class ChainGrepFSProvider implements vscode.FileSystemProvider {
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]>;
    private _onDidChangeFile: vscode.EventEmitter<vscode.FileChangeEvent[]>;

    private initialized = false;
    private pendingRequests: vscode.Uri[] = [];

    // These maps will be injected from the extension
    private chainGrepContents: Map<string, string>;
    private chainGrepMap: Map<string, any>;

    constructor(chainGrepContents: Map<string, string>, chainGrepMap: Map<string, any>) {
        this._onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
        this.onDidChangeFile = this._onDidChangeFile.event;
        this.chainGrepContents = chainGrepContents;
        this.chainGrepMap = chainGrepMap;
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
        const content = this.chainGrepContents.get(uri.toString());

        if (!content && this.chainGrepMap.has(uri.toString())) {
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: "Restoring Chain Grep results...",
                    cancellable: false,
                },
                async () => {
                    const chainInfo = this.chainGrepMap.get(uri.toString())!;

                    // We'll need to handle this in extension.ts since we need searchService functions
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
        this.chainGrepContents.delete(uri.toString());
        this.chainGrepMap.delete(uri.toString());
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    rename(_oldUri: vscode.Uri, _newUri: vscode.Uri, _options: { overwrite: boolean }): void {}

    public notifyFileChanged(uri: vscode.Uri): void {
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    }
}
