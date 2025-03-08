const vscode = require('vscode');
const os = require('os');
const path = require('path');
const fs = require('fs');

// 获取 Cursor 相关路径
function getCursorPaths() {
    const platform = os.platform();
    let basePath, packagePath, mainPath;

    switch (platform) {
        case 'darwin':
            basePath = '/Applications/Cursor.app/Contents/Resources/app';
            break;
        case 'win32':
            basePath = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Cursor', 'resources', 'app');
            break;
        case 'linux':
            // 检查多个可能的路径
            const linuxPaths = [
                '/opt/Cursor/resources/app',
                '/usr/share/cursor/resources/app',
                '/usr/local/bin/cursor'
            ];
            basePath = linuxPaths.find(p => fs.existsSync(p));
            if (!basePath) {
                throw new Error('在 Linux 系统上未找到 Cursor 安装路径');
            }
            // Linux 下只返回 mainPath，不返回 packagePath
            mainPath = path.join(basePath, 'out', 'main.js');
            return { mainPath }; // 只返回 mainPath
            break;
        default:
            throw new Error(`不支持的操作系统: ${platform}`);
    }

    packagePath = path.join(basePath, 'package.json');
    mainPath = path.join(basePath, 'out', 'main.js');

    return { packagePath, mainPath };
}

// 检查系统要求
function checkSystemRequirements(packagePath, mainPath) {
    // 对于 Linux，只检查 mainPath
    const platform = os.platform();
    const files = platform === 'linux' ? [mainPath] : [packagePath, mainPath];
    
    for (const file of files) {
        if (!fs.existsSync(file)) {
            throw new Error(`文件不存在: ${file}`);
        }
        try {
            fs.accessSync(file, fs.constants.W_OK);
        } catch {
            throw new Error(`没有文件写入权限: ${file}`);
        }
    }
    return true;
}

// 版本检查
function checkVersion(version, minVersion = '', maxVersion = '') {
    const versionPattern = /^\d+\.\d+\.\d+$/;
    if (!versionPattern.test(version)) {
        throw new Error(`无效的版本号格式: ${version}`);
    }

    const parseVersion = (ver) => ver.split('.').map(Number);
    const compare = (v1, v2) => {
        const [a1, b1, c1] = parseVersion(v1);
        const [a2, b2, c2] = parseVersion(v2);
        if (a1 !== a2) return a1 - a2;
        if (b1 !== b2) return b1 - b2;
        return c1 - c2;
    };

    if (minVersion && compare(version, minVersion) < 0) {
        throw new Error(`版本号 ${version} 小于最小要求 ${minVersion}`);
    }

    if (maxVersion && compare(version, maxVersion) > 0) {
        throw new Error(`版本号 ${version} 大于最大要求 ${maxVersion}`);
    }

    return true;
}

// 修改 main.js 文件
async function modifyMainJs(mainPath) {
    try {
        let content = fs.readFileSync(mainPath, 'utf8');
        
        // 使用新的备份功能
        await backupFile(mainPath);

        // 执行替换
        const patterns = {
            'async getMachineId\\(\\)\\{return [^??]+\\?\\?([^}]+)\\}': 
                (match, p1) => `async getMachineId(){return ${p1}}`,
            'async getMacMachineId\\(\\)\\{return [^??]+\\?\\?([^}]+)\\}': 
                (match, p1) => `async getMacMachineId(){return ${p1}}`
        };

        let modified = false;
        for (const [pattern, replacement] of Object.entries(patterns)) {
            const newContent = content.replace(new RegExp(pattern), replacement);
            if (newContent !== content) {
                content = newContent;
                modified = true;
            }
        }

        if (!modified) {
            throw new Error('未找到需要修改的代码，可能文件已被修改或版本不兼容');
        }

        fs.writeFileSync(mainPath, content);
        return true;
    } catch (error) {
        throw new Error(`修改文件时发生错误: ${error.message}`);
    }
}

// 主函数
async function patchCursorGetMachineId() {
    try {
        // 获取用户确认
        const userConfirm = await confirmPatch();
        if (userConfirm !== '继续') {
            vscode.window.showInformationMessage('操作已取消');
            return;
        }

        // 获取配置
        const config = getConfig();
        const customPath = config.get('mainJsPath');
        
        // 获取路径
        const platform = os.platform();
        let packagePath, mainPath;
        
        if (customPath) {
            mainPath = customPath;
            // 只在非 Linux 平台上设置 packagePath
            if (platform !== 'linux') {
                packagePath = path.join(path.dirname(customPath), '..', 'package.json');
            }
        } else {
            const paths = getCursorPaths();
            mainPath = paths.mainPath;
            packagePath = paths.packagePath; // Linux 下这个值是 undefined
        }

        // 显示进度
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "正在应用补丁...",
            cancellable: false
        }, async (progress) => {
            progress.report({ increment: 0, message: "检查系统要求..." });
            await checkSystemRequirements(packagePath, mainPath);

            // 只在非 Linux 平台上检查版本
            if (platform !== 'linux') {
                progress.report({ increment: 30, message: "检查版本兼容性..." });
                const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
                const version = packageJson.version;
                await checkVersion(version, '0.45.0');
            } else {
                progress.report({ increment: 30, message: "跳过版本检查（Linux 平台）..." });
            }

            progress.report({ increment: 30, message: "修改文件..." });
            await modifyMainJs(mainPath);

            progress.report({ increment: 40, message: "完成..." });
        });

        // 成功提示
        const result = await vscode.window.showInformationMessage(
            'Cursor 补丁应用成功！需要重启 Cursor 才能生效。',
            '立即重启',
            '稍后重启'
        );

        if (result === '立即重启') {
            vscode.commands.executeCommand('workbench.action.reloadWindow');
        }

        // 显示项目信息
        vscode.window.showInformationMessage('github: https://github.com/chengazhen/cursor-patch');
    } catch (error) {
        // 错误处理增强
        const errorMessage = `错误: ${error.message}`;
        console.error(errorMessage);
        
        const action = await vscode.window.showErrorMessage(
            errorMessage,
            '查看详情',
            '重试',
            '取消'
        );

        if (action === '重试') {
            return patchCursorGetMachineId();
        } else if (action === '查看详情') {
            // 创建输出通道显示详细错误信息
            const channel = vscode.window.createOutputChannel('Cursor Patch');
            channel.appendLine('详细错误信息:');
            channel.appendLine(error.stack || error.message);
            channel.show();
        }
    }
}

// 添加配置支持
function getConfig() {
    return vscode.workspace.getConfiguration('cursor-patch');
}

// 添加备份功能
async function backupFile(filePath) {
    try {
        await fs.writeFileSync(`${filePath}.backup`, fs.readFileSync(filePath));
        return true;
    } catch (error) {
        throw new Error(`备份失败: ${error.message}`);
    }
}

// 添加更详细的用户交互
async function confirmPatch() {
    return vscode.window.showWarningMessage(
        '即将修补 Cursor 的机器码获取逻辑',
        {
            modal: true,
            detail: '此操作将修改 main.js 文件，建议先备份\n确认继续吗？'
        },
        '继续',
        '取消'
    );
}

// 注册命令
function activate(context) {
    // 注册主命令
    let patchCommand = vscode.commands.registerCommand('cursor-patch.patch', async () => {
        await patchCursorGetMachineId();
    });

    // 注册恢复备份命令
    let restoreCommand = vscode.commands.registerCommand('cursor-patch.restore', async () => {
        try {
            const { mainPath } = getCursorPaths();
            const backupPath = `${mainPath}.backup`;
            
            if (!fs.existsSync(backupPath)) {
                throw new Error('未找到备份文件');
            }

            await fs.copyFileSync(backupPath, mainPath);
            vscode.window.showInformationMessage('已恢复到备份版本');
        } catch (error) {
            vscode.window.showErrorMessage(`恢复失败: ${error.message}`);
        }
    });

    context.subscriptions.push(patchCommand, restoreCommand);
}

module.exports = {
    activate
};
