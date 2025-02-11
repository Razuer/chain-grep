import * as assert from "assert";
import * as vscode from "vscode";

suite("Chain Grep Extension Test Suite", () => {
    test("Extension should be activated", async () => {
        const extension = vscode.extensions.getExtension("rejzerek.chain-grep");

        assert.ok(extension, "Extension not found");
        if (extension) {
            await extension.activate();
            assert.strictEqual(
                extension.isActive,
                true,
                "Extension is not active after activation"
            );
        }
    });

    test("Commands should be registered", async () => {
        const commands = await vscode.commands.getCommands(true);
        const expectedCommands = [
            "chainGrep.findText",
            "chainGrep.findRegex",
            "chainGrep.refresh",
        ];
        for (const command of expectedCommands) {
            assert.ok(
                commands.includes(command),
                `Expected command "${command}" is not registered`
            );
        }
    });
});
