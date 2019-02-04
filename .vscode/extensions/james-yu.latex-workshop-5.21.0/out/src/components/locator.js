"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const synctexjs = require("./synctex");
class Locator {
    constructor(extension) {
        this.extension = extension;
    }
    parseSyncTeXForward(result) {
        const record = {};
        let started = false;
        for (const line of result.split('\n')) {
            if (line.indexOf('SyncTeX result begin') > -1) {
                started = true;
                continue;
            }
            if (line.indexOf('SyncTeX result end') > -1) {
                break;
            }
            if (!started) {
                continue;
            }
            const pos = line.indexOf(':');
            if (pos < 0) {
                continue;
            }
            const key = line.substr(0, pos).toLowerCase();
            if (key !== 'page' && key !== 'x' && key !== 'y') {
                continue;
            }
            const value = line.substr(pos + 1);
            record[key] = Number(value);
        }
        if (record.page !== undefined && record.x !== undefined && record.y !== undefined) {
            return { page: record.page, x: record.x, y: record.y, };
        }
        else {
            throw (new Error('parse error when parsing the result of synctex forward.'));
        }
    }
    parseSyncTeXBackward(result) {
        const record = {};
        let started = false;
        for (const line of result.split('\n')) {
            if (line.indexOf('SyncTeX result begin') > -1) {
                started = true;
                continue;
            }
            if (line.indexOf('SyncTeX result end') > -1) {
                break;
            }
            if (!started) {
                continue;
            }
            const pos = line.indexOf(':');
            if (pos < 0) {
                continue;
            }
            const key = line.substr(0, pos).toLowerCase();
            if (key !== 'input' && key !== 'line' && key !== 'column') {
                continue;
            }
            const value = line.substr(pos + 1);
            if (key === 'line' || key === 'column') {
                record[key] = Number(value);
                continue;
            }
            record[key] = value;
        }
        if (record.input !== undefined && record.line !== undefined && record.column !== undefined) {
            return { input: record.input, line: record.line, column: record.column };
        }
        else {
            throw (new Error('parse error when parsing the result of synctex backward.'));
        }
    }
    syncTeX(args, forcedViewer = 'auto') {
        let line;
        let filePath;
        let character = 0;
        if (!vscode.window.activeTextEditor) {
            return;
        }
        if (args === undefined) {
            filePath = vscode.window.activeTextEditor.document.uri.fsPath;
            if (!this.extension.manager.hasTexId(vscode.window.activeTextEditor.document.languageId)) {
                this.extension.logger.addLogMessage(`${filePath} is not a valid LaTeX file.`);
                return;
            }
            const position = vscode.window.activeTextEditor.selection.active;
            if (!position) {
                this.extension.logger.addLogMessage(`Cannot get cursor position: ${position}`);
                return;
            }
            line = position.line + 1;
            character = position.character;
        }
        else {
            line = args.line;
            filePath = args.filePath;
        }
        const configuration = vscode.workspace.getConfiguration('latex-workshop');
        const pdfFile = this.extension.manager.tex2pdf(this.extension.manager.rootFile);
        if (vscode.window.activeTextEditor.document.lineCount === line &&
            vscode.window.activeTextEditor.document.lineAt(line - 1).text === '') {
            line -= 1;
        }
        if (forcedViewer === 'external' || (forcedViewer === 'auto' && configuration.get('view.pdf.viewer') === 'external')) {
            this.syncTeXExternal(line, pdfFile, this.extension.manager.rootFile);
            return;
        }
        const useSyncTexJs = configuration.get('synctex.synctexjs.enabled');
        if (useSyncTexJs) {
            try {
                this.extension.viewer.syncTeX(pdfFile, synctexjs.syncTexJsForward(line, filePath, pdfFile));
            }
            catch (e) {
                if (e instanceof Error) {
                    this.extension.logger.addLogMessage(e.message);
                }
                console.log(e);
                throw (e);
            }
        }
        else {
            this.invokeSyncTeXCommandForward(line, character, filePath, pdfFile).then((record) => {
                this.extension.viewer.syncTeX(pdfFile, record);
            });
        }
    }
    invokeSyncTeXCommandForward(line, col, filePath, pdfFile) {
        const configuration = vscode.workspace.getConfiguration('latex-workshop');
        const docker = configuration.get('docker.enabled');
        const args = ['view', '-i', `${line}:${col + 1}:${docker ? path.basename(filePath) : filePath}`, '-o', docker ? path.basename(pdfFile) : pdfFile];
        this.extension.logger.addLogMessage(`Executing synctex with args ${args}`);
        let command = configuration.get('synctex.path');
        if (docker) {
            if (process.platform === 'win32') {
                command = path.resolve(this.extension.extensionRoot, './scripts/synctex.bat');
            }
            else {
                command = path.resolve(this.extension.extensionRoot, './scripts/synctex');
                fs.chmodSync(command, 0o755);
            }
        }
        this.extension.manager.setEnvVar();
        const proc = cp.spawn(command, args, { cwd: path.dirname(pdfFile) });
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        let stdout = '';
        proc.stdout.on('data', newStdout => {
            stdout += newStdout;
        });
        let stderr = '';
        proc.stderr.on('data', newStderr => {
            stderr += newStderr;
        });
        proc.on('error', err => {
            this.extension.logger.addLogMessage(`Cannot synctex: ${err.message}, ${stderr}`);
        });
        return new Promise((resolve) => {
            proc.on('exit', exitCode => {
                if (exitCode !== 0) {
                    this.extension.logger.addLogMessage(`Cannot synctex, code: ${exitCode}, ${stderr}`);
                }
                else {
                    resolve(this.parseSyncTeXForward(stdout));
                }
            });
        });
    }
    syncTeXOnRef(args) {
        const configuration = vscode.workspace.getConfiguration('latex-workshop');
        const viewer = configuration.get('view.pdf.ref.viewer');
        args.line += 1;
        if (viewer) {
            this.syncTeX(args, viewer);
        }
        else {
            this.syncTeX(args);
        }
    }
    invokeSyncTeXCommandBackward(page, x, y, pdfPath) {
        const configuration = vscode.workspace.getConfiguration('latex-workshop');
        const docker = configuration.get('docker.enabled');
        const args = ['edit', '-o', `${page}:${x}:${y}:${docker ? path.basename(pdfPath) : pdfPath}`];
        this.extension.logger.addLogMessage(`Executing synctex with args ${args}`);
        let command = configuration.get('synctex.path');
        if (docker) {
            if (process.platform === 'win32') {
                command = path.resolve(this.extension.extensionRoot, './scripts/synctex.bat');
            }
            else {
                command = path.resolve(this.extension.extensionRoot, './scripts/synctex');
                fs.chmodSync(command, 0o755);
            }
        }
        this.extension.manager.setEnvVar();
        const proc = cp.spawn(command, args, { cwd: path.dirname(pdfPath) });
        proc.stdout.setEncoding('utf8');
        proc.stderr.setEncoding('utf8');
        let stdout = '';
        proc.stdout.on('data', newStdout => {
            stdout += newStdout;
        });
        let stderr = '';
        proc.stderr.on('data', newStderr => {
            stderr += newStderr;
        });
        proc.on('error', err => {
            this.extension.logger.addLogMessage(`Cannot reverse synctex: ${err.message}, ${stderr}`);
        });
        return new Promise((resolve) => {
            proc.on('exit', exitCode => {
                if (exitCode !== 0) {
                    this.extension.logger.addLogMessage(`Cannot reverse synctex, code: ${exitCode}, ${stderr}`);
                }
                else {
                    const record = this.parseSyncTeXBackward(stdout);
                    resolve(record);
                }
            });
        });
    }
    locate(data, pdfPath) {
        return __awaiter(this, void 0, void 0, function* () {
            const configuration = vscode.workspace.getConfiguration('latex-workshop');
            const docker = configuration.get('docker.enabled');
            const useSyncTexJs = configuration.get('synctex.synctexjs.enabled');
            let record;
            if (useSyncTexJs) {
                try {
                    record = synctexjs.syncTexJsBackward(Number(data.page), data.pos[0], data.pos[1], pdfPath);
                }
                catch (e) {
                    if (e instanceof Error) {
                        this.extension.logger.addLogMessage(e.message);
                    }
                    console.log(e);
                    throw (e);
                }
            }
            else {
                record = yield this.invokeSyncTeXCommandBackward(data.page, data.pos[0], data.pos[1], pdfPath);
            }
            // kpathsea/SyncTeX follow symlinks.
            // see http://tex.stackexchange.com/questions/25578/why-is-synctex-in-tl-2011-so-fussy-about-filenames.
            // We compare the return of symlink with the files list in the texFileTree and try to pickup the correct one.
            for (const ed in this.extension.manager.texFileTree) {
                if (fs.realpathSync(record.input) === fs.realpathSync(ed)) {
                    record.input = ed;
                    break;
                }
            }
            const row = record.line - 1;
            const col = record.column < 0 ? 0 : record.column;
            const pos = new vscode.Position(row, col);
            let filePath = path.resolve(record.input.replace(/(\r\n|\n|\r)/gm, ''));
            if (docker && process.platform === 'win32') {
                filePath = path.resolve(path.dirname(pdfPath), record.input);
            }
            this.extension.logger.addLogMessage(`SyncTeX to file ${filePath}`);
            vscode.workspace.openTextDocument(filePath).then((doc) => {
                let viewColumn = undefined;
                for (let index = 0; index < vscode.window.visibleTextEditors.length; index++) {
                    viewColumn = vscode.window.visibleTextEditors[index].viewColumn;
                    if (viewColumn !== undefined) {
                        break;
                    }
                }
                vscode.window.showTextDocument(doc, viewColumn).then((editor) => {
                    editor.selection = new vscode.Selection(pos, pos);
                    vscode.commands.executeCommand('revealLine', { lineNumber: row, at: 'center' });
                    this.animateToNotify(editor, pos);
                });
            });
        });
    }
    animateToNotify(editor, position) {
        const decoConfig = {
            borderWidth: '1px',
            borderStyle: 'solid',
            light: {
                borderColor: 'red'
            },
            dark: {
                borderColor: 'white'
            }
        };
        const range = new vscode.Range(position.line, 0, position.line, 65535);
        const deco = vscode.window.createTextEditorDecorationType(decoConfig);
        editor.setDecorations(deco, [range]);
        setTimeout(() => { deco.dispose(); }, 500);
    }
    syncTeXExternal(line, pdfFile, rootFile) {
        if (!vscode.window.activeTextEditor) {
            return;
        }
        const texFile = vscode.window.activeTextEditor.document.uri.fsPath;
        const configuration = vscode.workspace.getConfiguration('latex-workshop');
        const command = JSON.parse(JSON.stringify(configuration.get('view.pdf.external.synctex')));
        if (command.args) {
            command.args = command.args.map(arg => arg.replace('%DOC%', rootFile.replace(/\.tex$/, '').split(path.sep).join('/'))
                .replace('%DOCFILE%', path.basename(rootFile, '.tex').split(path.sep).join('/'))
                .replace('%PDF%', pdfFile)
                .replace('%LINE%', line.toString())
                .replace('%TEX%', texFile));
        }
        this.extension.manager.setEnvVar();
        cp.spawn(command.command, command.args);
        this.extension.logger.addLogMessage(`Open external viewer for syncTeX from ${pdfFile}`);
    }
}
exports.Locator = Locator;
//# sourceMappingURL=locator.js.map